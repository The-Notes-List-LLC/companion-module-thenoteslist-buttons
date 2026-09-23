import {
  InstanceBase,
  InstanceStatus,
  combineRgb,
  runEntrypoint,
  type CompanionActionDefinitions,
  type CompanionFeedbackDefinitions,
  type CompanionPresetDefinitions,
  type CompanionVariableDefinition,
  type SomeCompanionConfigField,
} from '@companion-module/base'
import { randomUUID } from 'node:crypto'
import { StationApi, type ApiError } from './api.js'
import { DEFAULT_BASE_URL, getConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { EosReader } from './eos.js'
import { CueCursor } from './cursor.js'
import { ACTION_COLORS, MODULE_COLORS, N_PNG64_DARK, brandedStyle, keyStyle, tint } from './brand.js'

const MODULES = [
  { id: 'cue', label: 'Cue Notes' },
  { id: 'work', label: 'Work Notes' },
  { id: 'production', label: 'Production Notes' },
  { id: 'electrician', label: 'Electrician Notes' },
] as const
type ModuleId = (typeof MODULES)[number]['id']

type Opt = { value: string; label: string; color?: string }
type ModuleOptions = Record<ModuleId, { priorities: Opt[]; types: Opt[] }>
// Fallbacks until /me answers: the app's system defaults.
const FALLBACK_PRIORITIES: Opt[] = ['critical', 'very_high', 'high', 'medium_high', 'medium', 'medium_low', 'low', 'very_low', 'uncritical'].map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))
const STATUSES = [
  { id: 'complete', label: 'Complete' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'review', label: 'In Review (Work Notes only)' },
  { id: 'todo', label: 'Back to To Do' },
]

const COUNTS_INTERVAL_MS = 5000
const ME_INTERVAL_MS = 60000
const PAIR_POLL_MS = 3500 // server floor is 3000
const COUNTS_BACKOFF_MAX_MS = 30000

class NotesListInstance extends InstanceBase<ModuleConfig, ModuleSecrets> {
  private config!: ModuleConfig
  /** Station token from the secrets store; empty = not paired. */
  private token = ''
  private api!: StationApi
  private counts: Record<ModuleId, number> = { cue: 0, work: 0, production: 0, electrician: 0 }
  private connected = false
  private timers: Set<NodeJS.Timeout> = new Set()
  /**
   * Bumped by every configUpdated (and destroy). Loops and awaits started under
   * an older value stop themselves, so a re-save while a request is in flight
   * can never leave two sets of polling running.
   */
  private gen = 0
  /** The server refused this station (revoked, unpaid, gone): only /me keeps asking. */
  private authFailed = false
  private countsFailures = 0
  private pairing: { code: string; pollSecret: string; expiresAt: number } | null = null
  private options: ModuleOptions | null = null
  private optionsKey = ''
  // Cue cursor (#907): the desk's list (the reader is the CueSheet), the live
  // cue, and the cue the operator stepped to.
  private eos: EosReader | null = null
  /** Desk settings the running reader was started with. */
  private eosKey = ''
  /** The reader's socket is up and the desk is answering. */
  private eosConnected = false
  private liveCue: string | null = null
  private cursor = new CueCursor()

  async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
    // Never block init on the network: Companion gives init ~10 s and force-restarts
    // the module when the site is slow. Entities are defined synchronously inside.
    void this.configUpdated(config, secrets)
  }

  async destroy(): Promise<void> {
    this.gen++
    this.clearTimers()
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

  async configUpdated(config: ModuleConfig, secrets?: ModuleSecrets): Promise<void> {
    const gen = ++this.gen
    this.clearTimers()
    this.authFailed = false
    this.countsFailures = 0
    this.config = { ...config, baseUrl: config.baseUrl || DEFAULT_BASE_URL }
    this.token = secrets?.token || ''
    if (this.config.token) {
      // An install from before the secrets store: move the token out of the
      // plain config, where it appeared in config exports. The config token is
      // the one in use and wins: the secrets store can hold a stale value from
      // an older build (seen: a 6-character leftover that the server refused).
      this.token = this.config.token
      this.config = { ...this.config, token: '' }
      this.saveConfig(this.config, { ...secrets, token: this.token })
      this.log('info', 'Moved the station token into Companion\'s secrets store.')
    }
    this.api = new StationApi(this.config.baseUrl, this.token || null)
    this.defineEntities()
    this.startEos()

    if (this.config.startPairing || !this.token) {
      // A pairing already in flight (code not yet expired) survives a config
      // re-save: keep polling it instead of minting a new code.
      if (this.pairing && Date.now() < this.pairing.expiresAt) {
        this.updateStatus(InstanceStatus.Connecting, `PAIR CODE ${this.pairing.code} — enter it in the show's Settings → Button stations`)
        this.every(gen, () => PAIR_POLL_MS, () => this.pollPairing(), false)
        return
      }
      await this.beginPairing(gen)
      return
    }
    await this.refreshMe()
    if (gen !== this.gen) return
    this.every(gen, () => this.countsDelay(), () => this.refreshCounts(), true)
    this.every(gen, () => ME_INTERVAL_MS, () => this.refreshMe(), false)
  }

  /**
   * Run `fn` (now, or after the first delay) and again `delay()` after each run
   * FINISHES, so a slow server can never pile requests up. Stops when the
   * session changes or `fn` returns 'stop'.
   */
  private every(gen: number, delay: () => number, fn: () => Promise<void | 'stop'>, now: boolean): void {
    const schedule = (ms: number) => {
      const t = setTimeout(() => {
        this.timers.delete(t)
        void tick()
      }, ms)
      this.timers.add(t)
    }
    const tick = async () => {
      if (gen !== this.gen) return
      const r = await fn().catch((e) => this.log('debug', `poll failed: ${describe(e)}`))
      if (gen !== this.gen || r === 'stop') return
      schedule(delay())
    }
    if (now) void tick()
    else schedule(delay())
  }

  // ---------------------------------------------------------------- pairing
  private async beginPairing(gen: number): Promise<void> {
    try {
      // A saved token means a previous station: revoke it so it does not linger
      // as an "Active" station nobody holds. Best effort.
      if (this.token) {
        await this.api.revokeSelf().catch(() => undefined)
        if (gen !== this.gen) return
        this.api.setToken(null)
        this.token = ''
        this.saveConfig(undefined, { token: '' })
      }
      const start = await this.api.pairStart()
      // Superseded by a newer configUpdated while we waited: that one owns pairing now.
      if (gen !== this.gen) return
      this.pairing = { code: start.code, pollSecret: start.pollSecret, expiresAt: Date.parse(start.expiresAt) }
      this.updateStatus(InstanceStatus.Connecting, `PAIR CODE ${start.code} — enter it in the show's Settings → Button stations`)
      this.setVariableValues({ pairing_code: start.code })
      // Push the code into the stored config so an OPEN settings window shows it.
      // Companion does not call configUpdated for this save; a user re-save does,
      // and configUpdated keeps the in-flight pairing (see the guard there).
      this.config = { ...this.config, pairingCode: start.code }
      this.saveConfig(this.config, undefined)
      this.log('warn', `PAIRING CODE: ${start.code}  →  The Notes List → the show → Settings → Button stations. Expires in 10 minutes. (Also in variable $(${this.label}:pairing_code).)`)
      this.every(gen, () => PAIR_POLL_MS, () => this.pollPairing(), false)
    } catch (e) {
      if (gen !== this.gen) return
      const err = e as ApiError
      const msg = err.status === 429
        ? 'Too many pairings started from this network. Wait a few minutes, then untick and re-tick "Start pairing".'
        : describe(e)
      this.updateStatus(InstanceStatus.ConnectionFailure, msg)
      this.log('error', `Pairing could not start: ${msg}`)
    }
  }

  /** One poll of the pairing; the caller runs it again only after this one finishes, so polls never overlap. */
  private async pollPairing(): Promise<void | 'stop'> {
    if (!this.pairing) return 'stop'
    if (Date.now() > this.pairing.expiresAt) {
      this.pairing = null
      this.updateStatus(InstanceStatus.Disconnected, 'Pairing code expired — tick "Start pairing" again')
      return 'stop'
    }
    try {
      const res = await this.api.pairPoll(this.pairing.code, this.pairing.pollSecret)
      // A token is kept even if the config changed meanwhile: the server has
      // already handed it over, and dropping it would strand the station.
      if (res.token) {
        this.pairing = null
        this.setVariableValues({ pairing_code: '' })
        // The token goes to the secrets store: never exported, never sent to the web UI.
        const next: ModuleConfig = {
          ...this.config,
          startPairing: false,
          pairingCode: '',
          stationName: res.station?.name ?? '',
          productionName: res.station?.productionName ?? '',
        }
        const secrets: ModuleSecrets = { token: res.token }
        this.saveConfig(next, secrets)
        this.log('info', `Paired as "${res.station?.name}" on ${res.station?.productionName ?? 'production'}.`)
        // Companion does NOT call configUpdated for a module's own saveConfig
        // (it saves with skipNotifyConnection), so start the paired session here.
        await this.configUpdated(next, secrets)
        return 'stop'
      }
    } catch (e) {
      const err = e as ApiError
      if (err.status === 429) return // slow down: just wait for the next tick
      if (err.status === 410 || err.status === 409 || err.status === 404) {
        this.pairing = null
        this.updateStatus(InstanceStatus.Disconnected, `Pairing ended: ${err.message}`)
        return 'stop'
      }
    }
  }

  // ---------------------------------------------------------------- Eos cue cursor
  private startEos(): void {
    const host = (this.config.eosHost || '').trim()
    // Only the desk settings matter here: a re-save for anything else (pairing,
    // base URL) must not drop the connection and re-walk the whole cue list.
    const key = JSON.stringify([host, !!this.config.eosUseSlip, Number(this.config.eosCueList) || 1])
    if (this.eos && key === this.eosKey) return
    this.eosKey = key
    this.eos?.stop()
    this.eos = null
    this.setEosConnected(false)
    if (!host) return
    this.eos = new EosReader(host, !!this.config.eosUseSlip, Number(this.config.eosCueList) || 1, {
      onStatus: (connected, message) => {
        this.log('debug', `Eos status: ${connected ? 'connected' : 'disconnected'} (${message})`)
        this.setEosConnected(connected)
      },
      onLive: (num) => {
        if (num !== this.liveCue) {
          const label = this.eos?.labelOf(num) ?? ''
          this.log('info', `Live cue ${num}${label ? ` ${label}` : ''}`)
          if (this.eos) this.cursor.liveMoved(this.liveCue, num, this.eos, !!this.config.eosKeepOffset)
        }
        this.liveCue = num
        this.publishCursor()
      },
      onCache: () => this.publishCursor(),
      log: (level, msg) => this.log(level, msg),
    })
    this.eos.start()
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
    this.checkFeedbacks('eos_connected', 'selected_cue_on_live')
  }

  private stepCursor(delta: number): void {
    const eos = this.eos
    if (!eos) return this.log('info', 'Selected cue: no Eos desk configured.')
    const r = this.cursor.step(delta, eos, this.liveCue)
    if (!r.ok) {
      if (r.reason === 'no-live') this.log('info', 'Selected cue: the desk has not reported a live cue yet (fire a cue, or check the Eos connection).')
      else {
        // Fetch what is missing on the way; the next press will get through. (A
        // start cue without an index is already being asked for by number.)
        if (r.index !== undefined) eos.ensureRange(r.index - 8, r.index + 8)
        this.log('info', `Selected cue: the cues around ${this.cursor.target(this.liveCue)} are still loading; try again in a moment.`)
      }
      return
    }
    // Keep the window warm around wherever the cursor goes.
    eos.ensureRange(r.cue.index - 8, r.cue.index + 8)
    this.log('info', `Selected cue → ${`${r.cue.number} ${r.cue.label}`.trim()}`)
    this.publishCursor()
  }

  private resetCursor(): void {
    this.cursor.reset()
    this.publishCursor()
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
      cue_live_label: this.liveCue === null ? '' : this.eos?.labelOf(this.liveCue) ?? '',
      selected_cue: c?.number ?? '',
      selected_cue_label: c?.label ?? '',
      // One 14 px line holds ~7 capitals. Clip to that, with hyphens and spaces
      // as no-break spaces (Companion wraps at both), so a long label is cut on
      // one line, never wrapped onto a second that pushes the text into the N.
      selected_cue_label_short: (c?.label ?? '').toUpperCase().replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').slice(0, 7).trim().replace(/ /g, '\u00a0'),
      // Base cues from live (parts not counted); ? while that stretch is still loading.
      selected_cue_offset: offset === null ? '?' : String(offset),
    })
    this.checkFeedbacks('selected_cue_off_live', 'selected_cue_on_live')
  }

  // ---------------------------------------------------------------- polling
  private async refreshMe(): Promise<void> {
    try {
      const me = await this.api.me()
      this.connected = true
      this.authFailed = false
      this.updateStatus(InstanceStatus.Ok, `${me.station.name} · ${me.production.name ?? ''}`)
      this.setVariableValues({ station_name: me.station.name, production_name: me.production.name ?? '', connected: 'true' })
      // The show's real, renamable types and priorities feed the action dropdowns.
      if (me.options) {
        const key = JSON.stringify(me.options)
        if (key !== this.optionsKey) {
          this.optionsKey = key
          this.options = me.options as ModuleOptions
          this.defineEntities()
        }
      }
    } catch (e) {
      this.connected = false
      const err = e as ApiError
      this.authFailed = isAuthError(err)
      const status = err.status === 401 ? InstanceStatus.BadConfig : InstanceStatus.ConnectionFailure
      this.updateStatus(status, err.status === 401 ? 'Not paired — tick "Start pairing"' : describe(e))
      this.setVariableValues({ connected: 'false' })
    }
    this.checkFeedbacks('connected')
  }

  /** 5 s normally; doubles per failure up to 30 s so an outage is not hammered. */
  private countsDelay(): number {
    return Math.min(COUNTS_INTERVAL_MS * 2 ** this.countsFailures, COUNTS_BACKOFF_MAX_MS)
  }

  private async refreshCounts(): Promise<void> {
    // Refused by the server: only the /me loop keeps asking until that changes.
    if (this.authFailed) return
    try {
      const c = await this.api.counts()
      this.countsFailures = 0
      for (const m of MODULES) this.counts[m.id] = c[m.id]?.outstanding ?? 0
      this.setVariableValues({
        cue_outstanding: this.counts.cue,
        work_outstanding: this.counts.work,
        production_outstanding: this.counts.production,
        electrician_outstanding: this.counts.electrician,
      })
      this.checkFeedbacks('outstanding_above')
      if (!this.connected) void this.refreshMe()
    } catch (e) {
      const err = e as ApiError
      if (isAuthError(err)) {
        void this.refreshMe()
        return
      }
      // Network trouble or a server error. One miss can be a blip; from the
      // second, say so and blank the counts rather than show stale numbers.
      this.countsFailures++
      if (this.countsFailures === 2) {
        this.log('warn', `Outstanding counts unavailable: ${describe(e)}`)
        this.connected = false
        this.updateStatus(InstanceStatus.ConnectionFailure, describe(e))
        for (const m of MODULES) this.counts[m.id] = 0
        this.setVariableValues({ connected: 'false', cue_outstanding: '', work_outstanding: '', production_outstanding: '', electrician_outstanding: '' })
        this.checkFeedbacks('connected', 'outstanding_above')
      }
    }
  }

  // -------------------------------------------------------------- entities
  private defineEntities(): void {
    const cueDefault = `$(${this.label}:selected_cue)`
    const cueOption = {
      type: 'textinput' as const,
      id: 'cueNumber',
      label: 'Cue number (blank = none)',
      default: cueDefault,
      useVariables: true,
      tooltip: `Resolved when you press. Default is the cue cursor ($(${this.label}:selected_cue)): the live cue unless you stepped it with the Selected cue ◀ / ▶ keys. $(${this.label}:cue_live) is always the live cue. Any other variable or a typed number also works.`,
    }
    const actions: CompanionActionDefinitions = {
      open_note_editor: {
        name: 'New note (opens the editor in your tab)',
        description: 'Opens the Add Note dialog in your browser tab on this module page, prefilled with the type, priority and cue number below. Your tab must be open on that page.',
        options: [
          { type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) },
          ...perModuleChoices('type', 'Type', (m) => this.options?.[m]?.types ?? [], ''),
          ...perModuleChoices('priority', 'Priority', (m) => this.options?.[m]?.priorities ?? FALLBACK_PRIORITIES, 'medium'),
          cueOption,
        ],
        callback: async (event, context) => {
          const mod = String(event.options.module) as ModuleId
          let cueNumber: string | undefined = (await context.parseVariablesInString(String(event.options.cueNumber ?? ''))).trim() || undefined
          if (!cueNumber || cueNumber === '$NA') cueNumber = this.cursorCue()?.number
          // Not awaited: a slow round-trip must not hold Companion's action
          // timeout (it logs "Call timed out" after 10 s); ui() logs the result.
          void this.ui({
            command: 'open_note_editor',
            module: mod,
            cueNumber,
            type: String(event.options[`type_${mod}`] ?? '') || undefined,
            priority: String(event.options[`priority_${mod}`] ?? '') || undefined,
          })
        },
      },
      selected_cue_prev: {
        name: 'Selected cue ◀ (one cue earlier)',
        description: 'Moves the selected cue one earlier in the desk\'s list without touching the console. New note lands on the selected cue.',
        options: [],
        callback: async () => this.stepCursor(-1),
      },
      selected_cue_next: {
        name: 'Selected cue ▶ (one cue later)',
        options: [],
        callback: async () => this.stepCursor(1),
      },
      eos_reload_list: {
        name: 'Eos: reload the cue list (after edits on the desk)',
        options: [],
        callback: async () => this.eos?.reloadList(),
      },
      selected_cue_live: {
        name: 'Selected cue = live (follow the running cue again)',
        options: [],
        callback: async () => this.resetCursor(),
      },
      tab_next_note: {
        name: 'Highlight next note',
        description: 'Moves the highlight down one row in your open tab on this module page.',
        options: [{ type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => void this.ui({ command: 'next_note', module: String(event.options.module) }),
      },
      tab_prev_note: {
        name: 'Highlight previous note',
        options: [{ type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => void this.ui({ command: 'prev_note', module: String(event.options.module) }),
      },
      tab_set_highlighted_status: {
        name: 'Set status of highlighted note',
        options: [
          { type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) },
          { type: 'dropdown', id: 'status', label: 'Status', default: 'complete', choices: STATUSES },
        ],
        callback: async (event) => void this.ui({ command: 'set_highlighted_status', module: String(event.options.module), status: String(event.options.status) }),
      },
      tab_undo: {
        name: 'Undo',
        options: [{ type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => void this.ui({ command: 'undo', module: String(event.options.module) }),
      },
      tab_redo: {
        name: 'Redo',
        options: [{ type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => void this.ui({ command: 'redo', module: String(event.options.module) }),
      },
      tab_jump_module: {
        name: 'Go to module',
        description: 'Navigates your open tab on this production to the chosen module.',
        options: [{ type: 'dropdown', id: 'module', label: 'Go to', default: 'work', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => void this.ui({ command: 'jump_module', module: String(event.options.module) }),
      },
    }

    const feedbacks: CompanionFeedbackDefinitions = {
      outstanding_above: {
        type: 'boolean',
        name: 'Outstanding count above threshold',
        defaultStyle: { bgcolor: combineRgb(220, 38, 38), color: combineRgb(255, 255, 255) },
        options: [
          { type: 'dropdown', id: 'module', label: 'Module', default: 'work', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) },
          { type: 'number', id: 'threshold', label: 'More than', default: 0, min: 0, max: 9999 },
        ],
        callback: (fb) => this.counts[fb.options.module as ModuleId] > Number(fb.options.threshold ?? 0),
      },
      type_color: {
        type: 'advanced',
        name: 'Colour key by note type (matches the chip in the app)',
        options: [
          { type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) },
          ...perModuleChoices('type', 'Type', (m) => this.options?.[m]?.types ?? [], ''),
        ],
        callback: (fb) => {
          const mod = fb.options.module as ModuleId
          const opt = (this.options?.[mod]?.types ?? []).find((t) => t.value === fb.options[`type_${mod}`])
          return opt?.color ? keyStyle(opt.color) : {}
        },
      },
      priority_color: {
        type: 'advanced',
        name: 'Colour key by priority (matches the chip in the app)',
        options: [
          { type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) },
          ...perModuleChoices('priority', 'Priority', (m) => this.options?.[m]?.priorities ?? FALLBACK_PRIORITIES, 'medium'),
        ],
        callback: (fb) => {
          const mod = fb.options.module as ModuleId
          const opt = (this.options?.[mod]?.priorities ?? []).find((p) => p.value === fb.options[`priority_${mod}`])
          return opt?.color ? keyStyle(opt.color) : {}
        },
      },
      selected_cue_off_live: {
        type: 'boolean',
        name: 'Selected cue is not the live cue',
        defaultStyle: { bgcolor: combineRgb(245, 158, 11), color: combineRgb(0, 0, 0) },
        options: [],
        callback: () => this.cursor.selected !== null,
      },
      selected_cue_on_live: {
        type: 'boolean',
        name: 'Selected cue is the live cue (desk connected)',
        defaultStyle: { bgcolor: combineRgb(0, 70, 0), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => this.eosConnected && this.liveCue !== null && this.cursor.selected === null,
      },
      eos_connected: {
        type: 'boolean',
        name: 'Eos desk connected (read-only reader)',
        defaultStyle: { bgcolor: combineRgb(22, 163, 74), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => this.eosConnected,
      },
      connected: {
        type: 'boolean',
        name: 'Connected',
        defaultStyle: { bgcolor: combineRgb(22, 163, 74), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => this.connected,
      },
    }

    const variables: CompanionVariableDefinition[] = [
      { variableId: 'cue_outstanding', name: 'Cue Notes outstanding' },
      { variableId: 'work_outstanding', name: 'Work Notes outstanding' },
      { variableId: 'production_outstanding', name: 'Production Notes outstanding' },
      { variableId: 'electrician_outstanding', name: 'Electrician Notes outstanding' },
      { variableId: 'station_name', name: 'Station name' },
      { variableId: 'production_name', name: 'Production name' },
      { variableId: 'connected', name: 'Connected (true/false)' },
      { variableId: 'pairing_code', name: 'Pairing code while pairing is in progress (put it on a button)' },
      { variableId: 'cue_live', name: 'Eos: live cue number (our read-only reader)' },
      { variableId: 'cue_live_label', name: 'Eos: label of the live cue' },
      { variableId: 'selected_cue', name: 'Selected cue: the cue the next note lands on (live unless you stepped)' },
      { variableId: 'selected_cue_label', name: 'Selected cue label' },
      { variableId: 'selected_cue_label_short', name: 'Selected cue label, first 7 characters (fits a key face)' },
      { variableId: 'selected_cue_offset', name: 'Selected cue offset from live (0 = live)' },
      { variableId: 'eos_connected', name: 'Eos desk connected (true/false)' },
    ]

    this.setActionDefinitions(actions)
    this.setFeedbackDefinitions(feedbacks)
    this.setVariableDefinitions(variables)
    this.setPresetDefinitions(this.buildPresets())
  }

  /**
   * Ready-made keys in the house look (N top-left, two lines on the bottom edge):
   *  1 Selected cue: ◀ / ▶ / = live and a display key
   *  2 New note · <Module>: one per type of THIS show, coloured like the chip
   *  3 Highlighted note · <Module>: colour says what the key does
   *  4 Go to module: module colour, with that module's open count
   * Companion lists categories alphabetically; the numbers put the tech-time
   * keys first.
   */
  private buildPresets(): CompanionPresetDefinitions {
    const presets: CompanionPresetDefinitions = {}
    const L = this.label
    const cueVar = `$(${L}:selected_cue)`
    // Key faces have room for ~5 letters beside the N. Known types get the
    // abbreviation the booth already uses; multi-word customs become initials;
    // anything else is clipped to 5 letters.
    const ABBR: Record<string, string> = {
      cue: 'CUE', director: 'DIR', choreographer: 'CHOR', designer: 'DSGN', stage_manager: 'SM', associate: 'ASSOC',
      assistant: 'ASST', spot: 'SPOT', programmer: 'PROG', production: 'PROD', paperwork: 'PAPER', think: 'THINK',
      work: 'WORK', lighting: 'LX', focus: 'FOCUS', electrics: 'ELEC', rigging: 'RIG', sound: 'SND', scenic: 'SET', props: 'PROPS',
      costume: 'COS', costumes: 'COS', wardrobe: 'WARD', directing: 'DIR', direction: 'DIR', electric: 'ELEC', electrical: 'ELEC', electrician: 'ELEC', electricians: 'ELEC',
      video: 'VID', projection: 'PROJ', projections: 'PROJ', automation: 'AUTO', followspot: 'SPOT', music: 'MUS', musical: 'MUS',
      choreography: 'CHOR', dance: 'DNC', puppetry: 'PUP', wigs: 'WIGS', deck: 'DECK', fly: 'FLY', flys: 'FLY',
    }
    const short = (value: string, label: string) => {
      const words = label.trim().split(/\s+/)
      const key = words.length === 1 ? words[0].toLowerCase() : ''
      if (ABBR[value]) return ABBR[value]
      if (key && ABBR[key]) return ABBR[key]
      if (words.length > 1) return words.map((w) => w[0]).join('').toUpperCase()
      return label.toUpperCase().slice(0, 5)
    }

    for (const m of MODULES) {
      const types = this.options?.[m.id]?.types ?? []
      for (const t of types) {
        // "ADD / SM": the type is the word that tells keys apart, so no "NOTE"
        // filler. One size for every ADD key so a row of them lines up.
        const abbr = short(t.value, t.label)
        presets[`new_${m.id}_${t.value}`] = {
          type: 'button',
          category: `2 · New note · ${m.label}`,
          name: `${t.label} (${m.label})`,
          style: brandedStyle(`ADD\n${abbr}`, t.color ?? MODULE_COLORS[m.id]),
          steps: [{ down: [{ actionId: 'open_note_editor', options: { module: m.id, [`type_${m.id}`]: t.value, [`priority_${m.id}`]: 'medium', cueNumber: cueVar } }], up: [] }],
          feedbacks: [],
        }
      }
      presets[`goto_${m.id}`] = {
        type: 'button',
        category: '4 · Go to module',
        name: `Go to ${m.label}`,
        // Module colour and the module's open count ("WORK / 3 OPEN").
        style: brandedStyle(`${({ cue: 'CUE', work: 'WORK', production: 'PROD', electrician: 'ELEC' } as Record<string, string>)[m.id]}\n$(${L}:${m.id}_outstanding) OPEN`, MODULE_COLORS[m.id]),
        steps: [{ down: [{ actionId: 'tab_jump_module', options: { module: m.id } }], up: [] }],
        feedbacks: [],
      }
    }

    // Working the list in the open tab. Colour says what a key DOES: green
    // completes, red cancels, slate sends to review. Everything else is a dark
    // key whose text carries the module colour, so a NEXT for Work still reads
    // as Work and nothing looks like a status change that is not one.
    for (const m of MODULES) {
      const cat = `3 · Highlighted note · ${m.label}`
      const mod = tint(MODULE_COLORS[m.id], 0.4) // module colour, lifted so it reads on the dark key
      const key = (id: string, name: string, face: string, bg: string, text: string | undefined, actionId: string, options: Record<string, string>) => {
        presets[`${id}_${m.id}`] = { type: 'button', category: cat, name: `${name} (${m.label})`, style: brandedStyle(face, bg, 18, text), steps: [{ down: [{ actionId, options }], up: [] }], feedbacks: [] }
      }
      const { done, cancel, review, neutral } = ACTION_COLORS
      key('next', 'Highlight next note', 'NEXT\nNOTE', neutral, mod, 'tab_next_note', { module: m.id })
      key('prev', 'Highlight previous note', 'PREV\nNOTE', neutral, mod, 'tab_prev_note', { module: m.id })
      key('done', 'Mark highlighted note complete', 'SET\nDONE', done, undefined, 'tab_set_highlighted_status', { module: m.id, status: 'complete' })
      key('cancel', 'Mark highlighted note cancelled', 'SET\nCANCL', cancel, undefined, 'tab_set_highlighted_status', { module: m.id, status: 'cancelled' })
      if (m.id === 'work') key('review', 'Mark highlighted note in review', 'SET\nREVW', review, undefined, 'tab_set_highlighted_status', { module: m.id, status: 'review' })
      key('todo', 'Highlighted note back to To Do', 'SET\nTO DO', neutral, mod, 'tab_set_highlighted_status', { module: m.id, status: 'todo' })
      key('undo', 'Undo', 'UNDO', neutral, mod, 'tab_undo', { module: m.id })
      key('redo', 'Redo', 'REDO', neutral, mod, 'tab_redo', { module: m.id })
    }

    // Selected-cue keys follow the same grammar: one short word, one number, the
    // N in the corner. Dark keys; amber while the selection is off the live cue.
    // Fixed 18 px: with 'auto' an empty cue line (no desk yet) lets the lone word
    // inflate and break mid-word ("LIV / E").
    const dark = ACTION_COLORS.neutral
    const sel = '1 · Selected cue'
    const amber = { bgcolor: combineRgb(245, 158, 11), color: combineRgb(0, 0, 0), png64: N_PNG64_DARK }
    const offLive = { feedbackId: 'selected_cue_off_live', options: {}, style: amber }
    // LIVE is green only while the selection IS the live cue; stepped away it
    // stays dark (the ◀ / ▶ keys go amber). Without a desk it says so in grey.
    const onLive = { feedbackId: 'selected_cue_on_live', options: {}, style: { bgcolor: combineRgb(0, 70, 0), color: combineRgb(255, 255, 255) } }
    const noDesk = { feedbackId: 'eos_connected', options: {}, isInverted: true, style: { text: 'NO\nDESK', color: combineRgb(128, 128, 128) } }
    presets.selected_prev = { type: 'button', category: sel, name: 'Selected cue ◀', style: brandedStyle(`◀ CUE\n${cueVar}`, dark), steps: [{ down: [{ actionId: 'selected_cue_prev', options: {} }], up: [] }], feedbacks: [offLive] }
    presets.selected_next = { type: 'button', category: sel, name: 'Selected cue ▶', style: brandedStyle(`CUE ▶\n${cueVar}`, dark), steps: [{ down: [{ actionId: 'selected_cue_next', options: {} }], up: [] }], feedbacks: [offLive] }
    presets.selected_live = { type: 'button', category: sel, name: 'Selected cue = live', style: brandedStyle(`LIVE\n$(${L}:cue_live)`, dark), steps: [{ down: [{ actionId: 'selected_cue_live', options: {} }], up: [] }], feedbacks: [onLive, noDesk] }
    presets.display_selected = { type: 'button', category: sel, name: 'Display: selected cue (number and label)', style: brandedStyle(`NOTE\n${cueVar}\n$(${L}:selected_cue_label_short)`, '#000000', 14), steps: [{ down: [], up: [] }], feedbacks: [offLive] }
    return presets
  }

  private async ui(body: { command: string; module: string; status?: string; cueNumber?: string; type?: string; priority?: string }): Promise<void> {
    try {
      const res = (await this.api.ui(body)) as { prefill?: Record<string, string> }
      this.log('info', `${body.command} → sent ${JSON.stringify(body)} · server broadcast ${JSON.stringify(res.prefill ?? {})}`)
    } catch (e) {
      this.log('warn', `${body.command} failed: ${describe(e)}`)
    }
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }
}

/**
 * One dropdown per module for a field whose choices differ by module, shown only
 * when that module is selected. Companion cannot make one dropdown's choices
 * depend on another option, so this is the idiom.
 */
function perModuleChoices(
  field: 'priority' | 'type',
  label: string,
  choicesFor: (m: ModuleId) => Opt[],
  fallbackDefault: string,
) {
  return MODULES.map((m) => {
    const opts = choicesFor(m.id)
    const choices = field === 'type' ? [{ id: '', label: '(none)' }, ...opts.map((o) => ({ id: o.value, label: o.label }))] : opts.map((o) => ({ id: o.value, label: o.label }))
    // Type defaults to the module's FIRST real type (e.g. Cue), not '(none)':
    // a fresh key should land a typed note without a visit to the dropdown.
    const firstReal = choices.find((c) => c.id !== '')?.id ?? ''
    const def = choices.some((c) => c.id === fallbackDefault && c.id !== '') ? fallbackDefault : firstReal
    return {
      type: 'dropdown' as const,
      id: `${field}_${m.id}`,
      label: `${label} (${m.label})`,
      default: def,
      choices,
      isVisible: (options: Record<string, unknown>, data: { module: string }) => options.module === data.module,
      isVisibleData: { module: m.id },
    }
  })
}

/** The station itself is refused (not a network problem): revoked, unpaid, production gone. */
function isAuthError(err: Partial<ApiError>): boolean {
  return err?.status === 401 || err?.status === 402 || err?.status === 403 || err?.status === 410
}

function describe(e: unknown): string {
  const err = e as Partial<ApiError> & { message?: string }
  return err?.message ?? String(e)
}

runEntrypoint(NotesListInstance, [])
