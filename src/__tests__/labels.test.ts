// Value: protects=the desk-label sender's request budget and correctness (one replace after the walk, one debounced upsert per burst of edits, "" for removed labels, stop/pause/backoff by status); fails_when=it sends during a re-fetch window, sends per change, loses a difference after a failed send, retries a refused request, or ignores Retry-After; why_new=LabelSender is new in #1162; seam=LabelSender with a fake LabelSource and a recording send(), vitest fake timers; no_claim=the real Eos reader's completeness (eos-labels.test.ts) or the HTTP client and server contract.
// Test-only file (excluded from the build by tsconfig.build.json); vitest is a dev dependency.
// eslint-disable-next-line n/no-unpublished-import
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LabelSender, type CueLabelsBody, type LabelSource, type SendResult } from '../labels.js'

/** A stand-in reader: the test sets what the cache holds and whether it is complete. */
class FakeSource implements LabelSource {
	complete = false
	labels = new Map<string, string>()
	epoch = 0
	isComplete(): boolean {
		return this.complete
	}
	baseLabels(): Map<string, string> {
		return new Map(this.labels)
	}
	listNumber(): number {
		return 1
	}
	cacheEpoch(): number {
		return this.epoch
	}
	/** A cache clear (reconnect, re-walk): empty and incomplete. */
	clear(): void {
		this.epoch++
		this.complete = false
		this.labels.clear()
	}
}

let src: FakeSource
let sent: CueLabelsBody[]
let replies: SendResult[]
let statuses: string[]
let logs: string[]
let sender: LabelSender

function make(): LabelSender {
	return new LabelSender({
		reader: () => src,
		send: async (body) => {
			sent.push(body)
			return replies.shift() ?? { status: 200 }
		},
		log: (level, msg) => logs.push(`${level} ${msg}`),
		setStatus: (s) => statuses.push(s),
	})
}

const status = () => statuses.at(-1)
const cues = (body: CueLabelsBody | undefined) => Object.fromEntries((body?.cues ?? []).map((c) => [c.number, c.label]))

/** The walk finishes with these labels; the reader reports a cache change. */
async function walked(labels: Record<string, string>): Promise<void> {
	for (const [n, l] of Object.entries(labels)) src.labels.set(n, l)
	src.complete = true
	sender.onCacheChange()
	await vi.advanceTimersByTimeAsync(0)
}

/** A desk edit that leaves the cache complete. */
async function edit(fn: () => void): Promise<void> {
	fn()
	sender.onCacheChange()
	await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
	vi.useFakeTimers()
	src = new FakeSource()
	sent = []
	replies = []
	statuses = []
	logs = []
	sender = make()
})
afterEach(() => {
	sender.destroy()
	vi.useRealTimers()
})

describe('LabelSender', () => {
	it('sends nothing while the walk runs, then exactly one replace', async () => {
		sender.configure(true)
		expect(status()).toBe('waiting for walk')
		src.labels.set('1', 'Preset') // partial cache
		sender.onCacheChange()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(sent).toEqual([])
		await walked({ '2': 'Blackout' })
		await vi.advanceTimersByTimeAsync(10_000)
		expect(sent).toHaveLength(1)
		expect(sent[0]).toMatchObject({ mode: 'replace', cueList: '1' })
		expect(cues(sent[0])).toEqual({ '1': 'Preset', '2': 'Blackout' })
		expect(status()).toBe('ok 2')
		expect(logs).toEqual(['info Cue labels: sent 2 to The Notes List'])
	})

	it('skips the replace when no cue has a label', async () => {
		sender.configure(true)
		await walked({})
		expect(sent).toEqual([])
		expect(status()).toBe('ok 0')
	})

	it('a relabel sends exactly one upsert, 2 s after the last change', async () => {
		sender.configure(true)
		await walked({ '1': 'Preset', '2': 'Blackout' })
		await edit(() => src.labels.set('2', 'Fade'))
		await vi.advanceTimersByTimeAsync(1_000)
		await edit(() => src.labels.set('2', 'Fade out')) // restarts the debounce
		await vi.advanceTimersByTimeAsync(1_999)
		expect(sent).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(sent).toHaveLength(2)
		expect(sent[1]).toMatchObject({ mode: 'upsert', cues: [{ number: '2', label: 'Fade out' }] })
		await vi.advanceTimersByTimeAsync(10_000)
		expect(sent).toHaveLength(2)
		expect(logs).toHaveLength(1) // no per-upsert log
	})

	it('a removed cue or cleared label goes as ""', async () => {
		sender.configure(true)
		await walked({ '1': 'Preset', '2': 'Blackout' })
		await edit(() => src.labels.delete('2'))
		await vi.advanceTimersByTimeAsync(2_000)
		expect(sent[1]).toMatchObject({ mode: 'upsert', cues: [{ number: '2', label: '' }] })
		expect(status()).toBe('ok 1')
	})

	it('unticked: no requests at all, status off', async () => {
		sender.configure(false)
		await walked({ '1': 'Preset' })
		await edit(() => src.labels.set('1', 'X'))
		await vi.advanceTimersByTimeAsync(60_000)
		expect(sent).toEqual([])
		expect(status()).toBe('off')
	})

	it('a failed send keeps the differences: the retry carries both changes', async () => {
		sender.configure(true)
		await walked({ '1': 'Preset', '2': 'Blackout' })
		replies.push({ status: 500 })
		await edit(() => src.labels.set('1', 'A'))
		await vi.advanceTimersByTimeAsync(2_000) // upsert → 500, backoff 2 s
		expect(sent).toHaveLength(2)
		await edit(() => src.labels.set('2', 'B'))
		await vi.advanceTimersByTimeAsync(2_000) // backoff ends: one request with both
		expect(sent).toHaveLength(3)
		expect(cues(sent[2])).toEqual({ '1': 'A', '2': 'B' })
		expect(status()).toBe('ok 2')
	})

	it('never has two requests in flight; changes during one fold into the next', async () => {
		let release: (r: SendResult) => void = () => undefined
		sender = new LabelSender({
			reader: () => src,
			send: async (body) => {
				sent.push(body)
				return new Promise((resolve) => (release = resolve))
			},
			log: () => undefined,
			setStatus: (s) => statuses.push(s),
		})
		sender.configure(true)
		await walked({ '1': 'Preset' })
		expect(sent).toHaveLength(1)
		await edit(() => src.labels.set('1', 'A'))
		await vi.advanceTimersByTimeAsync(5_000)
		expect(sent).toHaveLength(1)
		release({ status: 200 })
		await vi.advanceTimersByTimeAsync(2_000)
		expect(sent).toHaveLength(2)
		expect(cues(sent[1])).toEqual({ '1': 'A' })
		release({ status: 200 })
	})

	for (const code of [401, 404, 410, 422]) {
		it(`stops on ${code} with one warning, until resumed`, async () => {
			sender.configure(true)
			replies.push({ status: code, error: 'nope' })
			await walked({ '1': 'Preset', '2': 'Blackout' })
			expect(status()).toBe(`stopped: ${code}`)
			await edit(() => src.labels.set('1', 'A'))
			await vi.advanceTimersByTimeAsync(10 * 60_000)
			expect(sent).toHaveLength(1)
			const warns = logs.filter((l) => l.startsWith('warn'))
			expect(warns).toHaveLength(1)
			if (code === 422) expect(warns[0]).toContain('tried to send 2')
			sender.resume() // e.g. the desk reconnected
			await vi.advanceTimersByTimeAsync(0)
			expect(sent).toHaveLength(2)
			expect(sent[1].mode).toBe('replace') // the stopped replace was never confirmed
		})
	}

	it('429: waits Retry-After seconds, then retries the same work', async () => {
		sender.configure(true)
		replies.push({ status: 429, retryAfter: 30 })
		await walked({ '1': 'Preset' })
		expect(status()).toBe('paused (too soon)')
		await vi.advanceTimersByTimeAsync(29_999)
		expect(sent).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(sent).toHaveLength(2)
		expect(sent[1]).toEqual(sent[0])
		expect(status()).toBe('ok 1')
	})

	it('503: paused (server off) for Retry-After, then retries', async () => {
		sender.configure(true)
		await walked({ '1': 'Preset' })
		replies.push({ status: 503, retryAfter: 900 })
		await edit(() => src.labels.set('1', 'A'))
		await vi.advanceTimersByTimeAsync(2_000)
		expect(status()).toBe('paused (server off)')
		await edit(() => src.labels.set('2', 'B')) // held, not sent
		await vi.advanceTimersByTimeAsync(899_000)
		expect(sent).toHaveLength(2)
		await vi.advanceTimersByTimeAsync(1_000)
		expect(sent).toHaveLength(3)
		expect(cues(sent[2])).toEqual({ '1': 'A', '2': 'B' })
	})

	it('5xx / network: backs off 2, 4, 8 s … capped at 5 min, reset by a 2xx', async () => {
		sender.configure(true)
		for (let i = 0; i < 12; i++) replies.push({ status: i % 2 ? 0 : 502 })
		await walked({ '1': 'Preset' })
		const times: number[] = []
		const t0 = Date.now()
		let seen = sent.length
		while (sent.length < 13) {
			await vi.advanceTimersByTimeAsync(1_000)
			if (sent.length !== seen) {
				seen = sent.length
				times.push(Math.round((Date.now() - t0) / 1000))
			}
		}
		const gaps = times.map((t, i) => t - (i ? times[i - 1] : 0))
		expect(gaps.slice(0, 8)).toEqual([2, 4, 8, 16, 32, 64, 128, 256])
		expect(gaps.slice(8)).toEqual([300, 300, 300, 300])
		expect(status()).toBe('ok 1')
		// After the 2xx the backoff starts from 2 s again.
		replies.push({ status: 500 })
		await edit(() => src.labels.set('1', 'A'))
		await vi.advanceTimersByTimeAsync(2_000)
		expect(sent).toHaveLength(14)
		await vi.advanceTimersByTimeAsync(2_000)
		expect(sent).toHaveLength(15)
	})

	it('a cache clear sends nothing until complete again, then one replace', async () => {
		sender.configure(true)
		await walked({ '1': 'Preset', '2': 'Blackout' })
		await edit(() => src.labels.set('1', 'A')) // debounce armed
		src.clear() // reconnect / re-walk: the pending upsert is dropped
		sender.onCacheChange()
		expect(status()).toBe('waiting for walk')
		src.labels.set('1', 'A')
		sender.onCacheChange()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(sent).toHaveLength(1)
		await walked({ '2': 'Blackout' })
		await vi.advanceTimersByTimeAsync(10_000)
		expect(sent).toHaveLength(2)
		expect(sent[1].mode).toBe('replace')
		expect(cues(sent[1])).toEqual({ '1': 'A', '2': 'Blackout' })
	})

	it('a desk-edit re-fetch window sends nothing, then at most one upsert of the real change', async () => {
		sender.configure(true)
		await walked({ '1': 'Preset', '2': 'Blackout', '3': 'Fade' })
		// Notify for 2-3: those records are dropped and re-queued; the cache is incomplete.
		await edit(() => {
			src.complete = false
			src.labels.delete('2')
			src.labels.delete('3')
		})
		await vi.advanceTimersByTimeAsync(5_000) // the debounce fires while incomplete: skipped
		expect(sent).toHaveLength(1)
		// The re-reads land: 2 unchanged, 3 relabelled.
		await edit(() => {
			src.labels.set('2', 'Blackout')
			src.labels.set('3', 'Fade 2')
			src.complete = true
		})
		await vi.advanceTimersByTimeAsync(10_000)
		expect(sent).toHaveLength(2)
		expect(sent[1]).toMatchObject({ mode: 'upsert', cues: [{ number: '3', label: 'Fade 2' }] })
	})

	it('Resend: lifts a stop and sends a full replace', async () => {
		sender.configure(true)
		await walked({ '1': 'Preset' })
		replies.push({ status: 403 })
		await edit(() => src.labels.set('1', 'A'))
		await vi.advanceTimersByTimeAsync(2_000)
		expect(status()).toBe('stopped: 403')
		sender.resend()
		await vi.advanceTimersByTimeAsync(0)
		expect(sent).toHaveLength(3)
		expect(sent[2]).toMatchObject({ mode: 'replace', cues: [{ number: '1', label: 'A' }] })
		expect(status()).toBe('ok 1')
	})

	it('Resend while the walk is still running waits for it', async () => {
		sender.configure(true)
		sender.resend()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(sent).toEqual([])
		await walked({ '1': 'Preset' })
		expect(sent).toHaveLength(1)
	})
})
