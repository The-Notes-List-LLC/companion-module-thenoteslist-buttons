/**
 * Desk cue labels → The Notes List (#1162).
 *
 * Once the Eos reader holds the whole cue list, send every base cue's label with
 * one `replace`; after that, send only what changed as one `upsert` (a removed
 * label goes as ""), 2 s after the last change. Never more than one request in
 * flight. Reads the reader's cache only: no extra traffic to the desk.
 *
 * What we last got a 2xx for is `lastSent`; nothing else moves it, so a failed
 * send leaves the differences in place for the next attempt.
 */

export interface LabelSource {
	isComplete(): boolean
	baseLabels(): Map<string, string>
	listNumber(): number
	cacheEpoch(): number
}

export interface CueLabelsBody {
	mode: 'replace' | 'upsert'
	cueList: string
	cues: Array<{ number: string; label: string }>
}

/** HTTP status (0 = network failure or timeout), plus Retry-After seconds when the server sent one. */
export interface SendResult {
	status: number
	retryAfter?: number
	error?: string
}

export interface LabelSenderDeps {
	reader: () => LabelSource | null
	send: (body: CueLabelsBody) => Promise<SendResult>
	log: (level: 'info' | 'warn', msg: string) => void
	setStatus: (status: string) => void
}

export const DEBOUNCE_MS = 2000
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 5 * 60_000
const DEFAULT_RETRY_AFTER_S: Record<number, number> = { 429: 60, 503: 900 }
/** Answers that will not change by retrying: stop until the user (or a reconnect) says otherwise. */
const STOP_CODES = new Set([400, 401, 402, 403, 404, 410, 422])

export class LabelSender {
	private enabled = false
	/** Labels the server has confirmed; null = the next send is a full replace. */
	private lastSent: Map<string, string> | null = null
	private source: LabelSource | null = null
	private epoch = -1
	private inFlight = false
	/** A change arrived during a request: look again when it returns. */
	private dirty = false
	private debounceTimer: NodeJS.Timeout | null = null
	/** A pause (429/503) or a backoff (5xx/network) holding the next send. */
	private holdTimer: NodeJS.Timeout | null = null
	private stoppedCode: number | null = null
	private failures = 0
	/** Bumped on every reset: a response for older work is not applied. */
	private generation = 0
	private status = ''

	constructor(private readonly deps: LabelSenderDeps) {}

	/** Config saved: start over from a full replace, clearing any stop or pause. */
	configure(enabled: boolean): void {
		this.enabled = enabled
		this.clearTimers()
		this.stoppedCode = null
		this.failures = 0
		this.forgetSent()
		if (!enabled) {
			this.setStatus('off')
			return
		}
		this.onCacheChange()
	}

	/** Clear a stop or pause and look again (desk reconnected, or the station was just paired). */
	resume(): void {
		if (!this.enabled) return
		this.stoppedCode = null
		this.failures = 0
		this.clearHold()
		this.onCacheChange()
	}

	/** The Resend action: clear a stop or pause, and send everything again once the cache is complete. */
	resend(): void {
		if (!this.enabled) return
		this.stoppedCode = null
		this.failures = 0
		this.clearTimers()
		this.forgetSent()
		this.onCacheChange()
	}

	destroy(): void {
		this.enabled = false
		this.clearTimers()
		this.generation++
	}

	/** The reader's cache changed (or a different reader took over). */
	onCacheChange(): void {
		if (!this.enabled) return
		this.syncSource()
		if (this.stoppedCode !== null || this.holdTimer) return
		if (this.inFlight) {
			this.dirty = true
			return
		}
		if (this.lastSent === null) {
			this.work()
			return
		}
		// Debounce: the flush re-checks completeness when it fires.
		if (this.debounceTimer) clearTimeout(this.debounceTimer)
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null
			this.work()
		}, DEBOUNCE_MS)
	}

	/** A cleared cache (reconnect, another list, re-walk) or another reader: nothing sent so far applies. */
	private syncSource(): void {
		const src = this.deps.reader()
		const epoch = src?.cacheEpoch() ?? -1
		if (src === this.source && epoch === this.epoch) return
		this.source = src
		this.epoch = epoch
		if (this.debounceTimer) clearTimeout(this.debounceTimer)
		this.debounceTimer = null
		this.forgetSent()
	}

	private forgetSent(): void {
		this.lastSent = null
		this.dirty = false
		this.generation++
		if (this.enabled && this.stoppedCode === null && !this.holdTimer) this.setStatus('waiting for walk')
	}

	/** Send what is due now, if anything and if allowed. */
	private work(): void {
		if (!this.enabled || this.stoppedCode !== null || this.holdTimer) return
		if (this.inFlight) {
			this.dirty = true
			return
		}
		this.syncSource()
		const src = this.source
		if (!src || !src.isComplete()) {
			if (this.lastSent === null) this.setStatus('waiting for walk')
			return // a later cache change tries again
		}
		const now = src.baseLabels()
		const cueList = String(src.listNumber())
		if (this.lastSent === null) {
			if (now.size === 0) {
				this.setStatus('ok 0')
				return
			}
			const cues = [...now].map(([number, label]) => ({ number, label }))
			void this.post({ mode: 'replace', cueList, cues }, now)
			return
		}
		const cues: CueLabelsBody['cues'] = []
		for (const [number, label] of now) if (this.lastSent.get(number) !== label) cues.push({ number, label })
		for (const number of this.lastSent.keys()) if (!now.has(number)) cues.push({ number, label: '' })
		if (cues.length === 0) return
		void this.post({ mode: 'upsert', cueList, cues }, now)
	}

	private async post(body: CueLabelsBody, snapshot: Map<string, string>): Promise<void> {
		const gen = this.generation
		this.inFlight = true
		this.dirty = false
		this.setStatus('sending')
		let res: SendResult
		try {
			res = await this.deps.send(body)
		} catch {
			res = { status: 0 }
		}
		this.inFlight = false
		if (!this.enabled) return
		if (gen !== this.generation) {
			// Reset while this was out: its answer describes work nobody wants now.
			this.onCacheChange()
			return
		}
		const s = res.status
		if (s >= 200 && s < 300) {
			this.failures = 0
			this.lastSent = snapshot
			if (body.mode === 'replace') this.deps.log('info', `Cue labels: sent ${snapshot.size} to The Notes List`)
			this.setStatus(`ok ${snapshot.size}`)
			if (this.dirty) this.onCacheChange()
			return
		}
		if (res.error === 'not_paired') {
			// Expected before the station is paired: wait quietly; pairing calls resume().
			this.stoppedCode = s
			this.clearTimers()
			this.setStatus('waiting for pairing')
			return
		}
		if (STOP_CODES.has(s)) {
			this.stoppedCode = s
			this.clearTimers()
			const what = s === 422 ? ` (tried to send ${body.cues.length})` : ''
			this.deps.log(
				'warn',
				`Cue labels: The Notes List refused them with ${s}${res.error ? ` ${res.error}` : ''}${what}; stopped until the settings are saved, the desk reconnects, or "Resend cue labels" is pressed`,
			)
			this.setStatus(`stopped: ${s}`)
			return
		}
		if (s === 429 || s === 503) {
			const seconds = res.retryAfter && res.retryAfter > 0 ? res.retryAfter : DEFAULT_RETRY_AFTER_S[s]
			this.setStatus(s === 503 ? 'paused (server off)' : 'paused (too soon)')
			this.hold(seconds * 1000)
			return
		}
		// 5xx or no answer: back off 2 s, 4 s, … up to 5 min.
		this.failures++
		this.hold(Math.min(BACKOFF_MIN_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS))
	}

	private hold(ms: number): void {
		this.clearHold()
		this.holdTimer = setTimeout(() => {
			this.holdTimer = null
			this.work()
		}, ms)
	}

	private clearHold(): void {
		if (this.holdTimer) clearTimeout(this.holdTimer)
		this.holdTimer = null
	}

	private clearTimers(): void {
		this.clearHold()
		if (this.debounceTimer) clearTimeout(this.debounceTimer)
		this.debounceTimer = null
	}

	private setStatus(status: string): void {
		if (status === this.status) return
		this.status = status
		this.deps.setStatus(status)
	}
}
