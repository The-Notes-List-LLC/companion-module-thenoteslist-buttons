/**
 * Read-only ETC Eos reader (#907 cue cursor), sliding-window edition.
 *
 * Opens its own OSC TCP connection to the desk and follows the live cue via
 * implicit output (`/eos/out/active/cue/<list>/<num>`). It reads the WHOLE list
 * too, but gently: a low-priority walk of every index at one request per
 * 30 ms (a 1700-cue show takes under a minute and costs the desk nothing
 * noticeable), always yielding to the high-priority window reads. When the live
 * cue changes it asks for THAT cue by number
 * (`/eos/get/cue/<list>/<num>`), learns the cue's index from the reply address
 * (`/eos/out/get/cue/<list>/<num>/<part>/list/<index>/<count>`), then fetches a
 * small window of neighbours by index, spaced out. It subscribes on connect
 * (the active-cue output rides the subscription), so edits on the desk arrive
 * as `/eos/out/notify/cue/<list>/...` and only the named cues are re-fetched
 * (plus a re-count for inserts/deletes). The wheel/channel stream that
 * subscribe also brings is simply ignored; the earlier lag came from the burst
 * of 1700 requests, not from being subscribed.
 *
 * Never sends a state-changing command: no /eos/key, /eos/cmd, /eos/cue.
 * `/eos/reset` only clears this client's output state so the desk resends the
 * current active/pending cue once on connect.
 */
import { OscTcpSocket, type OscMessage, type OscPacket, type OscSendArg } from './osc-tcp.js'

export interface EosCue {
	number: string
	label: string
	index: number
	/** 0 = the base cue; >0 = a part of that cue (never a cursor target, but it occupies an index). */
	part: number
}

export interface EosReaderEvents {
	onStatus: (connected: boolean, message: string) => void
	onLive: (cueNumber: string) => void
	/** The cache changed: cues known so far, sorted by index. */
	onCache: (cues: EosCue[], count: number) => void
	log: (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void
}

const PORT_OSC10 = 3032
const PORT_SLIP = 3037
const WINDOW = 8 // cues either side of the live cue kept warm
const REQUEST_GAP_MS = 22 // one request per 22 ms (~45/s); still no burst for the desk
const RECONNECT_MIN_MS = 5000
const RECONNECT_MAX_MS = 60000 // back off while the desk stays unreachable
const CONNECT_TIMEOUT_MS = 5000 // give up on a connect attempt instead of waiting for the OS timeout
const MAX_CUES = 100000 // sanity cap on the count the desk reports

export class EosReader {
	private socket: OscTcpSocket | null = null
	private connected = false
	private closed = false
	private reconnectTimer: NodeJS.Timeout | null = null
	private reconnectDelay = RECONNECT_MIN_MS
	private connectTimer: NodeJS.Timeout | null = null
	/**
	 * One error is logged per spell of trouble; repeats while retrying are not. Cleared by
	 * the first packet that decodes, not by the TCP connect: a desk that accepts the
	 * connection but speaks the other framing would otherwise warn on every retry.
	 */
	private errorLogged = false
	/** This connection has delivered a decodable packet (the desk speaks our framing). */
	private gotPacket = false
	/** Undecodable packets are logged once per connection. */
	private decodeErrorLogged = false
	private count = 0
	private byIndex: Map<number, EosCue> = new Map()
	/** cache() result, rebuilt only after byIndex changes. */
	private sorted: EosCue[] | null = null
	private queue: string[] = [] // high priority: window around live / cursor
	private background: string[] = [] // low priority: the full-list walk
	private queued: Set<string> = new Set()
	private lastPublish = 0
	private publishTimer: NodeJS.Timeout | null = null
	private walkRetried = false
	private walkAnnounced = false
	private wantedByNumber: Set<string> = new Set()
	private announcedCount = false
	private drainTimer: NodeJS.Timeout | null = null

	constructor(
		private readonly host: string,
		private readonly useSlip: boolean,
		private readonly cueList: number,
		private readonly ev: EosReaderEvents,
	) {}

	start(): void {
		this.closed = false
		this.connect()
	}

	stop(): void {
		this.closed = true
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		if (this.drainTimer) clearTimeout(this.drainTimer)
		if (this.publishTimer) clearTimeout(this.publishTimer)
		if (this.connectTimer) clearTimeout(this.connectTimer)
		// Destroy, not end(): a pending connect or a half-open socket is released now,
		// not when the OS or the desk gets round to it.
		const socket = this.socket
		this.socket = null
		socket?.destroy()
		this.connected = false
	}

	/** Cues known so far, in sheet order. */
	cache(): EosCue[] {
		if (!this.sorted) this.sorted = [...this.byIndex.values()].sort((a, b) => a.index - b.index)
		return this.sorted
	}

	/** The cached record at a sheet index, if any. */
	cueAt(index: number): EosCue | undefined {
		return this.byIndex.get(index)
	}

	/** The cached base cue (part 0) with this number, if any. */
	findBase(number: string): EosCue | undefined {
		for (const c of this.byIndex.values()) if (c.number === number && c.part === 0) return c
		return undefined
	}

	/** byIndex changed: drop the sorted copy. */
	private touch(): void {
		this.sorted = null
	}

	/** Make sure indexes [from, to] are cached (fetches the missing ones, spaced out, ahead of the walk). */
	ensureRange(from: number, to: number): void {
		const lo = Math.max(0, from)
		const hi = this.count > 0 ? Math.min(this.count - 1, to) : to
		for (let i = lo; i <= hi; i++) {
			if (!this.byIndex.has(i)) this.enqueue(`/eos/get/cue/${this.cueList}/index/${i}`)
		}
	}

	/** Walk the entire list at low priority (after connect, or on demand after edits on the desk). */
	reloadList(): void {
		this.byIndex.clear()
		this.touch()
		this.background = []
		this.walkAnnounced = false
		this.walkRetried = false
		this.enqueue(`/eos/get/cue/${this.cueList}/count`)
	}

	private walkAll(): void {
		this.background = []
		for (let i = 0; i < this.count; i++) {
			const address = `/eos/get/cue/${this.cueList}/index/${i}`
			if (!this.byIndex.has(i) && !this.queued.has(address)) this.background.push(address)
		}
		if (!this.drainTimer) this.drain()
	}

	private connect(): void {
		const port = this.useSlip ? PORT_SLIP : PORT_OSC10
		// Events from a socket that stop() or a reconnect has replaced are ignored, so a
		// late 'close' from the old connection cannot mark the new one disconnected.
		const current = () => this.socket === socket && !this.closed
		const socket: OscTcpSocket = new OscTcpSocket(this.host, port, this.useSlip, {
			onConnect: () => {
				if (!current()) return
				if (this.connectTimer) clearTimeout(this.connectTimer)
				this.connectTimer = null
				this.connected = true
				this.gotPacket = false
				this.decodeErrorLogged = false
				this.byIndex.clear()
				this.touch()
				// A fresh walk: let the end-of-walk retry and report run again.
				this.walkAnnounced = false
				this.walkRetried = false
				this.announcedCount = false
				this.ev.onStatus(true, `Eos ${this.host}:${port}`)
				// Quiet while retrying after a reported problem; the first good packet ends that.
				this.ev.log(
					this.errorLogged ? 'debug' : 'info',
					`Eos: connected to ${this.host}:${port} (read-only), cue list ${this.cueList}`,
				)
				// Subscribe at once: the active/pending cue outputs ride the subscription.
				// The wheel/channel traffic it also brings is ignored; the earlier lag was
				// the request burst, which the spaced walk below no longer causes.
				this.enqueue('/eos/reset')
				this.enqueue('/eos/subscribe')
				this.enqueue(`/eos/get/cue/${this.cueList}/count`)
			},
			// Eos answers /eos/get/cue/... with BUNDLES (the cue record plus its fx /
			// links / actions messages). onPacket unpacks them; nested bundles too.
			onPacket: (packet) => {
				if (!current()) return
				if (!this.gotPacket) {
					// The desk answers in our framing: the connection is good, so back off from scratch.
					this.gotPacket = true
					this.errorLogged = false
					this.reconnectDelay = RECONNECT_MIN_MS
				}
				this.onPacket(packet)
			},
			onDecodeError: (err) => {
				if (!current() || this.decodeErrorLogged) return
				this.decodeErrorLogged = true
				this.ev.log(
					'warn',
					`Eos: could not decode a packet from the desk (${err.message}); further ones are skipped quietly`,
				)
			},
			onError: (err) => {
				if (!current()) return
				if (this.errorLogged) {
					this.ev.log('debug', `Eos: ${err?.message ?? String(err)}`)
				} else if (this.connected) {
					// e.g. the framing does not match the desk's OSC TCP format.
					this.errorLogged = true
					this.ev.log('warn', `Eos: ${err?.message ?? String(err)}`)
				} else {
					// e.g. a mistyped IP: ECONNREFUSED / EHOSTUNREACH. Once, not every retry.
					this.errorLogged = true
					this.ev.log('warn', `Eos: cannot reach ${this.host}:${port}: ${err?.message ?? String(err)}`)
				}
			},
			onClose: () => {
				if (!current()) return
				if (this.connectTimer) clearTimeout(this.connectTimer)
				this.connectTimer = null
				const was = this.connected
				this.connected = false
				// Nothing to send to: stop draining and forget pending requests; connect starts a new walk.
				if (this.drainTimer) clearTimeout(this.drainTimer)
				this.drainTimer = null
				this.queue = []
				this.background = []
				this.queued.clear()
				// Only a connection that worked is worth a warning when it ends.
				if (was) this.ev.log(this.gotPacket ? 'warn' : 'debug', 'Eos: connection closed')
				this.ev.onStatus(false, 'Eos: disconnected')
				this.scheduleReconnect()
			},
		})
		this.socket = socket
		// No answer within the timeout: destroy, and the close handler schedules the next try.
		this.connectTimer = setTimeout(() => {
			this.connectTimer = null
			if (current() && !this.connected) socket.destroy()
		}, CONNECT_TIMEOUT_MS)
	}

	private scheduleReconnect(): void {
		if (this.closed || this.reconnectTimer) return
		const delay = this.reconnectDelay
		this.reconnectDelay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay * 2)
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			if (!this.closed) this.connect()
		}, delay)
	}

	/** Requests go out one at a time, spaced, and never twice while pending. */
	private enqueue(address: string): void {
		if (this.queued.has(address)) return
		this.queued.add(address)
		this.queue.push(address)
		if (!this.drainTimer) this.drain()
	}

	private drain(): void {
		// Window reads first; the background walk only uses idle slots.
		let address = this.queue.shift()
		if (address !== undefined) this.queued.delete(address)
		else {
			do {
				address = this.background.shift()
			} while (address !== undefined && this.queued.has(address))
		}
		if (address === undefined) {
			this.drainTimer = null
			this.onQueueIdle()
			return
		}
		const args: OscSendArg[] = address === '/eos/subscribe' ? [{ type: 'i', value: 1 }] : []
		try {
			this.socket?.send(address, args)
		} catch (e) {
			this.ev.log('debug', `Eos send failed: ${(e as Error).message}`)
		}
		this.drainTimer = setTimeout(() => this.drain(), REQUEST_GAP_MS)
	}

	/** Nothing left to send: the walk is over. Retry unanswered indexes once, then report. */
	private onQueueIdle(): void {
		if (this.count === 0 || this.walkAnnounced) return
		const missing: number[] = []
		for (let i = 0; i < this.count; i++) if (!this.byIndex.has(i)) missing.push(i)
		if (missing.length > 0 && !this.walkRetried) {
			this.walkRetried = true
			this.ev.log('info', `Eos: ${missing.length} cue records unanswered; asking once more`)
			for (const i of missing) this.background.push(`/eos/get/cue/${this.cueList}/index/${i}`)
			this.drain()
			return
		}
		this.walkAnnounced = true
		const baseCues = [...this.byIndex.values()].filter((c) => c.part === 0).length
		const parts = this.byIndex.size - baseCues
		this.ev.log(
			'info',
			`Eos: cue list walk complete — ${baseCues} cues cached${parts ? ` (+${parts} parts)` : ''}${missing.length ? `, ${missing.length} unanswered` : ''}`,
		)
		this.ev.onCache(this.cache(), this.count)
	}

	private onPacket(packet: OscPacket): void {
		if (packet.oscType === 'bundle') for (const p of packet.elements ?? []) this.onPacket(p)
		else if (packet.address) this.onMessage(packet)
	}

	private onMessage(msg: OscMessage): void {
		const a = msg.address
		let m: RegExpMatchArray | null

		if ((m = a.match(/^\/eos\/out\/active\/cue\/([\d.]+)\/([\d.]+)$/))) {
			if (m[1] !== String(this.cueList)) return
			const num = m[2]
			this.ev.onLive(num)
			// Learn this cue's index (the reply carries it), then warm its neighbours.
			const known = this.findBase(num)
			if (known) this.ensureRange(known.index - WINDOW, known.index + WINDOW)
			else {
				this.wantedByNumber.add(num)
				this.enqueue(`/eos/get/cue/${this.cueList}/${num}`)
			}
			return
		}
		if ((m = a.match(/^\/eos\/out\/get\/cue\/([\d.]+)\/count$/))) {
			if (m[1] !== String(this.cueList)) return
			const n = Number(msg.args?.[0]?.value ?? 0)
			if (!Number.isInteger(n) || n < 0 || n > MAX_CUES) {
				this.ev.log('warn', `Eos: ignoring an implausible cue count (${String(msg.args?.[0]?.value)})`)
				return
			}
			const previous = this.count
			this.count = n
			if (previous === 0 && !this.announcedCount) {
				this.announcedCount = true
				this.ev.log(
					'info',
					`Eos: cue list ${this.cueList} has ${this.count} cues; walking the list in the background (${Math.round((this.count * REQUEST_GAP_MS) / 1000)} s)`,
				)
			} else if (previous !== this.count) {
				// Insert/delete: every index after the edit moved. Re-walk the whole list.
				this.ev.log('info', `Eos: cue count changed ${previous} → ${this.count}; re-reading the list`)
				this.announcedCount = false
				this.walkAnnounced = false
				this.byIndex.clear()
				this.touch()
			}
			this.ev.onCache(this.cache(), this.count)
			this.walkRetried = false
			this.walkAll()
			return
		}
		// /eos/out/get/cue/<list>/<cue>/<part>/list/<page>/<pages> — the trailing pair is
		// the ARGUMENT page counter, not the cue's position. The cue's sheet index is
		// args[0] (uint32); args[2] is the label. Part 0 = base cue.
		if ((m = a.match(/^\/eos\/out\/get\/cue\/([\d.]+)\/([\d.]+)\/(\d+)\/list\/(\d+)\/(\d+)$/))) {
			if (m[1] !== String(this.cueList)) return
			const index = Number(msg.args?.[0]?.value)
			// Eos answers some by-number lookups with index -1 (seen on a part of the live cue):
			// no place in the sheet, so it would sort first and count towards a complete walk.
			if (!Number.isInteger(index) || index < 0) return
			// Parts occupy their own index in the list; keep them so the walk can
			// complete and the cursor can step OVER them.
			const cue: EosCue = {
				number: m[2],
				label: typeof msg.args?.[2]?.value === 'string' ? msg.args[2].value : '',
				index,
				part: Number(m[3]),
			}
			const fresh = !this.byIndex.has(index)
			this.byIndex.set(index, cue)
			this.touch()
			if (fresh) {
				// A by-number reply (live cue) has no window yet: warm it.
				if (this.wantedByNumber.delete(cue.number)) this.ensureRange(index - WINDOW, index + WINDOW)
				// Publish progressively, at most every 500 ms, plus once when complete.
				const now = Date.now()
				const complete = this.count > 0 && this.byIndex.size >= this.count
				if (complete || now - this.lastPublish > 500) {
					this.lastPublish = now
					this.ev.onCache(this.cache(), this.count)
				} else if (!this.publishTimer) {
					// Trailing flush so the LAST record of a burst is never left unpublished.
					this.publishTimer = setTimeout(() => {
						this.publishTimer = null
						this.lastPublish = Date.now()
						this.ev.onCache(this.cache(), this.count)
					}, 500)
				}
			}
			return
		}
		// A cue edit on the desk (subscribers only): re-fetch just the named cues,
		// and re-count in case cues were inserted or deleted (indexes shift).
		// Arguments: a notification sequence number, then cue numbers or ranges ("1-5").
		if ((m = a.match(/^\/eos\/out\/notify\/cue\/([\d.]+)(?:\/|$)/))) {
			if (m[1] !== String(this.cueList)) return
			const ranges: Array<[number, number]> = []
			for (const arg of (msg.args ?? []).slice(1)) {
				const r = String(arg.value).match(/^([\d.]+)(?:-([\d.]+))?$/)
				if (r) ranges.push([Number(r[1]), Number(r[2] ?? r[1])])
			}
			const refetch = new Set<string>()
			for (const [idx, c] of this.byIndex) {
				const n = Number(c.number)
				if (ranges.some(([lo, hi]) => n >= lo && n <= hi)) {
					this.byIndex.delete(idx)
					refetch.add(c.number)
				}
			}
			if (refetch.size > 0) this.touch()
			for (const n of refetch) this.enqueue(`/eos/get/cue/${this.cueList}/${n}`)
			// Single numbers not cached yet (new cues) are fetched too; the re-count covers range inserts.
			for (const [lo, hi] of ranges) if (lo === hi) this.enqueue(`/eos/get/cue/${this.cueList}/${lo}`)
			this.enqueue(`/eos/get/cue/${this.cueList}/count`)
		}
	}
}
