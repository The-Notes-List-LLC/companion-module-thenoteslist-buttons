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
import osc from 'osc'
import type { OscBundle, OscMessage, TCPSocketPort as TCPSocketPortType } from 'osc'
const { TCPSocketPort } = osc

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
const RECONNECT_MS = 5000

export class EosReader {
  private socket: TCPSocketPortType | null = null
  private connected = false
  private closed = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private count = 0
  private byIndex: Map<number, EosCue> = new Map()
  private queue: string[] = [] // high priority: window around live / cursor
  private background: string[] = [] // low priority: the full-list walk
  private queued: Set<string> = new Set()
  private lastPublish = 0
  private publishTimer: NodeJS.Timeout | null = null
  private walkRetried = false
  private walkAnnounced = false
  private wantedByNumber: Set<string> = new Set()
  /** Labels learned from by-number replies (which carry no index). */
  private labels: Map<string, string> = new Map()
  private subscribed = false
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
    try { this.socket?.close() } catch { /* already closed */ }
    this.socket = null
    this.connected = false
  }

  /** Label of a base cue: from the indexed cache, else from a by-number reply. */
  labelOf(number: string): string {
    for (const c of this.byIndex.values()) if (c.number === number && c.part === 0) return c.label
    return this.labels.get(number) ?? ''
  }

  /** Cues known so far, in sheet order. */
  cache(): EosCue[] {
    return [...this.byIndex.values()].sort((a, b) => a.index - b.index)
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
    const socket = new TCPSocketPort({ address: this.host, port, useSLIP: this.useSlip, metadata: true })
    this.socket = socket
    socket.on('ready', () => {
      this.connected = true
      this.subscribed = false
      this.byIndex.clear()
      this.ev.onStatus(true, `Eos ${this.host}:${port}`)
      this.ev.log('info', `Eos: connected to ${this.host}:${port} (read-only), cue list ${this.cueList}`)
      // Subscribe at once: the active/pending cue outputs ride the subscription.
      // The wheel/channel traffic it also brings is ignored; the earlier lag was
      // the request burst, which the spaced walk below no longer causes.
      this.subscribed = true
      this.enqueue('/eos/reset')
      this.enqueue('/eos/subscribe')
      this.enqueue(`/eos/get/cue/${this.cueList}/count`)
    })
    socket.on('message', (msg) => this.onMessage(msg))
    // Eos answers /eos/get/cue/... with BUNDLES (the cue record plus its fx /
    // links / actions messages). Unpack them; nested bundles too.
    socket.on('bundle', (bundle) => this.onBundle(bundle))
    socket.on('error', (err) => {
      if (this.connected) this.ev.log('warn', `Eos: ${err.message}`)
    })
    socket.on('close', () => {
      // A reader stopped by a config re-save must not report "disconnected"
      // after its replacement has already connected.
      if (this.closed || this.socket !== socket) return
      const was = this.connected
      this.connected = false
      if (was) this.ev.log('warn', 'Eos: connection closed')
      this.ev.onStatus(false, 'Eos: disconnected')
      this.scheduleReconnect()
    })
    try {
      socket.open()
    } catch (e) {
      this.ev.log('warn', `Eos: open failed: ${(e as Error).message}`)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closed) this.connect()
    }, RECONNECT_MS)
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
      do { address = this.background.shift() } while (address !== undefined && this.queued.has(address))
    }
    if (address === undefined) {
      this.drainTimer = null
      this.onQueueIdle()
      return
    }
    const args = address === '/eos/subscribe' ? [{ type: 'i', value: 1 }] : []
    try { this.socket?.send({ address, args }) } catch (e) { this.ev.log('debug', `Eos send failed: ${(e as Error).message}`) }
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
    this.ev.log('info', `Eos: cue list walk complete — ${baseCues} cues cached${parts ? ` (+${parts} parts)` : ''}${missing.length ? `, ${missing.length} unanswered` : ''}`)
    this.ev.onCache(this.cache(), this.count)
  }

  private onBundle(bundle: OscBundle): void {
    for (const p of bundle.packets ?? []) {
      if ((p as OscBundle).packets) this.onBundle(p as OscBundle)
      else if ((p as OscMessage).address) this.onMessage(p as OscMessage)
    }
  }

  private onMessage(msg: OscMessage): void {
    const a = msg.address
    let m: RegExpMatchArray | null

    if ((m = a.match(/^\/eos\/out\/active\/cue\/([\d.]+)\/([\d.]+)$/))) {
      if (m[1] !== String(this.cueList)) return
      const num = m[2]
      this.ev.onLive(num)
      // Learn this cue's index (the reply carries it), then warm its neighbours.
      const known = [...this.byIndex.values()].find((c) => c.number === num && c.part === 0)
      if (known) this.ensureRange(known.index - WINDOW, known.index + WINDOW)
      else {
        this.wantedByNumber.add(num)
        this.enqueue(`/eos/get/cue/${this.cueList}/${num}`)
      }
      return
    }
    if ((m = a.match(/^\/eos\/out\/get\/cue\/([\d.]+)\/count$/))) {
      if (m[1] !== String(this.cueList)) return
      const previous = this.count
      this.count = Number(msg.args?.[0]?.value ?? 0)
      if (previous === 0 && !this.announcedCount) {
        this.announcedCount = true
        this.ev.log('info', `Eos: cue list ${this.cueList} has ${this.count} cues; walking the list in the background (${Math.round((this.count * REQUEST_GAP_MS) / 1000)} s)`)
      }
      else if (previous !== this.count) {
        // Insert/delete: every index after the edit moved. Re-walk the whole list.
        this.ev.log('info', `Eos: cue count changed ${previous} → ${this.count}; re-reading the list`)
        this.announcedCount = false
        this.walkAnnounced = false
        this.byIndex.clear()
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
      if (!Number.isFinite(index)) return
      const label = String(msg.args?.[2]?.value ?? '')
      if (index < 0) {
        // A by-number get (`/eos/get/cue/<list>/<num>`) answers with index -1:
        // Eos does not place the cue for us. Keep the label only; the walk (or
        // a later by-index read) supplies the position. Never cache it at -1,
        // or it sorts first and the cursor thinks the live cue is at the top.
        if (Number(m[3]) === 0) this.labels.set(m[2], label)
        this.wantedByNumber.delete(m[2])
        this.ev.onCache(this.cache(), this.count)
        return
      }
      // Parts occupy their own index in the list; keep them so the walk can
      // complete and the cursor can step OVER them.
      const cue: EosCue = { number: m[2], label, index, part: Number(m[3]) }
      const fresh = !this.byIndex.has(index)
      this.byIndex.set(index, cue)
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
    if ((m = a.match(/^\/eos\/out\/notify\/cue\/([\d.]+)\//))) {
      if (m[1] !== String(this.cueList)) return
      const numbers = (msg.args ?? []).map((x) => String(x.value)).filter((v) => /^[\d.]+$/.test(v))
      for (const n of numbers) {
        for (const [idx, c] of this.byIndex) if (c.number === n) this.byIndex.delete(idx)
        this.enqueue(`/eos/get/cue/${this.cueList}/${n}`)
      }
      this.enqueue(`/eos/get/cue/${this.cueList}/count`)
    }
  }
}
