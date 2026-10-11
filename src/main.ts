import { InstanceBase, InstanceStatus, runEntrypoint, type SomeCompanionConfigField } from '@companion-module/base'
import { ApiError, StationApi, type UiBody } from './api.js'
import { DEFAULT_BASE_URL, getConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { EosReader, type EosCue } from './eos.js'
import { MODULES, type ModuleId, type ModuleOptions } from './choices.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'

const COUNTS_INTERVAL_MS = 5000
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
	private pairing: { code: string; pollSecret: string; expiresAt: number } | null = null
	// Cue cursor (#907): the desk's list in sheet order, the live cue, and where
	// the operator has stepped to. Cursor index is relative to the reader's cache.
	private eos: EosReader | null = null
	/** host/SLIP/list the reader was started with; the reader restarts only when this changes. */
	private eosKey = ''
	private cueCount = 0
	private liveCue: string | null = null
	/** Sheet index the operator stepped to; null = follow live. */
	private cursorIndex: number | null = null

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		await this.configUpdated(config, secrets)
	}

	async destroy(): Promise<void> {
		this.generation++
		this.stopLoops()
		this.api?.abort()
		this.api = null
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
			this.updateStatus(InstanceStatus.BadConfig, urlProblem)
			this.setVariableValues({ connected: 'false' })
			this.checkFeedbacks('connected')
			return
		}
		if (this.config.baseUrl.startsWith('http:'))
			this.log('warn', 'Base URL uses http: the station token travels unencrypted. Use https unless testing locally.')
		const token = this.secrets.token || null
		this.api = new StationApi(this.config.baseUrl, token)

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
		this.loop(COUNTS_INTERVAL_MS, async () => this.refreshCounts())
		this.loop(ME_INTERVAL_MS, async () => {
			await this.refreshMe()
		})
		void this.refreshCounts()
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
		this.liveCue = null
		this.cursorIndex = null
		this.cueCount = 0
		this.eosConnected = false
		this.setVariableValues({
			eos_connected: 'false',
			cue_live: '',
			cue_live_label: '',
			selected_cue: '',
			selected_cue_label: '',
			selected_cue_offset: '0',
		})
		this.checkFeedbacks('eos_connected', 'selected_cue_off_live')
		if (!host) return
		this.eos = new EosReader(host, useSlip, cueList, {
			onStatus: (connected) => {
				this.eosConnected = connected
				this.setVariableValues({ eos_connected: connected ? 'true' : 'false' })
				this.checkFeedbacks('eos_connected')
			},
			onLive: (num) => {
				const changed = num !== this.liveCue
				// Measured against the PREVIOUS live cue, before it is replaced.
				const offset = this.cursorOffset()
				this.liveCue = num
				if (changed) {
					const c = this.eos?.findBase(num)
					this.log('info', `Live cue ${num}${c?.label ? ` ${c.label}` : ''}`)
					if (this.config.eosKeepOffset && this.cursorIndex !== null && c) {
						const max = this.cueCount > 0 ? this.cueCount - 1 : Number.MAX_SAFE_INTEGER
						this.cursorIndex = Math.max(0, Math.min(max, c.index + offset))
					} else {
						this.cursorIndex = null // follow live
					}
				}
				this.publishCursor()
			},
			onCache: (_cues, count) => {
				this.cueCount = count
				this.publishCursor()
			},
			log: (level, msg) => this.log(level, msg),
		})
		this.eos.start()
	}

	private liveIndex(): number | null {
		if (this.liveCue === null) return null
		return this.eos?.findBase(this.liveCue)?.index ?? null
	}

	/** Sheet index the cursor points at: stepped, else live. */
	private cursorPos(): number | null {
		return this.cursorIndex !== null ? this.cursorIndex : this.liveIndex()
	}

	cursorOffset(): number {
		const pos = this.cursorPos()
		const live = this.liveIndex()
		return pos === null || live === null ? 0 : pos - live
	}

	stepCursor(delta: number): void {
		const pos = this.cursorPos()
		if (pos === null) {
			this.log(
				'info',
				this.liveCue === null
					? 'Selected cue: the desk has not reported a live cue yet (fire a cue, or check the Eos connection).'
					: `Selected cue: live cue ${this.liveCue} is not in the cache yet (${this.eos?.cache().length ?? 0}/${this.cueCount} cached); try again in a moment.`,
			)
			return
		}
		if (this.cueCount <= 0) {
			this.log('info', 'Selected cue: the desk has not reported the size of the cue list yet; try again in a moment.')
			return
		}
		const max = this.cueCount - 1
		// Step over cue PARTS: they hold an index but are not a place a note lands.
		let next = Math.max(0, Math.min(max, pos + delta))
		while (next > 0 && next < max && this.eos?.cueAt(next)?.part) next += delta
		this.cursorIndex = next
		// Keep the window warm around wherever the cursor goes.
		this.eos?.ensureRange(next - 8, next + 8)
		const hit = this.eos?.cueAt(next)
		this.log('info', `Selected cue → ${hit ? `${hit.number} ${hit.label}`.trim() : `index ${next} (loading)`}`)
		this.publishCursor()
	}

	resetCursor(): void {
		this.cursorIndex = null
		this.publishCursor()
	}

	reloadCueList(): void {
		this.eos?.reloadList()
	}

	/** The cue a New note should land on: the cursor's cue if cached, else the live cue. */
	cursorCue(): EosCue | null {
		const pos = this.cursorPos()
		const hit = pos === null ? undefined : this.eos?.cueAt(pos)
		if (hit) return hit
		return this.liveCue !== null ? { number: this.liveCue, label: '', index: -1, part: 0 } : null
	}

	private publishCursor(): void {
		const c = this.cursorCue()
		const live = this.liveCue === null ? undefined : this.eos?.findBase(this.liveCue)
		this.setVariableValues({
			cue_live: this.liveCue ?? '',
			cue_live_label: live?.label ?? '',
			selected_cue: c?.number ?? '',
			selected_cue_label: c?.label ?? '',
			selected_cue_offset: String(this.cursorOffset()),
		})
		this.checkFeedbacks('selected_cue_off_live')
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
			} else if (!(e instanceof ApiError) && this.connected) {
				// No HTTP status: the network is down. Show it now, not at the next /me check.
				this.connected = false
				this.updateStatus(InstanceStatus.ConnectionFailure, describe(e))
				this.setVariableValues({ connected: 'false' })
				this.checkFeedbacks('connected')
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

	/** Run fn every ms, never overlapping: the next run is scheduled once the previous one has finished. */
	private loop(ms: number, fn: () => Promise<void>): void {
		const epoch = this.loopEpoch
		const schedule = () => {
			const t = setTimeout(() => {
				this.timers.delete(t)
				fn()
					.catch((e) => this.log('debug', `Poll failed: ${describe(e)}`))
					.finally(() => {
						if (epoch === this.loopEpoch) schedule()
					})
			}, ms)
			this.timers.add(t)
		}
		schedule()
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
