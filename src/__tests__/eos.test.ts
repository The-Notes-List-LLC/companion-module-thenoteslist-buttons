// Test-only file (excluded from the build by tsconfig.build.json); vitest is a dev dependency.
// eslint-disable-next-line n/no-unpublished-import
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EosReader, type EosSocket } from '../eos.js'
import type { OscPacket, OscTcpHandlers } from '../osc-tcp.js'

/**
 * The reader against a scripted desk: the fake socket records every request,
 * and the test answers with the replies Eos sends.
 */
let sent: string[]
let handlers: OscTcpHandlers
let destroyed: number
let logs: string[]
let lives: string[]

function reader(list = 1): EosReader {
	return new EosReader(
		'desk',
		true,
		list,
		{
			onStatus: () => undefined,
			onLive: (n) => lives.push(n),
			onCache: () => undefined,
			log: (level, msg) => logs.push(`${level} ${msg}`),
		},
		(_host, _port, _slip, h): EosSocket => {
			handlers = h
			return {
				send: (address) => sent.push(address),
				destroy: () => {
					destroyed++
					h.onClose()
				},
			}
		},
	)
}

const msg = (address: string, ...values: unknown[]): OscPacket => ({
	oscType: 'message',
	address,
	args: values.map((value) => ({ value })),
})
/** A cue record as Eos sends it: index in args[0], label in args[2]. */
const cue = (num: string, index: number, label = `L${num}`, part = 0): OscPacket =>
	msg(`/eos/out/get/cue/1/${num}/${part}/list/0/1`, index, 'uid', label)
const count = (n: number): OscPacket => msg('/eos/out/get/cue/1/count', n)
const indexReads = (): number[] =>
	sent
		.map((a) => a.match(/\/index\/(\d+)$/)?.[1])
		.filter((v): v is string => v !== undefined)
		.map(Number)

beforeEach(() => {
	vi.useFakeTimers()
	sent = []
	destroyed = 0
	logs = []
	lives = []
})
afterEach(() => {
	vi.useRealTimers()
})

/** Connect and let the subscribe / count requests go out. */
async function connected(r: EosReader): Promise<void> {
	r.start()
	handlers.onConnect()
	await vi.advanceTimersByTimeAsync(100)
}

describe('EosReader', () => {
	it('subscribes and asks for the count on connect', async () => {
		const r = reader()
		await connected(r)
		expect(sent.slice(0, 3)).toEqual(['/eos/reset', '/eos/subscribe', '/eos/get/cue/1/count'])
		r.stop()
	})

	it('keeps only the label of a by-number reply (index -1), never a position', async () => {
		const r = reader()
		await connected(r)
		handlers.onPacket(cue('440', -1, 'MUSIC'))
		expect(r.labelOf('440')).toBe('MUSIC')
		expect(r.indexOf('440')).toBeUndefined()
		expect(r.at(-1)).toBeUndefined()
		r.stop()
	})

	it('walks the whole list, never asks twice for a cached record, and reports when complete', async () => {
		const r = reader()
		await connected(r)
		handlers.onPacket(count(4))
		// Index 2 arrives early (e.g. a window read), before the walk reaches it.
		handlers.onPacket(cue('30', 2))
		// The walk sends one request per 150 ms: three reads go out (at 0, 150, 300 ms), none for index 2.
		await vi.advanceTimersByTimeAsync(350)
		expect(indexReads()).toEqual([0, 1, 3])
		for (const [n, i] of [
			['10', 0],
			['20', 1],
			['40', 3],
		] as const)
			handlers.onPacket(cue(n, i))
		await vi.advanceTimersByTimeAsync(500)
		expect(indexReads()).toEqual([0, 1, 3]) // all answered: no retry pass
		expect(logs.some((l) => l.includes('walk complete — 4 cues cached'))).toBe(true)
		r.stop()
	})

	it('fetches the live cue by number, then its window ahead of the background walk', async () => {
		const r = reader()
		await connected(r)
		handlers.onPacket(count(40))
		handlers.onPacket(msg('/eos/out/active/cue/1/25'))
		expect(lives).toEqual(['25'])
		await vi.advanceTimersByTimeAsync(30)
		expect(sent).toContain('/eos/get/cue/1/25')
		// The walk later caches cue 25 at index 20: its neighbours jump the queue.
		handlers.onPacket(cue('25', 20))
		sent = []
		await vi.advanceTimersByTimeAsync(22 * 4)
		expect(indexReads().every((i) => i >= 12 && i <= 28)).toBe(true)
		r.stop()
	})

	it('re-walks the list when the count changes (insert or delete)', async () => {
		const r = reader()
		await connected(r)
		handlers.onPacket(count(2))
		handlers.onPacket(cue('10', 0))
		handlers.onPacket(cue('20', 1))
		handlers.onPacket(count(3))
		expect(r.at(0)).toBeUndefined() // indexes after the edit moved: start again
		expect(logs.some((l) => l.includes('cue count changed 2 → 3'))).toBe(true)
		r.stop()
	})

	it('re-reads edited cues by index, including a range from a notify', async () => {
		const r = reader()
		await connected(r)
		handlers.onPacket(count(3))
		for (const [n, i] of [
			['1', 0],
			['2', 1],
			['3', 2],
		] as const)
			handlers.onPacket(cue(n, i))
		await vi.advanceTimersByTimeAsync(500)
		sent = []
		// Notify: a sequence number first, then cue numbers or ranges.
		handlers.onPacket(msg('/eos/out/notify/cue/1', 99, '2-3'))
		expect(r.at(0)?.number).toBe('1')
		expect(r.at(1)).toBeUndefined()
		expect(r.at(2)).toBeUndefined()
		await vi.advanceTimersByTimeAsync(200)
		expect(indexReads()).toEqual([1, 2])
		expect(sent).toContain('/eos/get/cue/1/count')
		r.stop()
	})

	it('starts afresh on reconnect: no cues, no count, the walk reports again', async () => {
		const r = reader()
		await connected(r)
		handlers.onPacket(count(1))
		handlers.onPacket(cue('10', 0))
		await vi.advanceTimersByTimeAsync(500)
		handlers.onClose()
		await vi.advanceTimersByTimeAsync(5000) // reconnect delay
		handlers.onConnect()
		expect(r.count).toBe(0)
		expect(r.at(0)).toBeUndefined()
		await vi.advanceTimersByTimeAsync(100)
		handlers.onPacket(count(1))
		handlers.onPacket(cue('10', 0))
		await vi.advanceTimersByTimeAsync(500)
		expect(logs.filter((l) => l.includes('walk complete')).length).toBe(2)
		r.stop()
	})

	it('pings the desk and reconnects when it goes silent', async () => {
		const r = reader()
		await connected(r)
		handlers.onPacket(count(0))
		await vi.advanceTimersByTimeAsync(5000)
		expect(sent).toContain('/eos/ping')
		expect(destroyed).toBe(0)
		await vi.advanceTimersByTimeAsync(10000) // nothing received for over 12 s
		expect(destroyed).toBe(1)
		expect(logs.some((l) => l.includes('no reply from the desk for 12 s'))).toBe(true)
		r.stop()
	})

	it('a reply keeps a quiet connection alive', async () => {
		const r = reader()
		await connected(r)
		for (let t = 0; t < 6; t++) {
			await vi.advanceTimersByTimeAsync(5000)
			handlers.onPacket(msg('/eos/out/ping'))
		}
		expect(destroyed).toBe(0)
		r.stop()
	})

	it('says when the desk is back after an outage, once', async () => {
		const r = reader()
		await connected(r)
		handlers.onPacket(count(0))
		handlers.onClose() // desk quit
		await vi.advanceTimersByTimeAsync(5000)
		handlers.onError(new Error('connect ECONNREFUSED'))
		handlers.onClose()
		await vi.advanceTimersByTimeAsync(10000)
		handlers.onConnect()
		handlers.onPacket(count(0))
		handlers.onPacket(count(0))
		expect(logs.filter((l) => l.includes('cannot reach')).length).toBe(1)
		expect(logs.filter((l) => l.startsWith('info') && l.includes('answering again')).length).toBe(1)
		r.stop()
	})

	it('ignores another cue list', async () => {
		const r = reader(2)
		await connected(r)
		handlers.onPacket(msg('/eos/out/active/cue/1/5'))
		handlers.onPacket(cue('5', 0))
		expect(lives).toEqual([])
		expect(r.at(0)).toBeUndefined()
		r.stop()
	})
})
