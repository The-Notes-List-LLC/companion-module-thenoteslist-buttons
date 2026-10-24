import { InstanceBase, InstanceStatus, runEntrypoint, type SomeCompanionConfigField } from '@companion-module/base'
import { ApiError, StationApi, type UiBody } from './api.js'
import { DEFAULT_BASE_URL, getConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { CueCursor } from './cursor.js'
import { EosReader } from './eos.js'
import { LabelSender } from './labels.js'
import { MODULES, type ModuleId, type ModuleOptions } from './choices.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'

const COUNTS_INTERVAL_MS = 5000
const COUNTS_BACKOFF_MAX_MS = 30000 // while the server is unreachable: 5, 10, 20, 30, 30 … s
const ME_INTERVAL_MS = 60000
const PAIR_POLL_MS = 3500 // server floor is 3000
const PAIR_TTL_MS = 10 * 60000 // used when the server's expiresAt cannot be parsed

export class NotesListInstance extends InstanceBase<ModuleConfig, ModuleSecrets> {
	config!: ModuleConfig
	private secrets: ModuleSecrets = {}
	private api: StationApi | null = null
	counts: Record<ModuleId, number> = { cue: 0, work: 0, production: 0, electrician: 0 }
	connected = false
	eosConnected = false
	/** The show's types and priorities, from /me. */
	options: ModuleOptions | null = null
	private optionsKey = ''
	/** Bumped by configUpdated() and destroy(): an async path that finds it changed after an await drops out. */
	private generation = 0
	/** Bumped by stopLoops(): a loop from an earlier epoch does not schedule its next run. */
	private loopEpoch = 0
	private timers: Set<NodeJS.Timeout> = new Set()
	/** Counts polls failed in a row (network or server error); drives the backoff. */
	private countsFailures = 0
	private pairing: { code: string; pollSecret: string; expiresAt: number } | null = null
	// Cue cursor (#907): the desk's list (the reader is the CueSheet), the live
	// cue, and the cue number the operator has stepped to.
	private eos: EosReader | null = null
	/** host/SLIP/list the reader was started with; the reader restarts only when this changes. */
	private eosKey = ''
	private liveCue: string | null = null
	private cursor = new CueCursor()
	/** Desk cue labels → the paired show (#1162). Reads the Eos reader's cache; one request at a time. */
	private labels = new LabelSender({
		reader: () => this.eos,
		send: async (body) => {
			const api = this.api
			if (!api) return { status: 401, error: 'not_paired' }
			try {
				await api.putCueLabels(body)
				return { status: 200 }
			} catch (e) {
				const err = e as Partial<ApiError>
				return { status: err.status ?? 0, retryAfter: err.retryAfter, error: err.error }
			}
		},
		log: (level, msg) => this.log(level, msg),
		setStatus: (status) => this.setVariableValues({ cue_labels_status: status }),
	})

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		// Never block init on the network: Companion gives init about 10 s and restarts
		// the module when the site is slow. Entities are defined before the first await.
		this.configUpdated(config, secrets).catch((e) => this.log('error', `Startup failed: ${describe(e)}`))
	}

	async destroy(): Promise<void> {
		this.generation++
		this.stopLoops()
		this.api?.abort()
		this.api = null
		this.labels.destroy()
		this.eos?.stop()
		this.eos = null
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return getConfigFields({
			code: this.pairing && Date.now() < this.pairing.expiresAt ? this.pairing.code : null,
			expiresAt: this.pairing?.expiresAt ?? null,
			stationName: this.config?.stationName ?? '',
			productionName: this.config?.productionName ?? '',
			connected: this.connected,
		})
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		this.generation++
		this.stopLoops()
		this.api?.abort()
		this.api = null
		this.config = { ...config, baseUrl: (config.baseUrl || DEFAULT_BASE_URL).trim() }
		this.secrets = { ...secrets }
		this.updateEntities()
		this.startEos()

		const urlProblem = checkBaseUrl(this.config.baseUrl)
		if (urlProblem) {
			this.connected = false
			// No server to send to: a walked desk shows "stopped: 401" until the URL is fixed.
			this.labels.configure(this.config.sendCueLabels !== false)
			this.updateStatus(InstanceStatus.BadConfig, urlProblem)
			this.setVariableValues({ connected: 'false' })
			this.checkFeedbacks('connected')
			return
		}
		if (this.config.baseUrl.startsWith('http:'))
			this.log('warn', 'Base URL uses http: the station token travels unencrypted. Use https unless testing locally.')
		const token = this.secrets.token || null
		this.api = new StationApi(this.config.baseUrl, token)
		// Every save starts the labels over from a full replace (and clears a stop).
		this.labels.configure(this.config.sendCueLabels !== false)

		if (this.config.startPairing || !token) {
			// A pairing already in flight (code not yet expired) survives a config
			// re-save: keep polling it instead of minting a new code.
			if (this.pairing && Date.now() < this.pairing.expiresAt) {
				this.updateStatus(
					InstanceStatus.Connecting,
					`PAIR CODE ${this.pairing.code} — enter it in the show's Settings → Button stations`,
				)
				this.loop(PAIR_POLL_MS, async () => this.pollPairing())
				return
			}
			await this.beginPairing()
			return
		}
		await this.startPolling()
	}

	updateEntities(): void {
		UpdateActions(this)
		UpdateFeedbacks(this)
		UpdateVariableDefinitions(this)
		UpdatePresets(this)
	}

	private async startPolling(): Promise<void> {
		const gen = this.generation
		this.updateStatus(InstanceStatus.Connecting)
		const paired = await this.refreshMe()
		if (gen !== this.generation || !paired) return
		// Just paired (saveConfig does not call configUpdated back): a "not paired" stop no longer applies.
		this.labels.resume()
		this.countsFailures = 0
		// The first counts poll runs now, inside the loop, so it can never overlap the next.
		this.loop(
			() => Math.min(COUNTS_INTERVAL_MS * 2 ** this.countsFailures, COUNTS_BACKOFF_MAX_MS),
			async () => this.refreshCounts(),
			true,
		)
		this.loop(ME_INTERVAL_MS, async () => {
			await this.refreshMe()
		})
	}

	// ---------------------------------------------------------------- pairing
	private async beginPairing(): Promise<void> {
		const api = this.api
		if (!api) return
		const gen = this.generation
		try {
			// A saved token means a previous station: revoke it so it does not linger
			// as an "Active" station nobody holds. Best effort.
			if (this.secrets.token) {
				await api.revokeSelf().catch(() => undefined)
				if (gen !== this.generation) return
				api.setToken(null)
				this.secrets = { ...this.secrets, token: '' }
				this.saveConfig(this.config, this.secrets)
			}
			const start = await api.pairStart()
			if (gen !== this.generation) return
			const expiresAt = Date.parse(start.expiresAt)
			this.pairing = {
				code: start.code,
				pollSecret: start.pollSecret,
				expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + PAIR_TTL_MS,
			}
			this.updateStatus(
				InstanceStatus.Connecting,
				`PAIR CODE ${start.code} — enter it in the show's Settings → Button stations`,
			)
			this.setVariableValues({ pairing_code: start.code })
			// Push the code into the stored config so an OPEN settings window shows it.
			// configUpdated keeps the in-flight pairing (see the guard there).
			this.config = { ...this.config, pairingCode: start.code }
			this.saveConfig(this.config, undefined)
			this.log(
				'warn',
				`PAIRING CODE: ${start.code}  →  The Notes List → the show → Settings → Button stations. Expires in 10 minutes. (Also in variable $(${this.label}:pairing_code).)`,
			)
			this.loop(PAIR_POLL_MS, async () => this.pollPairing())
		} catch (e) {
			if (gen !== this.generation) return
			const err = e as ApiError
			const msg =
				err.status === 429
					? 'Too many pairings started from this network. Wait a few minutes, then untick and re-tick "Start pairing".'
					: describe(e)
			this.updateStatus(InstanceStatus.ConnectionFailure, msg)
			this.log('error', `Pairing could not start: ${msg}`)
		}
	}

	private async pollPairing(): Promise<void> {
		const pairing = this.pairing
		const api = this.api
		if (!pairing || !api) return
		if (Date.now() > pairing.expiresAt) {
			this.pairing = null
			this.stopLoops()
			this.updateStatus(InstanceStatus.Disconnected, 'Pairing code expired — tick "Start pairing" again')
			return
		}
		const gen = this.generation
		try {
			const res = await api.pairPoll(pairing.code, pairing.pollSecret)
			if (gen !== this.generation || this.pairing !== pairing) return
			if (res.token) {
				this.pairing = null
				this.stopLoops()
				this.setVariableValues({ pairing_code: '' })
				// The token goes into Companion's secrets store, which is kept out of exports.
				this.config = {
					...this.config,
					startPairing: false,
					pairingCode: '',
					stationName: res.station?.name ?? '',
					productionName: res.station?.productionName ?? '',
				}
				this.secrets = { ...this.secrets, token: res.token }
				this.saveConfig(this.config, this.secrets)
				this.log('info', `Paired as "${res.station?.name}" on ${res.station?.productionName ?? 'production'}.`)
				// saveConfig does not call configUpdated back, so go live on the new token here.
				api.setToken(res.token)
				await this.startPolling()
			}
		} catch (e) {
			if (gen !== this.generation || this.pairing !== pairing) return
			const err = e as ApiError
			if (err.status === 429) return // slow down: just wait for the next tick
			if (err.status === 410 || err.status === 409 || err.status === 404) {
				this.pairing = null
				this.stopLoops()
				this.updateStatus(InstanceStatus.Disconnected, `Pairing ended: ${err.message}`)
				return
			}
			this.log('debug', `Pairing check failed: ${describe(e)}`)
		}
	}

	// ---------------------------------------------------------------- Eos cue cursor
	private startEos(): void {
		const host = (this.config.eosHost || '').trim()
		const useSlip = !!this.config.eosUseSlip
		const cueList = Number(this.config.eosCueList) || 1
		const key = JSON.stringify([host, useSlip, cueList])
		// Saving unrelated settings (or the save after pairing) keeps the desk connection.
		if (key === this.eosKey) return
		this.eosKey = key
		this.eos?.stop()
		this.eos = null
		// A different desk or list: nothing from the old one applies.
		this.setEosConnected(false)
		if (!host) return
		this.eos = new EosReader(host, useSlip, cueList, {
			onStatus: (connected, message) => {
				this.log('debug', `Eos status: ${connected ? 'connected' : 'disconnected'} (${message})`)
				this.setEosConnected(connected)
				// A reconnect clears the cache (full replace once walked) and lifts a stop.
				if (connected) this.labels.resume()
			},
			onLive: (num) => {
				if (num !== this.liveCue) {
					const label = this.eos?.labelOf(num) ?? ''
					this.log('info', `Live cue ${num}${label ? ` ${label}` : ''}`)
					// Keep cursor offset is measured against the OLD live cue, before it moves.
					if (this.eos) this.cursor.liveMoved(this.liveCue, num, this.eos, !!this.config.eosKeepOffset)
				}
				this.liveCue = num
				this.publishCursor()
			},
			onCache: () => {
				this.publishCursor()
				this.labels.onCacheChange()
			},
			log: (level, msg) => this.log(level, msg),
		})
		this.eos.start()
		// Another desk or list: the sender starts over against the new reader.
		this.labels.onCacheChange()
	}

	/**
	 * One flag drives the variable and every desk feedback. Losing the desk also
	 * forgets the live cue and the cursor: a blank cue is safer than a frozen one
	 * that notes would quietly land on. The desk resends its live cue on reconnect.
	 */
	private setEosConnected(connected: boolean): void {
		this.eosConnected = connected
		if (!connected) {
			this.liveCue = null
			this.cursor.reset()
		}
		this.setVariableValues({ eos_connected: connected ? 'true' : 'false' })
		this.publishCursor()
		this.checkFeedbacks('eos_connected')
	}

	/** The selected cue is a stepped cue, not following live. */
	isOffLive(): boolean {
		return this.cursor.selected !== null
	}

	/** Following the live cue of a connected desk. */
	isOnLive(): boolean {
		return this.eosConnected && this.liveCue !== null && this.cursor.selected === null
	}

	stepCursor(delta: number): void {
		const eos = this.eos
		if (!eos) return this.log('info', 'Selected cue: no Eos desk configured.')
		const r = this.cursor.step(delta, eos, this.liveCue)
		if (!r.ok) {
			if (r.reason === 'no-live')
				this.log(
					'info',
					'Selected cue: the desk has not reported a live cue yet (fire a cue, or check the Eos connection).',
				)
			else {
				// Fetch what is missing on the way; the next press gets through. (A start
				// cue without an index is already being asked for by number.)
				if (r.index !== undefined) eos.ensureRange(r.index - 8, r.index + 8)
				this.log(
					'info',
					`Selected cue: the cues around ${this.cursor.target(this.liveCue)} are still loading; try again in a moment.`,
				)
			}
			return
		}
		// Keep the window warm around wherever the cursor goes.
		eos.ensureRange(r.cue.index - 8, r.cue.index + 8)
		this.log('info', `Selected cue → ${`${r.cue.number} ${r.cue.label}`.trim()}`)
		this.publishCursor()
	}

	resetCursor(): void {
		this.cursor.reset()
		this.publishCursor()
	}

	reloadCueList(): void {
		this.eos?.reloadList()
	}

	resendCueLabels(): void {
		this.labels.resend()
	}

	/** The cue a New note lands on: the stepped cue, else the live cue. Always a cue number, never a guess. */
	cursorCue(): { number: string; label: string } | null {
		const number = this.cursor.target(this.liveCue)
		return number === null ? null : { number, label: this.eos?.labelOf(number) ?? '' }
	}

	private publishCursor(): void {
		const c = this.cursorCue()
		const offset = this.eos ? this.cursor.offset(this.eos, this.liveCue) : 0
		this.setVariableValues({
			cue_live: this.liveCue ?? '',
			cue_live_label: this.liveCue === null ? '' : (this.eos?.labelOf(this.liveCue) ?? ''),
			selected_cue: c?.number ?? '',
			selected_cue_label: c?.label ?? '',
			// One 14 px line holds ~7 capitals. Clip to that, with hyphens and spaces as
			// no-break spaces (Companion wraps at both), so a long label is cut on one
			// line, never wrapped onto a second that pushes the text into the N.
			selected_cue_label_short: (c?.label ?? '')
				.toUpperCase()
				.replace(/\s*-\s*/g, ' ')
				.replace(/\s+/g, ' ')
				.slice(0, 7)
				.trim()
				.replace(/ /g, '\u00a0'),
			// Base cues from live (parts not counted); ? while that stretch is still loading.
			selected_cue_offset: offset === null ? '?' : String(offset),
		})
		this.checkFeedbacks('selected_cue_off_live', 'selected_cue_on_live')
	}

	// ---------------------------------------------------------------- polling
	/** Returns false when the server no longer knows this station (polling then stops until the next pairing). */
	private async refreshMe(): Promise<boolean> {
		const api = this.api
		if (!api) return false
		const gen = this.generation
		let paired = true
		try {
			const me = await api.me()
			if (gen !== this.generation) return false
			this.connected = true
			this.updateStatus(InstanceStatus.Ok, `${me.station.name} · ${me.production.name ?? ''}`)
			this.setVariableValues({
				station_name: me.station.name,
				production_name: me.production.name ?? '',
				connected: 'true',
			})
			// The show's real, renamable types and priorities feed the action dropdowns.
			if (me.options) {
				const key = JSON.stringify(me.options)
				if (key !== this.optionsKey) {
					this.optionsKey = key
					this.options = me.options
					this.updateEntities()
				}
			}
		} catch (e) {
			if (gen !== this.generation) return false
			this.connected = false
			const err = e as ApiError
			if (err.status === 401) {
				// Station revoked or never paired: stop calling the server until the user pairs again.
				paired = false
				this.stopLoops()
				this.updateStatus(InstanceStatus.BadConfig, 'Not paired — tick "Start pairing"')
				// Keys must not keep showing the revoked station's counts.
				for (const m of MODULES) this.counts[m.id] = 0
				this.setVariableValues({
					station_name: '',
					production_name: '',
					cue_outstanding: '',
					work_outstanding: '',
					production_outstanding: '',
					electrician_outstanding: '',
				})
				this.checkFeedbacks('outstanding_above')
			} else {
				this.updateStatus(InstanceStatus.ConnectionFailure, describe(e))
			}
			this.setVariableValues({ connected: 'false' })
		}
		this.checkFeedbacks('connected')
		return paired
	}

	private async refreshCounts(): Promise<void> {
		const api = this.api
		if (!api) return
		const gen = this.generation
		try {
			const c = await api.counts()
			if (gen !== this.generation) return
			this.countsFailures = 0
			for (const m of MODULES) this.counts[m.id] = c[m.id]?.outstanding ?? 0
			this.setVariableValues({
				cue_outstanding: this.counts.cue,
				work_outstanding: this.counts.work,
				production_outstanding: this.counts.production,
				electrician_outstanding: this.counts.electrician,
			})
			this.checkFeedbacks('outstanding_above')
			if (!this.connected) await this.refreshMe()
		} catch (e) {
			if (gen !== this.generation) return
			const err = e as ApiError
			if (err.status === 401 || err.status === 402 || err.status === 403 || err.status === 410) {
				await this.refreshMe()
				return
			}
			// Network trouble or a server error. One miss can be a blip; from the second,
			// say so now (not at the next /me check) and blank the counts rather than
			// show stale numbers. The loop backs off while this lasts.
			this.countsFailures++
			if (this.countsFailures === 2) {
				this.log('warn', `Outstanding counts unavailable: ${describe(e)}`)
				this.connected = false
				this.updateStatus(InstanceStatus.ConnectionFailure, describe(e))
				for (const m of MODULES) this.counts[m.id] = 0
				this.setVariableValues({
					connected: 'false',
					cue_outstanding: '',
					work_outstanding: '',
					production_outstanding: '',
					electrician_outstanding: '',
				})
				this.checkFeedbacks('connected', 'outstanding_above')
			}
		}
	}

	async ui(body: UiBody): Promise<void> {
		const api = this.api
		if (!api) {
			this.log('warn', `${body.command} failed: not connected`)
			return
		}
		try {
			const res = await api.ui(body)
			this.log(
				'info',
				`${body.command} → sent ${JSON.stringify(body)} · server broadcast ${JSON.stringify(res.prefill ?? {})}`,
			)
		} catch (e) {
			this.log('warn', `${body.command} failed: ${describe(e)}`)
		}
	}

	/** Run fn every `delay` ms (now first, if asked), never overlapping: the next run is scheduled once the previous one has finished. */
	private loop(delay: number | (() => number), fn: () => Promise<void>, now = false): void {
		const epoch = this.loopEpoch
		const run = (): void => {
			fn()
				.catch((e) => this.log('debug', `Poll failed: ${describe(e)}`))
				.finally(() => {
					if (epoch === this.loopEpoch) schedule()
				})
		}
		const schedule = (): void => {
			const t = setTimeout(
				() => {
					this.timers.delete(t)
					run()
				},
				typeof delay === 'number' ? delay : delay(),
			)
			this.timers.add(t)
		}
		if (now) run()
		else schedule()
	}

	private stopLoops(): void {
		this.loopEpoch++
		for (const t of this.timers) clearTimeout(t)
		this.timers.clear()
	}
}

/** Why the Base URL is unusable, or null when it is fine. */
function checkBaseUrl(baseUrl: string): string | null {
	try {
		const u = new URL(baseUrl)
		return u.protocol === 'https:' || u.protocol === 'http:'
			? null
			: `Base URL must start with https:// (got ${u.protocol})`
	} catch {
		return `Base URL "${baseUrl}" is not a valid URL`
	}
}

function describe(e: unknown): string {
	const err = e as { message?: string; cause?: { message?: string; code?: string } }
	// fetch reports network failures as "fetch failed" with the real reason in `cause`.
	const cause = err?.cause?.code ?? err?.cause?.message
	return err?.message ? (cause ? `${err.message} (${cause})` : err.message) : String(e)
}

runEntrypoint(NotesListInstance, UpgradeScripts)
