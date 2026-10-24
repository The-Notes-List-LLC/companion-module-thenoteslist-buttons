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
 * (plus a re-count for inserts/deletes). An OSC output filter, set on connect,
 * keeps the desk from sending the wheel/channel stream that subscribe brings.
 *
 * Once the first walk is complete and the desk's order is confirmed to be
 * cue-number order (parts right after their base cue), the cache is kept BY
 * NUMBER: an inserted, deleted or edited cue is re-read by number and the
 * sheet indexes are derived locally, so an edit costs a few requests instead of
 * a full re-walk. The desk answers in request order, so when the count that
 * follows those reads comes back, every reply to them has arrived: a named cue
 * with no reply was deleted. The full walk runs again only when the local list
 * and the desk's count still disagree after the targeted reads.
 *
 * Never sends a state-changing command: no /eos/key, /eos/cmd, /eos/cue.
 * `/eos/reset` only clears this client's output state so the desk resends the
 * current active/pending cue once on connect.
 */
import type { CueSheet } from './cursor.js'
import { OscTcpSocket, type OscMessage, type OscPacket, type OscSendArg, type OscTcpHandlers } from './osc-tcp.js'

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
	/** The cache changed (read it through the CueSheet methods). */
	onCache: () => void
	log: (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void
}

/** The socket as the reader uses it; tests pass a scripted one. */
export interface EosSocket {
	send(address: string, args?: OscSendArg[]): void
	destroy(): void
}
export type EosSocketFactory = (host: string, port: number, useSlip: boolean, handlers: OscTcpHandlers) => EosSocket

const PORT_OSC10 = 3032
const PORT_SLIP = 3037
const WINDOW = 8 // cues either side of the live cue kept warm
const REQUEST_GAP_MS = 22 // window reads: one request per 22 ms (~45/s); still no burst for the desk
// The full-list walk reruns on every insert/delete while the programmer records; at the
// window rate that is ~12 s of solid traffic each time and lags the desk. Walk gently.
const BACKGROUND_GAP_MS = 150
const RECONNECT_MIN_MS = 5000
const RECONNECT_MAX_MS = 60000 // back off while the desk stays unreachable
const CONNECT_TIMEOUT_MS = 5000 // give up on a connect attempt instead of waiting for the OS timeout
const MAX_CUES = 100000 // sanity cap on the count the desk reports
// Once the walk is done the desk has nothing to say to us, so a pulled cable or
// a rebooted desk leaves a half-open socket that never closes. Ping it, and drop
// the connection when nothing at all has arrived for a while.
const PING_MS = 5000
const SILENCE_MS = 12000
// OSC output filter (Eos 2.6.1+): the desk sends only messages starting with one of
// these. A "*" matches the rest of the address (ETC: "/eos/out/param/*" = every
// message that starts with "/eos/out/param/"). Older desks ignore the command.
const FILTERS = ['/eos/out/active/cue/*', '/eos/out/get/cue/*', '/eos/out/notify/cue/*', '/eos/out/ping']
// No count reply this long after connect: assume the filter swallowed it and run unfiltered.
const FILTER_CHECK_MS = 5000

/** Sheet order: by cue number, parts right after their base cue. */
function compareCues(a: EosCue, b: EosCue): number {
	return Number(a.number) - Number(b.number) || a.part - b.part
}

/** Reads sent between two count requests; the second count's reply settles them. */
interface CountWait {
	/** Cues re-read by number for an edit. */
	numbers: Set<string>
	/** A range re-read by index because the by-number reads could not place every cue. */
	slice: { lo: number; hi: number } | null
	/** Ranges named by the edits, kept for a slice pass if the count still disagrees. */
	ranges: Array<[number, number]>
}
const noWait = (): CountWait => ({ numbers: new Set(), slice: null, ranges: [] })

export class EosReader implements CueSheet {
	private socket: EosSocket | null = null
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
	/** Records in the list (base cues plus parts), as the desk last reported. */
	count = 0
	private byIndex: Map<number, EosCue> = new Map()
	/** Base cues by number, kept in step with byIndex (O(1) lookups for the cursor and labels). */
	private baseByNumber: Map<string, EosCue> = new Map()
	/** Labels learned from by-number replies, which carry no index. */
	private labels: Map<string, string> = new Map()
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
	/** The pending drain is the walk's long gap, which a window read may cut short. */
	private drainGapIsBackground = false
	private pingTimer: NodeJS.Timeout | null = null
	private lastRx = 0
	/** Why this end closed the socket, logged in place of the plain "connection closed". */
	private closeReason: string | null = null
	/** The walk confirmed the desk's order is cue-number order: edits are applied by number. */
	private ordered = false
	/** Cues being re-read by number for an edit, with how many reads of each are outstanding. */
	private editReads: Map<string, number> = new Map()
	/** Records that came back for those reads (base cue plus parts), by number. */
	private editReplies: Map<string, EosCue[]> = new Map()
	/** Ranges from notifies not yet attached to a count request. */
	private editRanges: Array<[number, number]> = []
	/** A slice re-read by index in progress, and what came back for it. */
	private slice: { lo: number; hi: number; indexes: Set<number> } | null = null
	private sliceReplies: EosCue[] = []
	/** Reads sent since the last count request, and one entry per count request in flight. */
	private sinceCount: CountWait = noWait()
	private countWaits: CountWait[] = []
	private gotCount = false
	private filterTimer: NodeJS.Timeout | null = null
	/** Bumped whenever the whole cache is thrown away (connect, reload, count change): readers of the cache start over. */
	private epoch = 0

	constructor(
		private readonly host: string,
		private readonly useSlip: boolean,
		private readonly cueList: number,
		private readonly ev: EosReaderEvents,
		private readonly makeSocket: EosSocketFactory = (h, p, slip, handlers) => new OscTcpSocket(h, p, slip, handlers),
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
		if (this.filterTimer) clearTimeout(this.filterTimer)
		this.stopPing()
		// Destroy, not end(): a pending connect or a half-open socket is released now,
		// not when the OS or the desk gets round to it.
		const socket = this.socket
		this.socket = null
		socket?.destroy()
		this.connected = false
	}

	/** Label of a base cue: from the indexed cache, else from a by-number reply. */
	labelOf(number: string): string {
		return this.baseByNumber.get(number)?.label ?? this.labels.get(number) ?? ''
	}

	/** The cached record at a sheet index, if any. */
	at(index: number): EosCue | undefined {
		return this.byIndex.get(index)
	}

	/** Sheet index of a cached base cue (part 0), if any. */
	indexOf(number: string): number | undefined {
		return this.baseByNumber.get(number)?.index
	}

	/** The Eos cue list this reader follows. */
	listNumber(): number {
		return this.cueList
	}

	/** Changes every time the whole cache is cleared, so a consumer can tell a fresh walk from an edit. */
	cacheEpoch(): number {
		return this.epoch
	}

	/**
	 * The cache holds the whole list right now: the walk has finished, every index is
	 * cached, and no cue read is still waiting to go out. False while a desk edit's
	 * re-fetch is in progress (those records are dropped and re-queued). Read-only.
	 */
	isComplete(): boolean {
		if (!this.walkAnnounced || this.count === 0 || this.byIndex.size < this.count) return false
		// An edit applied by number: its reads are out, or answered and waiting for their count.
		if (this.editReads.size > 0 || this.countWaits.some((w) => w.numbers.size > 0 || w.slice) || this.slice)
			return false
		const pending = (address: string) => address.startsWith('/eos/get/cue/') && !this.isCachedRead(address)
		return !this.queue.some(pending) && !this.background.some(pending)
	}

	/** Number → label of every cached base cue (part 0) with a non-empty label, from the indexed records only. */
	baseLabels(): Map<string, string> {
		const out = new Map<string, string>()
		for (const c of this.byIndex.values()) if (c.part === 0 && c.label !== '') out.set(c.number, c.label)
		return out
	}

	private putCue(cue: EosCue): void {
		this.dropCue(cue.index)
		this.byIndex.set(cue.index, cue)
		if (cue.part === 0) this.baseByNumber.set(cue.number, cue)
	}

	private dropCue(index: number): void {
		const old = this.byIndex.get(index)
		if (!old) return
		this.byIndex.delete(index)
		if (old.part === 0 && this.baseByNumber.get(old.number) === old) this.baseByNumber.delete(old.number)
	}

	private clearCues(): void {
		this.epoch++
		this.byIndex.clear()
		this.baseByNumber.clear()
	}

	/** Leave by-number mode: drop edit reads in flight (their replies are then ignored). */
	private resetEdits(): void {
		this.ordered = false
		this.editReads.clear()
		this.editReplies.clear()
		this.editRanges = []
		this.slice = null
		this.sliceReplies = []
	}

	/** Re-derive every index from cue-number order. */
	private reindex(records: EosCue[]): void {
		records.sort(compareCues)
		// Not clearCues(): the cache is edited, not thrown away, so the epoch stays (a label
		// reader sends just what changed instead of the whole list again).
		this.byIndex.clear()
		this.baseByNumber.clear()
		records.forEach((c, i) => this.putCue({ ...c, index: i }))
	}

	/** Make sure indexes [from, to] are cached (fetches the missing ones, spaced out, ahead of the walk). */
	ensureRange(from: number, to: number): void {
		// By number, the cache is complete; an index read would come back at the desk's position, not ours.
		if (this.ordered) return
		const lo = Math.max(0, from)
		const hi = this.count > 0 ? Math.min(this.count - 1, to) : to
		for (let i = lo; i <= hi; i++) {
			if (!this.byIndex.has(i)) this.enqueue(`/eos/get/cue/${this.cueList}/index/${i}`)
		}
	}

	/** Walk the entire list at low priority (after connect, or on demand after edits on the desk). */
	reloadList(): void {
		this.resetEdits()
		this.clearCues()
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
		const socket: EosSocket = this.makeSocket(this.host, port, this.useSlip, {
			onConnect: () => {
				if (!current()) return
				if (this.connectTimer) clearTimeout(this.connectTimer)
				this.connectTimer = null
				this.connected = true
				this.gotPacket = false
				this.decodeErrorLogged = false
				this.closeReason = null
				// A fresh session: forget the last one's cues and what it was waiting for.
				this.clearCues()
				this.resetEdits()
				this.wantedByNumber.clear()
				this.sinceCount = noWait()
				this.countWaits = []
				this.gotCount = false
				this.count = 0
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
				// Filter first, so the desk never starts the wheel/channel stream subscribe
				// would bring; then subscribe (the active/pending cue outputs ride it).
				this.enqueue('/eos/reset')
				this.enqueue('/eos/filter/clear')
				this.enqueue('/eos/filter/add')
				this.enqueue('/eos/subscribe')
				this.enqueue(`/eos/get/cue/${this.cueList}/count`)
				this.startPing(socket)
				if (this.filterTimer) clearTimeout(this.filterTimer)
				this.filterTimer = setTimeout(() => {
					this.filterTimer = null
					if (!current() || this.gotCount) return
					// The desk read the filter differently from ETC's documentation and is
					// holding back our replies. Run unfiltered rather than not at all.
					this.ev.log('warn', 'Eos: no reply through the OSC output filter; clearing it and running unfiltered')
					// The swallowed count will never be answered: forget its place in the line.
					this.countWaits = []
					this.enqueue('/eos/filter/clear')
					this.enqueue(`/eos/get/cue/${this.cueList}/count`)
				}, FILTER_CHECK_MS)
			},
			// Eos answers /eos/get/cue/... with BUNDLES (the cue record plus its fx /
			// links / actions messages). onPacket unpacks them; nested bundles too.
			onPacket: (packet) => {
				if (!current()) return
				this.lastRx = Date.now()
				if (!this.gotPacket) {
					// The desk answers in our framing: the connection is good, so back off from scratch.
					this.gotPacket = true
					// After a reported problem the connect line went to debug; say it is back.
					if (this.errorLogged) this.ev.log('info', `Eos: ${this.host}:${port} is answering again`)
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
				if (this.filterTimer) clearTimeout(this.filterTimer)
				this.filterTimer = null
				this.stopPing()
				const was = this.connected
				this.connected = false
				// Nothing to send to: stop draining and forget pending requests; connect starts a new walk.
				if (this.drainTimer) clearTimeout(this.drainTimer)
				this.drainTimer = null
				this.queue = []
				this.background = []
				this.queued.clear()
				// Only a connection that worked is worth a warning when it ends.
				if (was) this.ev.log(this.gotPacket ? 'warn' : 'debug', this.closeReason ?? 'Eos: connection closed')
				this.closeReason = null
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

	private startPing(socket: EosSocket): void {
		this.stopPing()
		this.lastRx = Date.now()
		this.pingTimer = setInterval(() => {
			if (this.socket !== socket) return this.stopPing()
			if (Date.now() - this.lastRx > SILENCE_MS) {
				// Destroy; the close handler logs this reason and schedules the reconnect.
				this.closeReason = `Eos: no reply from the desk for ${Math.round(SILENCE_MS / 1000)} s; reconnecting`
				this.stopPing()
				socket.destroy()
				return
			}
			this.enqueue('/eos/ping')
		}, PING_MS)
	}

	private stopPing(): void {
		if (this.pingTimer) clearInterval(this.pingTimer)
		this.pingTimer = null
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
		if (this.drainTimer && this.drainGapIsBackground) {
			// A window read does not wait out the walk's long gap.
			clearTimeout(this.drainTimer)
			this.drainTimer = setTimeout(() => this.drain(), REQUEST_GAP_MS)
			this.drainGapIsBackground = false
		}
		if (!this.drainTimer) this.drain()
	}

	private drain(): void {
		// Window reads first; the background walk only uses idle slots.
		let address: string | undefined
		let fromBackground = false
		do {
			address = this.queue.shift()
			fromBackground = address === undefined
			if (address !== undefined) this.queued.delete(address)
			else {
				do {
					address = this.background.shift()
				} while (address !== undefined && this.queued.has(address))
			}
			// The same record can sit in both queues (a window read overtakes the walk):
			// never ask the desk twice for a cue that has already arrived.
		} while (address !== undefined && this.isCachedRead(address))
		if (address === undefined) {
			this.drainTimer = null
			this.onQueueIdle()
			return
		}
		const args: OscSendArg[] =
			address === '/eos/subscribe'
				? [{ type: 'i', value: 1 }]
				: address === '/eos/filter/add'
					? FILTERS.map((value) => ({ type: 's', value }))
					: []
		this.noteSent(address)
		try {
			this.socket?.send(address, args)
		} catch (e) {
			this.ev.log('debug', `Eos send failed: ${(e as Error).message}`)
		}
		this.drainGapIsBackground = fromBackground
		this.drainTimer = setTimeout(() => this.drain(), fromBackground ? BACKGROUND_GAP_MS : REQUEST_GAP_MS)
	}

	/**
	 * Track which edit reads a count request follows. The desk answers in order, so
	 * the reply to that count means every read sent before it has been answered.
	 */
	private noteSent(address: string): void {
		const prefix = `/eos/get/cue/${this.cueList}/`
		if (!address.startsWith(prefix)) return
		const rest = address.slice(prefix.length)
		if (rest === 'count') {
			this.sinceCount.ranges = this.editRanges
			this.editRanges = []
			this.countWaits.push(this.sinceCount)
			this.sinceCount = noWait()
		} else if (this.editReads.has(rest)) {
			this.sinceCount.numbers.add(rest)
		} else if (this.slice && rest.startsWith('index/') && this.slice.indexes.has(Number(rest.slice(6)))) {
			this.sinceCount.slice = { lo: this.slice.lo, hi: this.slice.hi }
		}
	}

	/** Ask for the count after everything queued so far (moving a queued count to the back). */
	private enqueueCountLast(): void {
		const address = `/eos/get/cue/${this.cueList}/count`
		if (this.queued.has(address)) this.queue = this.queue.filter((a) => a !== address)
		this.queued.delete(address)
		this.enqueue(address)
	}

	private isCachedRead(address: string): boolean {
		// By number, the only index reads are a slice re-read: those records are cached on purpose.
		if (this.ordered) return false
		const m = address.match(/\/index\/(\d+)$/)
		return m !== null && this.byIndex.has(Number(m[1]))
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
		// Name the gaps by their neighbours, so a record the desk will not return can be found on the desk.
		const where = (i: number): string =>
			`index ${i} (after ${this.byIndex.get(i - 1)?.number ?? '?'}, before ${this.byIndex.get(i + 1)?.number ?? '?'})`
		const gaps = missing.length
			? `, ${missing.length} unanswered: ${missing.slice(0, 5).map(where).join('; ')}${missing.length > 5 ? '; …' : ''}`
			: ''
		this.ev.log(
			'info',
			`Eos: cue list walk complete — ${baseCues} cues cached${parts ? ` (+${parts} parts)` : ''}${gaps}`,
		)
		if (missing.length === 0) this.checkOrder()
		this.ev.onCache()
	}

	/** A complete walk in cue-number order switches edits to by-number reads. */
	private checkOrder(): void {
		for (let i = 1; i < this.count; i++) {
			const a = this.byIndex.get(i - 1)
			const b = this.byIndex.get(i)
			if (!a || !b || compareCues(a, b) >= 0) {
				this.ev.log(
					'warn',
					`Eos: the desk lists cue ${b?.number ?? '?'} after ${a?.number ?? '?'}, out of number order; edits will re-read the whole list`,
				)
				return
			}
		}
		this.ordered = true
	}

	/**
	 * The count after a batch of edit reads came back: every reply to those reads is in.
	 * Apply them, then check the list against the desk's count.
	 */
	private settleEdits(wait: CountWait): void {
		const touched = wait.numbers.size > 0 || wait.slice !== null
		if (touched) {
			let records = [...this.byIndex.values()]
			for (const num of wait.numbers) {
				records = records.filter((c) => c.number !== num)
				// No reply at all: the cue was deleted.
				records.push(...(this.editReplies.get(num) ?? []))
				this.editReplies.delete(num)
				const left = (this.editReads.get(num) ?? 1) - 1
				if (left > 0) this.editReads.set(num, left)
				else this.editReads.delete(num)
			}
			if (wait.slice) {
				const { lo, hi } = wait.slice
				records = records.filter((c) => Number(c.number) < lo || Number(c.number) > hi)
				// Keep one record per number/part: a by-number read may have fetched it too.
				const have = new Set(records.map((c) => `${c.number}/${c.part}`))
				for (const c of this.sliceReplies) if (!have.has(`${c.number}/${c.part}`)) records.push(c)
				this.slice = null
				this.sliceReplies = []
			}
			this.reindex(records)
			this.ev.onCache()
		}
		// More edit reads are on the way: judge the list once they are in.
		if (this.countWaits.length > 0 || this.editReads.size > 0 || this.slice) return
		if (this.byIndex.size === this.count) {
			this.ev.log('debug', `Eos: edit applied by number (${wait.numbers.size} cues re-read)`)
			return
		}
		const ranges = wait.ranges
		const records = [...this.byIndex.values()]
		// A range ("1-5") can hold cues we never had; read just that stretch by index.
		const lo = Math.min(...ranges.map((r) => r[0]))
		const hi = Math.max(...ranges.map((r) => r[1]))
		const from = records.filter((c) => Number(c.number) < lo).length
		const inside = records.filter((c) => Number(c.number) >= lo && Number(c.number) <= hi).length
		const to = Math.min(this.count - 1, from + inside + Math.max(0, this.count - records.length) - 1)
		if (ranges.length > 0 && !wait.slice && to >= from) {
			const indexes = new Set<number>()
			for (let i = from; i <= to; i++) indexes.add(i)
			this.slice = { lo, hi, indexes }
			this.ev.log('debug', `Eos: re-reading cues ${lo}-${hi} (indexes ${from}-${to})`)
			for (const i of indexes) this.enqueue(`/eos/get/cue/${this.cueList}/index/${i}`)
			this.enqueueCountLast()
			return
		}
		this.ev.log(
			'info',
			`Eos: cue list out of step after an edit (${this.byIndex.size} cached, desk has ${this.count}); re-reading the list`,
		)
		this.resetEdits()
		this.clearCues()
		this.announcedCount = false
		this.walkAnnounced = false
		this.walkRetried = false
		this.ev.onCache()
		this.walkAll()
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
			const known = this.indexOf(num)
			if (known !== undefined) this.ensureRange(known - WINDOW, known + WINDOW)
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
			this.gotCount = true
			const wait = this.countWaits.shift() ?? noWait()
			const previous = this.count
			this.count = n
			if (this.ordered) {
				this.settleEdits(wait)
				return
			}
			if (previous === 0 && !this.announcedCount) {
				this.announcedCount = true
				this.ev.log(
					'info',
					`Eos: cue list ${this.cueList} has ${this.count} cues; walking the list in the background (${Math.round((this.count * BACKGROUND_GAP_MS) / 1000)} s)`,
				)
			} else if (previous !== this.count) {
				// Insert/delete: every index after the edit moved. Re-walk the whole list.
				this.ev.log('info', `Eos: cue count changed ${previous} → ${this.count}; re-reading the list`)
				this.announcedCount = false
				this.walkAnnounced = false
				this.clearCues()
			}
			this.ev.onCache()
			this.walkRetried = false
			this.walkAll()
			return
		}
		// /eos/out/get/cue/<list>/<cue>/<part>/list/<page>/<pages> — the trailing pair is
		// the ARGUMENT page counter, not the cue's position. The cue's sheet index is
		// args[0] (uint32); args[2] is the label. Part 0 = base cue.
		if ((m = a.match(/^\/eos\/out\/get\/cue\/([\d.]+)\/([\d.]+)\/(\d+)\/list\/(\d+)\/(\d+)$/))) {
			if (m[1] !== String(this.cueList)) return
			// A long record spans several packets; only the first carries index and label.
			if (m[4] !== '0') return
			const index = Number(msg.args?.[0]?.value)
			if (!Number.isInteger(index)) return
			const raw = msg.args?.[2]?.value
			const label = typeof raw === 'string' ? raw : ''
			if (this.ordered) {
				const record: EosCue = { number: m[2], label, index, part: Number(m[3]) }
				// A record with no UID is not a cue (assumed: how the desk answers for a deleted one).
				const real = typeof msg.args?.[1]?.value === 'string' && msg.args[1].value !== ''
				if (index < 0 && this.editReads.has(m[2])) {
					if (real) {
						const list = this.editReplies.get(m[2]) ?? []
						// A second read of the same cue replaces the first one's records, not adds to them.
						this.editReplies.set(m[2], [...list.filter((c) => c.part !== record.part), record])
					}
					return
				}
				if (index >= 0 && this.slice?.indexes.has(index)) {
					if (real) this.sliceReplies.push(record)
					return
				}
				// Anything else (the live cue read by number) only teaches a label.
				if (index < 0 && record.part === 0) {
					this.labels.set(m[2], label)
					this.ev.onCache()
				}
				return
			}
			if (index < 0) {
				// A by-number get (`/eos/get/cue/<list>/<num>`) answers with index -1:
				// Eos does not place the cue for us. Keep the label only; the walk (or a
				// later by-index read) supplies the position. Never cache it at -1, or it
				// sorts first and counts towards a complete walk.
				if (Number(m[3]) === 0) this.labels.set(m[2], label)
				this.ev.onCache()
				return
			}
			// Parts occupy their own index in the list; keep them so the walk can
			// complete and the cursor can step OVER them.
			const cue: EosCue = { number: m[2], label, index, part: Number(m[3]) }
			const fresh = !this.byIndex.has(index)
			this.putCue(cue)
			if (fresh) {
				// A by-number reply (live cue) has no window yet: warm it.
				if (this.wantedByNumber.delete(cue.number)) this.ensureRange(index - WINDOW, index + WINDOW)
				// Publish progressively, at most every 500 ms, plus once when complete.
				const now = Date.now()
				const complete = this.count > 0 && this.byIndex.size >= this.count
				if (complete || now - this.lastPublish > 500) {
					this.lastPublish = now
					this.ev.onCache()
				} else if (!this.publishTimer) {
					// Trailing flush so the LAST record of a burst is never left unpublished.
					this.publishTimer = setTimeout(() => {
						this.publishTimer = null
						this.lastPublish = Date.now()
						this.ev.onCache()
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
			// A long notify spans packets (/list/<offset>/<total>); only the first starts with the sequence number.
			const page = a.match(/\/list\/(\d+)\/\d+$/)
			const targets = (msg.args ?? []).slice(page && page[1] !== '0' ? 0 : 1)
			// Whole cue numbers arrive as integers, others (1.5) and ranges ("1-5") as strings.
			const singles: string[] = []
			const ranges: Array<[number, number]> = []
			for (const arg of targets) {
				const r = String(arg.value).match(/^([\d.]+)(?:-([\d.]+))?$/)
				if (!r) continue
				if (r[2] === undefined) singles.push(r[1])
				ranges.push([Number(r[1]), Number(r[2] ?? r[1])])
			}
			if (this.ordered) {
				this.readEdited(
					singles,
					ranges.filter(([lo, hi]) => lo !== hi),
				)
				return
			}
			// Cached records in range are re-read by index: a by-number reply carries no position.
			const refetch: number[] = []
			for (const [idx, c] of this.byIndex) {
				const n = Number(c.number)
				if (ranges.some(([lo, hi]) => n >= lo && n <= hi)) refetch.push(idx)
			}
			for (const idx of refetch) {
				const c = this.byIndex.get(idx)
				if (c?.part === 0) this.labels.delete(c.number)
				this.dropCue(idx)
				this.enqueue(`/eos/get/cue/${this.cueList}/index/${idx}`)
			}
			// Single numbers not cached yet (new cues) are fetched too; the re-count covers range inserts.
			for (const num of singles) this.enqueue(`/eos/get/cue/${this.cueList}/${num}`)
			this.enqueue(`/eos/get/cue/${this.cueList}/count`)
		}
	}

	/** By number: re-read the named cues (and the cached ones inside a range), then the count. */
	private readEdited(singles: string[], ranges: Array<[number, number]>): void {
		const numbers = new Set(singles)
		for (const c of this.baseByNumber.values()) {
			const n = Number(c.number)
			if (ranges.some(([lo, hi]) => n >= lo && n <= hi)) numbers.add(c.number)
		}
		for (const num of numbers) {
			const address = `/eos/get/cue/${this.cueList}/${num}`
			// Already queued and unsent (an earlier edit, or the live cue): that one read answers this edit too.
			if (this.queued.has(address)) {
				if (!this.editReads.has(num)) this.editReads.set(num, 1)
				continue
			}
			this.editReads.set(num, (this.editReads.get(num) ?? 0) + 1)
			this.enqueue(address)
		}
		this.editRanges.push(...ranges)
		this.enqueueCountLast()
	}
}
