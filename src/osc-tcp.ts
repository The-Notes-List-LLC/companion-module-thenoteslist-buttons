/**
 * OSC over TCP, as ETC Eos speaks it. node-osc encodes and decodes the packets;
 * its own Client/Server are UDP only, so the socket and the stream framing live here:
 *  - OSC 1.0 (Eos port 3032): every packet is preceded by its length, a big-endian int32.
 *  - OSC 1.1 / SLIP (Eos port 3037): packets are SLIP-framed (RFC 1055), END byte on both ends.
 */
import net from 'node:net'
import { decode, encode } from 'node-osc'

export interface OscMessage {
	oscType: 'message'
	address: string
	args: Array<{ value: unknown }>
}
export interface OscBundle {
	oscType: 'bundle'
	timetag: number
	elements: OscPacket[]
}
export type OscPacket = OscMessage | OscBundle
export type OscSendArg = { type: 'i' | 'f' | 's'; value: number | string }

export interface OscTcpHandlers {
	onConnect: () => void
	onPacket: (packet: OscPacket) => void
	/** A packet arrived but could not be decoded (e.g. an argument type node-osc does not know). */
	onDecodeError: (err: Error) => void
	onError: (err: Error) => void
	onClose: () => void
}

const SLIP_END = 0xc0
const SLIP_ESC = 0xdb
const SLIP_ESC_END = 0xdc
const SLIP_ESC_ESC = 0xdd
/** Larger than any Eos reply; a bigger length prefix means the stream is out of step. */
const MAX_PACKET = 1024 * 1024

export class OscTcpSocket {
	private readonly socket: net.Socket
	/** Length framing: bytes received but not yet a whole packet. */
	private pending: Buffer = Buffer.alloc(0)
	/** SLIP framing: the packet being unescaped, and whether the last byte was ESC. */
	private slipBytes: number[] = []
	private slipEscaped = false

	constructor(
		host: string,
		port: number,
		private readonly useSlip: boolean,
		private readonly h: OscTcpHandlers,
	) {
		this.socket = net.connect({ host, port })
		this.socket.setNoDelay(true)
		this.socket.on('connect', () => this.h.onConnect())
		this.socket.on('data', (chunk) => (this.useSlip ? this.readSlip(chunk) : this.readLengthPrefixed(chunk)))
		this.socket.on('error', (err) => this.h.onError(err))
		this.socket.on('close', () => this.h.onClose())
	}

	send(address: string, args: OscSendArg[] = []): void {
		const packet = encode({ oscType: 'message', address, args })
		if (this.useSlip) {
			this.socket.write(slipEncode(packet))
		} else {
			const prefix = Buffer.alloc(4)
			prefix.writeInt32BE(packet.length, 0)
			this.socket.write(Buffer.concat([prefix, packet]))
		}
	}

	/** Release the socket at once (also abandons a connect still in progress); 'close' follows. */
	destroy(): void {
		this.socket.destroy()
	}

	private readLengthPrefixed(chunk: Buffer): void {
		this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
		while (this.pending.length >= 4) {
			const size = this.pending.readInt32BE(0)
			if (size < 0 || size > MAX_PACKET) {
				this.h.onError(new Error(`OSC stream out of step (packet length ${size}); is the desk expecting SLIP?`))
				this.socket.destroy()
				return
			}
			if (this.pending.length < 4 + size) return
			const packet = this.pending.subarray(4, 4 + size)
			this.pending = this.pending.subarray(4 + size)
			if (size > 0) this.deliver(packet)
		}
	}

	private readSlip(chunk: Buffer): void {
		for (const byte of chunk) {
			if (this.slipEscaped) {
				this.slipEscaped = false
				this.slipBytes.push(byte === SLIP_ESC_END ? SLIP_END : byte === SLIP_ESC_ESC ? SLIP_ESC : byte)
			} else if (byte === SLIP_ESC) {
				this.slipEscaped = true
			} else if (byte === SLIP_END) {
				// END on both ends of a packet means empty frames in between: skip them.
				if (this.slipBytes.length > 0) this.deliver(Buffer.from(this.slipBytes))
				this.slipBytes = []
			} else {
				this.slipBytes.push(byte)
			}
			if (this.slipBytes.length > MAX_PACKET) {
				this.h.onError(new Error('OSC stream out of step (SLIP frame too long); is the desk expecting OSC 1.0?'))
				this.socket.destroy()
				return
			}
		}
	}

	private deliver(packet: Buffer): void {
		let decoded: OscPacket
		try {
			decoded = decode(packet) as OscPacket
		} catch (e) {
			this.h.onDecodeError(e as Error)
			return
		}
		this.h.onPacket(decoded)
	}
}

function slipEncode(packet: Buffer): Buffer {
	const out: number[] = [SLIP_END]
	for (const byte of packet) {
		if (byte === SLIP_END) out.push(SLIP_ESC, SLIP_ESC_END)
		else if (byte === SLIP_ESC) out.push(SLIP_ESC, SLIP_ESC_ESC)
		else out.push(byte)
	}
	out.push(SLIP_END)
	return Buffer.from(out)
}
