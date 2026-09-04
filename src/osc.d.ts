declare module 'osc' {
  export interface OscArg { type: string; value: unknown }
  export interface OscMessage { address: string; args: OscArg[] }
  export interface OscBundle { timeTag: unknown; packets: Array<OscMessage | OscBundle> }
  export class TCPSocketPort {
    constructor(opts: { address: string; port: number; useSLIP?: boolean; metadata?: boolean })
    open(): void
    close(): void
    send(packet: { address: string; args: OscArg[] }): void
    on(event: 'ready' | 'close', cb: () => void): void
    on(event: 'error', cb: (err: Error) => void): void
    on(event: 'message', cb: (msg: OscMessage) => void): void
    on(event: 'bundle', cb: (bundle: OscBundle) => void): void
    on(event: 'osc', cb: (packet: OscMessage | OscBundle) => void): void
  }
  const osc: { TCPSocketPort: typeof TCPSocketPort }
  export default osc
}
