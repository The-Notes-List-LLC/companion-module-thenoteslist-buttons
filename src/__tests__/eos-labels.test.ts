// Value: protects=the reader's read-only completeness signal and base-label snapshot that the cue-label sender trusts (#1162); fails_when=isComplete() reports true while a desk edit's re-fetch is outstanding or before the walk ends, or baseLabels() includes parts, empty labels or by-number-only labels; why_new=isComplete/baseLabels/cacheEpoch are new; seam=EosReader against a scripted socket (same as eos.test.ts), vitest fake timers; no_claim=what the sender does with these values (labels.test.ts) or a real desk's timing.
// Test-only file (excluded from the build by tsconfig.build.json); vitest is a dev dependency.
// eslint-disable-next-line n/no-unpublished-import
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EosReader, type EosSocket } from '../eos.js'
import type { OscPacket, OscTcpHandlers } from '../osc-tcp.js'

let sent: string[]
let handlers: OscTcpHandlers
let cacheEvents: number

function reader(): EosReader {
	return new EosReader(
		'desk',
		true,
		1,
		{
			onStatus: () => undefined,
			onLive: () => undefined,
			onCache: () => cacheEvents++,
			log: () => undefined,
		},
		(_host, _port, _slip, h): EosSocket => {
			handlers = h
			return { send: (address) => sent.push(address), destroy: () => h.onClose() }
		},
	)
}

const msg = (address: string, ...values: unknown[]): OscPacket => ({
	oscType: 'message',
	address,
	args: values.map((value) => ({ value })),
})
const cue = (num: string, index: number, label = `L${num}`, part = 0): OscPacket =>
	msg(`/eos/out/get/cue/1/${num}/${part}/list/0/1`, index, 'uid', label)
const count = (n: number): OscPacket => msg('/eos/out/get/cue/1/count', n)

beforeEach(() => {
	vi.useFakeTimers()
	sent = []
	cacheEvents = 0
})
afterEach(() => {
	vi.useRealTimers()
})

/** Connect, report a 4-record list (cue 2 has a part), answer every read, let the walk finish. */
async function walked(r: EosReader): Promise<void> {
	r.start()
	handlers.onConnect()
	await vi.advanceTimersByTimeAsync(100)
	handlers.onPacket(count(4))
	expect(r.isComplete()).toBe(false)
	handlers.onPacket(cue('1', 0, 'Preset'))
	handlers.onPacket(cue('2', 1, 'Blackout'))
	handlers.onPacket(cue('2', 2, 'part label', 1))
	handlers.onPacket(cue('3', 3, ''))
	await vi.advanceTimersByTimeAsync(500)
}

describe('EosReader: completeness and base labels', () => {
	it('is incomplete until the walk has finished, then complete', async () => {
		const r = reader()
		expect(r.isComplete()).toBe(false)
		await walked(r)
		expect(r.isComplete()).toBe(true)
		expect(r.listNumber()).toBe(1)
		r.stop()
	})

	it('baseLabels: base cues with a label only (no parts, no empty labels, no by-number replies)', async () => {
		const r = reader()
		await walked(r)
		handlers.onPacket(cue('99', -1, 'not placed')) // a by-number reply: label only, no index
		expect([...r.baseLabels()]).toEqual([
			['1', 'Preset'],
			['2', 'Blackout'],
		])
		r.stop()
	})

	it('is incomplete for the whole desk-edit window, complete again once its count lands; same epoch', async () => {
		const r = reader()
		await walked(r)
		const e = r.cacheEpoch()
		handlers.onPacket(msg('/eos/out/notify/cue/1', 7, 2))
		expect(r.isComplete()).toBe(false) // a by-number read and a count are queued
		await vi.advanceTimersByTimeAsync(100) // the reads go out; no answers yet
		expect(r.isComplete()).toBe(false)
		handlers.onPacket(cue('2', -1, 'Fade'))
		handlers.onPacket(cue('2', -1, 'part label', 1))
		expect(r.isComplete()).toBe(false) // answered, but settled only by the count
		const before = cacheEvents
		handlers.onPacket(count(4))
		expect(cacheEvents).toBeGreaterThan(before)
		expect(r.isComplete()).toBe(true)
		expect(r.baseLabels().get('2')).toBe('Fade')
		// Edited, not thrown away: the label sender sends an upsert, not the whole list again.
		expect(r.cacheEpoch()).toBe(e)
		r.stop()
	})

	it('stays incomplete while a second edit is still on its way, even when the first has settled', async () => {
		const r = reader()
		await walked(r)
		handlers.onPacket(msg('/eos/out/notify/cue/1', 8, 3))
		await vi.advanceTimersByTimeAsync(100)
		handlers.onPacket(msg('/eos/out/notify/cue/1', 9, 1))
		handlers.onPacket(cue('3', -1, 'New'))
		handlers.onPacket(count(4)) // settles the first edit only
		expect(r.baseLabels().get('3')).toBe('New')
		expect(r.isComplete()).toBe(false)
		await vi.advanceTimersByTimeAsync(100)
		handlers.onPacket(cue('1', -1, 'Preset'))
		handlers.onPacket(count(4))
		expect(r.isComplete()).toBe(true)
		r.stop()
	})

	it('a cache clear (reconnect or count change) changes the epoch and is incomplete', async () => {
		const r = reader()
		await walked(r)
		const e = r.cacheEpoch()
		handlers.onPacket(count(5))
		expect(r.cacheEpoch()).not.toBe(e)
		expect(r.isComplete()).toBe(false)
		expect(r.baseLabels().size).toBe(0)
		r.stop()
	})
})
