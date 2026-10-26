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
/** Every request of the test, for the read-only check (tests reset `sent`). */
let allSent: Array<{ address: string; args: unknown[] }>
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
				send: (address, args = []) => {
					sent.push(address)
					allSent.push({ address, args: args.map((a) => a.value) })
				},
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
	allSent = []
	destroyed = 0
	logs = []
	lives = []
})
afterEach(() => {
	// Read-only, always: nothing that fires a cue, presses a key or types a command line.
	expect(allSent.filter((s) => /^\/eos\/(key|cmd|newcmd|cue|event)(\/|$)/.test(s.address))).toEqual([])
	vi.useRealTimers()
})

/** Connect and let the subscribe / count requests go out. */
async function connected(r: EosReader): Promise<void> {
	r.start()
	handlers.onConnect()
	await vi.advanceTimersByTimeAsync(100)
}

describe('EosReader', () => {
	it('filters the desk output, then subscribes and asks for the count on connect', async () => {
		const r = reader()
		await connected(r)
		expect(sent.slice(0, 5)).toEqual([
			'/eos/reset',
			'/eos/filter/clear',
			'/eos/filter/add',
			'/eos/subscribe',
			'/eos/get/cue/1/count',
		])
		expect(allSent.find((s) => s.address === '/eos/filter/add')?.args).toEqual([
			'/eos/out/active/cue/*',
			'/eos/out/get/cue/*',
			'/eos/out/notify/cue/*',
			'/eos/out/ping',
		])
		r.stop()
	})

	it('runs unfiltered when no count comes back through the filter', async () => {
		const r = reader()
		await connected(r)
		sent = []
		await vi.advanceTimersByTimeAsync(5100)
		expect(logs.some((l) => l.startsWith('warn') && l.includes('running unfiltered'))).toBe(true)
		expect(logs.some((l) => l.includes('accepted the OSC output filter'))).toBe(false)
		expect(sent.filter((a) => a !== '/eos/ping')).toEqual(['/eos/filter/clear', '/eos/get/cue/1/count'])
		r.stop()
	})

	it('keeps the filter when the desk answers through it', async () => {
		const r = reader()
		await connected(r)
		handlers.onPacket(count(0))
		await vi.advanceTimersByTimeAsync(6000)
		expect(logs.some((l) => l.includes('running unfiltered'))).toBe(false)
		expect(logs.filter((l) => l === 'info Eos: the desk accepted the OSC output filter')).toHaveLength(1)
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

	it('re-reads edited cues by index when the desk is not in cue-number order', async () => {
		const r = reader()
		await connected(r)
		handlers.onPacket(count(3))
		for (const [n, i] of [
			['1', 0],
			['3', 1],
			['2', 2],
		] as const)
			handlers.onPacket(cue(n, i))
		await vi.advanceTimersByTimeAsync(500)
		expect(logs.some((l) => l.startsWith('warn') && l.includes('out of number order'))).toBe(true)
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

/** A by-number reply: Eos sends index -1 (it does not place the cue for us). */
const byNumber = (num: string, label = `L${num}`, part = 0): OscPacket => cue(num, -1, label, part)
const notify = (...targets: unknown[]): OscPacket => msg('/eos/out/notify/cue/1/list/0/1', 7, ...targets)
const sheet = (r: EosReader): string[] => {
	const out: string[] = []
	for (let i = 0; i < r.count; i++) {
		const c = r.at(i)
		out.push(c ? (c.part ? `${c.number}p${c.part}` : c.number) : '?')
	}
	return out
}

/** Connect and finish a walk of `numbers` (in cue-number order), then forget what was sent. */
async function walked(r: EosReader, numbers: string[]): Promise<void> {
	await connected(r)
	handlers.onPacket(count(numbers.length))
	numbers.forEach((n, i) => handlers.onPacket(cue(n, i)))
	await vi.advanceTimersByTimeAsync(500)
	expect(logs.some((l) => l.includes('walk complete'))).toBe(true)
	sent = []
	logs = []
}

describe('EosReader edits by cue number (after a complete walk)', () => {
	it('an inserted cue costs one read and a count, and slots in by number', async () => {
		const r = reader()
		await walked(r, ['1', '2', '3', '4'])
		handlers.onPacket(notify('2.5'))
		await vi.advanceTimersByTimeAsync(100)
		expect(sent).toEqual(['/eos/get/cue/1/2.5', '/eos/get/cue/1/count'])
		handlers.onPacket(byNumber('2.5', 'New'))
		handlers.onPacket(count(5))
		await vi.advanceTimersByTimeAsync(500)
		expect(sheet(r)).toEqual(['1', '2', '2.5', '3', '4'])
		expect(r.indexOf('3')).toBe(3)
		expect(r.labelOf('2.5')).toBe('New')
		expect(indexReads()).toEqual([])
		expect(logs.some((l) => l.includes('re-reading the list'))).toBe(false)
		r.stop()
	})

	it('a deleted cue (no reply before the count) leaves the list; later cues move up', async () => {
		const r = reader()
		await walked(r, ['1', '2', '3', '4'])
		handlers.onPacket(notify(3))
		await vi.advanceTimersByTimeAsync(100)
		expect(sent).toEqual(['/eos/get/cue/1/3', '/eos/get/cue/1/count'])
		handlers.onPacket(count(3))
		await vi.advanceTimersByTimeAsync(500)
		expect(sheet(r)).toEqual(['1', '2', '4'])
		expect(r.indexOf('3')).toBeUndefined()
		expect(r.indexOf('4')).toBe(2)
		expect(indexReads()).toEqual([])
		r.stop()
	})

	it('an added part arrives with its base cue and sits right after it', async () => {
		const r = reader()
		await walked(r, ['1', '2', '3'])
		handlers.onPacket(notify(2))
		await vi.advanceTimersByTimeAsync(100)
		expect(sent).toEqual(['/eos/get/cue/1/2', '/eos/get/cue/1/count'])
		handlers.onPacket(byNumber('2', 'Base'))
		handlers.onPacket(byNumber('2', 'Part', 1))
		handlers.onPacket(count(4))
		await vi.advanceTimersByTimeAsync(500)
		expect(sheet(r)).toEqual(['1', '2', '2p1', '3'])
		expect(r.indexOf('3')).toBe(3)
		expect(indexReads()).toEqual([])
		r.stop()
	})

	it('a changed label is re-read by number without moving anything', async () => {
		const r = reader()
		await walked(r, ['1', '2', '3'])
		handlers.onPacket(notify(2))
		await vi.advanceTimersByTimeAsync(100)
		handlers.onPacket(byNumber('2', 'Renamed'))
		handlers.onPacket(count(3))
		expect(sheet(r)).toEqual(['1', '2', '3'])
		expect(r.labelOf('2')).toBe('Renamed')
		expect(sent.length).toBe(2)
		r.stop()
	})

	it('a range with a cue we never had reads just that stretch by index, not the whole list', async () => {
		const r = reader()
		await walked(r, ['1', '2', '3', '4', '5', '6'])
		// Desk now: 1, 2, 2.5, 3, 4, 5, 6 ("copy to" landed 2.5 inside the range 2-3).
		handlers.onPacket(notify('2-3'))
		await vi.advanceTimersByTimeAsync(100)
		expect(sent).toEqual(['/eos/get/cue/1/2', '/eos/get/cue/1/3', '/eos/get/cue/1/count'])
		handlers.onPacket(byNumber('2'))
		handlers.onPacket(byNumber('3'))
		handlers.onPacket(count(7))
		await vi.advanceTimersByTimeAsync(100)
		expect(indexReads()).toEqual([1, 2, 3])
		handlers.onPacket(cue('2', 1))
		handlers.onPacket(cue('2.5', 2, 'Copied'))
		handlers.onPacket(cue('3', 3))
		handlers.onPacket(count(7))
		await vi.advanceTimersByTimeAsync(500)
		expect(sheet(r)).toEqual(['1', '2', '2.5', '3', '4', '5', '6'])
		expect(indexReads()).toEqual([1, 2, 3])
		expect(logs.some((l) => l.includes('re-reading the list'))).toBe(false)
		r.stop()
	})

	it('re-walks the whole list only when the targeted reads cannot match the desk count', async () => {
		const r = reader()
		await walked(r, ['1', '2', '3', '4'])
		handlers.onPacket(notify(9))
		await vi.advanceTimersByTimeAsync(100)
		// Cue 9 does not answer, yet the desk now has 5 records: we cannot tell where it went.
		handlers.onPacket(count(5))
		expect(logs.some((l) => l.includes('out of step after an edit (4 cached, desk has 5)'))).toBe(true)
		await vi.advanceTimersByTimeAsync(5 * 150 - 50)
		expect(indexReads()).toEqual([0, 1, 2, 3, 4])
		r.stop()
	})

	it('two notices before the first count comes back are both applied, nothing read twice', async () => {
		const r = reader()
		await walked(r, ['1', '2', '3', '4'])
		handlers.onPacket(notify(2))
		handlers.onPacket(notify(4))
		await vi.advanceTimersByTimeAsync(100)
		expect(sent).toEqual(['/eos/get/cue/1/2', '/eos/get/cue/1/4', '/eos/get/cue/1/count'])
		handlers.onPacket(byNumber('2', 'Two'))
		handlers.onPacket(count(3)) // 4 was deleted
		expect(sheet(r)).toEqual(['1', '2', '3'])
		expect(r.labelOf('2')).toBe('Two')
		r.stop()
	})

	it('a notice that arrives after its cue was already read again waits for its own count', async () => {
		const r = reader()
		await walked(r, ['1', '2', '3'])
		handlers.onPacket(notify(2))
		await vi.advanceTimersByTimeAsync(100) // get 2 and the count are sent
		handlers.onPacket(notify(2))
		await vi.advanceTimersByTimeAsync(100) // a second get 2 and count
		expect(sent).toEqual(['/eos/get/cue/1/2', '/eos/get/cue/1/count', '/eos/get/cue/1/2', '/eos/get/cue/1/count'])
		handlers.onPacket(byNumber('2', 'First'))
		handlers.onPacket(count(3))
		expect(r.labelOf('2')).toBe('First')
		handlers.onPacket(byNumber('2', 'Second'))
		handlers.onPacket(count(3))
		expect(r.labelOf('2')).toBe('Second')
		expect(sheet(r)).toEqual(['1', '2', '3'])
		r.stop()
	})

	it('reads every target of a notice that spans packets', async () => {
		const r = reader()
		await walked(r, ['1', '2', '3', '4'])
		handlers.onPacket(msg('/eos/out/notify/cue/1/list/0/3', 7, 2))
		handlers.onPacket(msg('/eos/out/notify/cue/1/list/2/3', 4))
		await vi.advanceTimersByTimeAsync(100)
		expect(sent).toEqual(['/eos/get/cue/1/2', '/eos/get/cue/1/4', '/eos/get/cue/1/count'])
		r.stop()
	})

	it('ignores the later packets of a long cue record (they carry no index or label)', async () => {
		const r = reader()
		await connected(r)
		handlers.onPacket(count(2))
		handlers.onPacket(msg('/eos/out/get/cue/1/7/0/list/40/45', 1, 'not-a-label'))
		expect(r.at(1)).toBeUndefined()
		r.stop()
	})
})
