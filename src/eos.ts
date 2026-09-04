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
 * small window of neighbours by index, spaced out. Stepping past the window's
 * edge fetches a little more. No `/eos/subscribe`: that streams every wheel and
 * channel change and was the lag on a 1700-cue show.
 *
 * Never sends a state-changing command: no /eos/key, /eos/cmd, /eos/cue.
 * `/eos/reset` only clears this client's output state so the desk resends the
 * current active/pending cue once on connect.
 */
import osc from 'osc'
import type { OscMessage, TCPSocketPort as TCPSocketPortType } from 'osc'
const { TCPSocketPort } = osc

export interface EosCue {
  number: string
  label: string
  index: number
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
const REQUEST_GAP_MS = 30 // one request per 30 ms; the desk never sees a burst
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
  private wantedByNumber: Set<string> = new Set()
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
    try { this.socket?.close() } catch { /* already closed */ }
    this.socket = null
    this.connected = false
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
      this.byIndex.clear()
      this.ev.onStatus(true, `Eos ${this.host}:${port}`)
      this.ev.log('info', `Eos: connected to ${this.host}:${port} (read-only), cue list ${this.cueList}`)
      this.enqueue('/eos/reset')
      this.enqueue(`/eos/get/cue/${this.cueList}/count`)
    })
    socket.on('message', (msg) => this.onMessage(msg))
    socket.on('error', (err) => {
      if (this.connected) this.ev.log('warn', `Eos: ${err.message}`)
    })
    socket.on('close', () => {
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
    if (address === undefined) { this.drainTimer = null; return }
    try { this.socket?.send({ address, args: [] }) } catch (e) { this.ev.log('debug', `Eos send failed: ${(e as Error).message}`) }
    this.drainTimer = setTimeout(() => this.drain(), REQUEST_GAP_MS)
  }

  private onMessage(msg: OscMessage): void {
    const a = msg.address
    let m: RegExpMatchArray | null

    if ((m = a.match(/^\/eos\/out\/active\/cue\/([\d.]+)\/([\d.]+)$/))) {
      if (m[1] !== String(this.cueList)) return
      const num = m[2]
      this.ev.onLive(num)
      // Learn this cue's index (the reply carries it), then warm its neighbours.
      const known = [...this.byIndex.values()].find((c) => c.number === num)
      if (known) this.ensureRange(known.index - WINDOW, known.index + WINDOW)
      else {
        this.wantedByNumber.add(num)
        this.enqueue(`/eos/get/cue/${this.cueList}/${num}`)
      }
      return
    }
    if ((m = a.match(/^\/eos\/out\/get\/cue\/([\d.]+)\/count$/))) {
      if (m[1] !== String(this.cueList)) return
      this.count = Number(msg.args?.[0]?.value ?? 0)
      this.ev.log('info', `Eos: cue list ${this.cueList} has ${this.count} cues; walking the list in the background (${Math.round((this.count * REQUEST_GAP_MS) / 1000)} s)`)
      this.ev.onCache(this.cache(), this.count)
      this.walkAll()
      return
    }
    // /eos/out/get/cue/<list>/<cue>/<part>/list/<index>/<count>; args[2] = label. Part 0 = base cue.
    if ((m = a.match(/^\/eos\/out\/get\/cue\/([\d.]+)\/([\d.]+)\/(\d+)\/list\/(\d+)\/(\d+)$/))) {
      if (m[1] !== String(this.cueList) || m[3] !== '0') return
      const index = Number(m[4])
      const cue: EosCue = { number: m[2], label: String(msg.args?.[2]?.value ?? ''), index }
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
          if (complete) this.ev.log('info', `Eos: full cue list cached (${this.byIndex.size} cues)`)
        }
      }
      return
    }
    // A cue edit on the desk (only sent to subscribers; harmless if it arrives): forget it, re-fetch on demand.
    if ((m = a.match(/^\/eos\/out\/notify\/cue\/([\d.]+)\//))) {
      if (m[1] === String(this.cueList)) this.reloadList()
    }
  }
}
