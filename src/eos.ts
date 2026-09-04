/**
 * Read-only ETC Eos reader (#907 cue cursor).
 *
 * Opens its own OSC TCP connection to the desk, subscribes, reads the chosen
 * cue list in sheet order (`/eos/get/cue/<list>/count` then one
 * `/eos/get/cue/<list>/index/<i>` per cue), and follows the live cue via
 * `/eos/out/active/cue/<list>/<num>`. Edits on the desk arrive as
 * `/eos/out/notify/cue/<list>/...` and trigger a debounced re-read.
 *
 * It NEVER sends a command that changes console state: no /eos/key, no
 * /eos/cmd, no /eos/cue fire. (/eos/reset only clears this client's output
 * subscription state on the desk and asks for a resend.) Firing stays with the
 * ETC Eos module if you use one; both can be connected at once.
 */
// `osc` is CommonJS; under Node's ESM loader only the default export is importable.
import osc from 'osc'
import type { OscMessage, TCPSocketPort as TCPSocketPortType } from 'osc'
const { TCPSocketPort } = osc

export interface EosCue {
  number: string
  label: string
}

export interface EosReaderEvents {
  onStatus: (connected: boolean, message: string) => void
  onLive: (cueNumber: string) => void
  onList: (cues: EosCue[]) => void
  log: (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void
}

const PORT_OSC10 = 3032
const PORT_SLIP = 3037
const BATCH = 40
const BATCH_GAP_MS = 60
const NOTIFY_DEBOUNCE_MS = 1000
const RECONNECT_MS = 5000

export class EosReader {
  private socket: TCPSocketPortType | null = null
  private connected = false
  private closed = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private notifyTimer: NodeJS.Timeout | null = null
  private expectedCount = 0
  private pending: Map<number, EosCue> = new Map()

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
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    try { this.socket?.close() } catch { /* already closed */ }
    this.socket = null
    this.connected = false
  }

  private connect(): void {
    const port = this.useSlip ? PORT_SLIP : PORT_OSC10
    const socket = new TCPSocketPort({ address: this.host, port, useSLIP: this.useSlip, metadata: true })
    this.socket = socket
    socket.on('ready', () => {
      this.connected = true
      this.ev.onStatus(true, `Eos ${this.host}:${port}`)
      this.ev.log('info', `Eos: connected to ${this.host}:${port} (read-only), reading cue list ${this.cueList}`)
      // /eos/reset resets THIS CLIENT's OSC output state on the desk so it resends
      // the current active/pending cue at once; it changes nothing on the console.
      this.send('/eos/reset', [])
      this.send('/eos/subscribe', [{ type: 'i', value: 1 }])
      this.readList()
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

  private send(address: string, args: Array<{ type: string; value: unknown }>): void {
    try { this.socket?.send({ address, args }) } catch (e) { this.ev.log('debug', `Eos send failed: ${(e as Error).message}`) }
  }

  /** Read the whole list: count, then every index in small batches. */
  readList(): void {
    this.pending = new Map()
    this.expectedCount = 0
    this.send(`/eos/get/cue/${this.cueList}/count`, [])
  }

  private requestIndexes(count: number): void {
    let i = 0
    const tick = () => {
      const end = Math.min(count, i + BATCH)
      for (; i < end; i++) this.send(`/eos/get/cue/${this.cueList}/index/${i}`, [])
      if (i < count) setTimeout(tick, BATCH_GAP_MS)
    }
    tick()
  }

  private onMessage(msg: OscMessage): void {
    const a = msg.address
    this.ev.log('debug', `Eos ← ${a}`)
    let m: RegExpMatchArray | null

    // Live position (implicit output after subscribe).
    if ((m = a.match(/^\/eos\/out\/active\/cue\/([\d.]+)\/([\d.]+)$/))) {
      if (m[1] === String(this.cueList)) this.ev.onLive(m[2])
      return
    }
    // Count reply → request every index.
    if ((m = a.match(/^\/eos\/out\/get\/cue\/([\d.]+)\/count$/))) {
      if (m[1] !== String(this.cueList)) return
      const n = Number(msg.args?.[0]?.value ?? 0)
      this.expectedCount = n
      this.ev.log('info', `Eos: cue list ${this.cueList} has ${n} cues`)
      if (n === 0) this.ev.onList([])
      else this.requestIndexes(n)
      return
    }
    // Index reply: /eos/out/get/cue/<list>/<cue>/<part>/list/<index>/<count>
    // args: 0 index, 1 uid, 2 label, … (31 total). Part 0 is the base cue.
    if ((m = a.match(/^\/eos\/out\/get\/cue\/([\d.]+)\/([\d.]+)\/(\d+)\/list\/(\d+)\/(\d+)$/))) {
      if (m[1] !== String(this.cueList) || m[3] !== '0') return
      const index = Number(m[4])
      const label = String(msg.args?.[2]?.value ?? '')
      this.pending.set(index, { number: m[2], label })
      if (this.expectedCount > 0 && this.pending.size >= this.expectedCount) {
        const cues = [...this.pending.entries()].sort((x, y) => x[0] - y[0]).map(([, c]) => c)
        this.ev.onList(cues)
      }
      return
    }
    // Any cue edit on the desk: re-read (debounced) so the cache stays true.
    if (a.startsWith(`/eos/out/notify/cue/${this.cueList}/`)) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer)
      this.notifyTimer = setTimeout(() => { this.notifyTimer = null; this.readList() }, NOTIFY_DEBOUNCE_MS)
    }
  }
}
