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
import { DEFAULT_BASE_URL, getConfigFields, type ModuleConfig } from './config.js'
import { EosReader, type EosCue } from './eos.js'

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

class NotesListInstance extends InstanceBase<ModuleConfig> {
  private config!: ModuleConfig
  private api!: StationApi
  private counts: Record<ModuleId, number> = { cue: 0, work: 0, production: 0, electrician: 0 }
  private connected = false
  private timers: NodeJS.Timeout[] = []
  private pairing: { code: string; pollSecret: string; expiresAt: number } | null = null
  private options: ModuleOptions | null = null
  private optionsKey = ''
  // Cue cursor (#907): the desk's list in sheet order, the live cue, and where
  // the operator has stepped to. Cursor index is relative to `cues`.
  private eos: EosReader | null = null
  private cues: EosCue[] = []
  private liveCue: string | null = null
  private cursorIndex: number | null = null

  async init(config: ModuleConfig): Promise<void> {
    await this.configUpdated(config)
  }

  async destroy(): Promise<void> {
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

  async configUpdated(config: ModuleConfig): Promise<void> {
    this.clearTimers()
    this.config = { ...config, baseUrl: config.baseUrl || DEFAULT_BASE_URL }
    this.api = new StationApi(this.config.baseUrl, this.config.token || null)
    this.defineEntities()
    this.startEos()

    if (this.config.startPairing || !this.config.token) {
      // A pairing already in flight (code not yet expired) survives a config
      // re-save: keep polling it instead of minting a new code.
      if (this.pairing && Date.now() < this.pairing.expiresAt) {
        this.updateStatus(InstanceStatus.Connecting, `PAIR CODE ${this.pairing.code} — enter it in the show's Settings → Button stations`)
        this.timers.push(setInterval(() => void this.pollPairing(), PAIR_POLL_MS))
        return
      }
      await this.beginPairing()
      return
    }
    await this.refreshMe()
    this.timers.push(setInterval(() => void this.refreshCounts(), COUNTS_INTERVAL_MS))
    this.timers.push(setInterval(() => void this.refreshMe(), ME_INTERVAL_MS))
    void this.refreshCounts()
  }

  // ---------------------------------------------------------------- pairing
  private async beginPairing(): Promise<void> {
    try {
      // A saved token means a previous station: revoke it so it does not linger
      // as an "Active" station nobody holds. Best effort.
      if (this.config.token) {
        await this.api.revokeSelf().catch(() => undefined)
        this.api.setToken(null)
      }
      const start = await this.api.pairStart()
      this.pairing = { code: start.code, pollSecret: start.pollSecret, expiresAt: Date.parse(start.expiresAt) }
      this.updateStatus(InstanceStatus.Connecting, `PAIR CODE ${start.code} — enter it in the show's Settings → Button stations`)
      this.setVariableValues({ pairing_code: start.code })
      // Push the code into the stored config so an OPEN settings window shows it.
      // configUpdated keeps the in-flight pairing (see the guard there).
      this.config = { ...this.config, pairingCode: start.code }
      this.saveConfig(this.config)
      this.log('warn', `PAIRING CODE: ${start.code}  →  The Notes List → the show → Settings → Button stations. Expires in 10 minutes. (Also in variable $(thenoteslist:pairing_code).)`)
      this.timers.push(setInterval(() => void this.pollPairing(), PAIR_POLL_MS))
    } catch (e) {
      const err = e as ApiError
      const msg = err.status === 429
        ? 'Too many pairings started from this network. Wait a few minutes, then untick and re-tick "Start pairing".'
        : describe(e)
      this.updateStatus(InstanceStatus.ConnectionFailure, msg)
      this.log('error', `Pairing could not start: ${msg}`)
    }
  }

  private async pollPairing(): Promise<void> {
    if (!this.pairing) return
    if (Date.now() > this.pairing.expiresAt) {
      this.pairing = null
      this.clearTimers()
      this.updateStatus(InstanceStatus.Disconnected, 'Pairing code expired — tick "Start pairing" again')
      return
    }
    try {
      const res = await this.api.pairPoll(this.pairing.code, this.pairing.pollSecret)
      if (res.token) {
        this.pairing = null
        this.clearTimers()
        this.setVariableValues({ pairing_code: '' })
        // Persist the token; the config form shows it as a secret and never in full.
        this.saveConfig({
          ...this.config,
          startPairing: false,
          pairingCode: '',
          token: res.token,
          stationName: res.station?.name ?? '',
          productionName: res.station?.productionName ?? '',
        })
        this.log('info', `Paired as "${res.station?.name}" on ${res.station?.productionName ?? 'production'}.`)
        // Companion calls configUpdated with the saved config next.
      }
    } catch (e) {
      const err = e as ApiError
      if (err.status === 429) return // slow down: just wait for the next tick
      if (err.status === 410 || err.status === 409 || err.status === 404) {
        this.pairing = null
        this.clearTimers()
        this.updateStatus(InstanceStatus.Disconnected, `Pairing ended: ${err.message}`)
      }
    }
  }

  // ---------------------------------------------------------------- Eos cue cursor
  private startEos(): void {
    this.eos?.stop()
    this.eos = null
    const host = (this.config.eosHost || '').trim()
    if (!host) {
      this.setVariableValues({ eos_connected: 'false', cue_live: '', cue_cursor: '', cue_cursor_label: '', cue_cursor_offset: '0' })
      return
    }
    this.eos = new EosReader(host, !!this.config.eosUseSlip, Number(this.config.eosCueList) || 1, {
      onStatus: (connected) => {
        this.setVariableValues({ eos_connected: connected ? 'true' : 'false' })
        this.checkFeedbacks('eos_connected')
      },
      onLive: (num) => {
        const changed = num !== this.liveCue
        this.liveCue = num
        if (changed) {
          if (this.config.eosKeepOffset && this.cursorIndex !== null) {
            const liveIdx = this.cues.findIndex((c) => c.number === num)
            const offset = this.cursorOffset()
            this.cursorIndex = liveIdx >= 0 ? clamp(liveIdx + offset, this.cues.length) : null
          } else {
            this.cursorIndex = null // follow live
          }
        }
        this.publishCursor()
      },
      onList: (cues) => {
        this.cues = cues
        this.cursorIndex = null
        this.log('info', `Eos: cached ${cues.length} cues of list ${this.config.eosCueList || 1}`)
        this.publishCursor()
      },
      log: (level, msg) => this.log(level, msg),
    })
    this.eos.start()
  }

  /** Where the cursor points: an explicit index, else the live cue's index. */
  private cursorPos(): number | null {
    if (this.cursorIndex !== null) return this.cursorIndex
    if (this.liveCue === null) return null
    const i = this.cues.findIndex((c) => c.number === this.liveCue)
    return i >= 0 ? i : null
  }

  private cursorOffset(): number {
    const pos = this.cursorPos()
    const live = this.liveCue === null ? -1 : this.cues.findIndex((c) => c.number === this.liveCue)
    return pos === null || live < 0 ? 0 : pos - live
  }

  private stepCursor(delta: number): void {
    if (this.cues.length === 0) return
    const pos = this.cursorPos()
    const next = pos === null ? (delta > 0 ? 0 : this.cues.length - 1) : clamp(pos + delta, this.cues.length)
    this.cursorIndex = next
    this.publishCursor()
  }

  private resetCursor(): void {
    this.cursorIndex = null
    this.publishCursor()
  }

  /** The cue a New note should land on: the cursor if the desk is connected, else the live cue. */
  cursorCue(): EosCue | null {
    const pos = this.cursorPos()
    if (pos !== null && this.cues[pos]) return this.cues[pos]
    return this.liveCue !== null ? { number: this.liveCue, label: '' } : null
  }

  private publishCursor(): void {
    const c = this.cursorCue()
    const live = this.liveCue === null ? null : this.cues.find((x) => x.number === this.liveCue)
    this.setVariableValues({
      cue_live: this.liveCue ?? '',
      cue_live_label: live?.label ?? '',
      cue_cursor: c?.number ?? '',
      cue_cursor_label: c?.label ?? '',
      cue_cursor_offset: String(this.cursorOffset()),
    })
    this.checkFeedbacks('cursor_off_live')
  }

  // ---------------------------------------------------------------- polling
  private async refreshMe(): Promise<void> {
    try {
      const me = await this.api.me()
      this.connected = true
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
      const status = err.status === 401 ? InstanceStatus.BadConfig : InstanceStatus.ConnectionFailure
      this.updateStatus(status, err.status === 401 ? 'Not paired — tick "Start pairing"' : describe(e))
      this.setVariableValues({ connected: 'false' })
    }
    this.checkFeedbacks('connected')
  }

  private async refreshCounts(): Promise<void> {
    try {
      const c = await this.api.counts()
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
      if (err.status === 401 || err.status === 402 || err.status === 403 || err.status === 410) void this.refreshMe()
    }
  }

  // -------------------------------------------------------------- entities
  private defineEntities(): void {
    const cueDefault = '$(thenoteslist:cue_cursor)'
    const cueOption = {
      type: 'textinput' as const,
      id: 'cueNumber',
      label: 'Cue number (blank = none)',
      default: cueDefault,
      useVariables: true,
      tooltip: 'Resolved when you press. Default is the cue cursor ($(thenoteslist:cue_cursor)): the live cue unless you stepped it with the Cue ◀ / ▶ keys. $(thenoteslist:cue_live) is always the live cue. Any other variable or a typed number also works.',
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
          const cueNumber = (await context.parseVariablesInString(String(event.options.cueNumber ?? ''))).trim() || undefined
          await this.ui({
            command: 'open_note_editor',
            module: mod,
            cueNumber,
            type: String(event.options[`type_${mod}`] ?? '') || undefined,
            priority: String(event.options[`priority_${mod}`] ?? '') || undefined,
          })
        },
      },
      cue_cursor_prev: {
        name: 'Cue ◀ (step the note cue back one)',
        description: 'Moves the cue cursor one cue earlier in the desk\'s list without touching the console. New note lands on the cursor.',
        options: [],
        callback: async () => this.stepCursor(-1),
      },
      cue_cursor_next: {
        name: 'Cue ▶ (step the note cue forward one)',
        options: [],
        callback: async () => this.stepCursor(1),
      },
      cue_cursor_reset: {
        name: 'Cue = live (snap the cursor back to the running cue)',
        options: [],
        callback: async () => this.resetCursor(),
      },
      tab_next_note: {
        name: 'Highlight next note',
        description: 'Moves the highlight down one row in your open tab on this module page.',
        options: [{ type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => this.ui({ command: 'next_note', module: String(event.options.module) }),
      },
      tab_prev_note: {
        name: 'Highlight previous note',
        options: [{ type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => this.ui({ command: 'prev_note', module: String(event.options.module) }),
      },
      tab_set_highlighted_status: {
        name: 'Set status of highlighted note',
        options: [
          { type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) },
          { type: 'dropdown', id: 'status', label: 'Status', default: 'complete', choices: STATUSES },
        ],
        callback: async (event) => this.ui({ command: 'set_highlighted_status', module: String(event.options.module), status: String(event.options.status) }),
      },
      tab_undo: {
        name: 'Undo',
        options: [{ type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => this.ui({ command: 'undo', module: String(event.options.module) }),
      },
      tab_redo: {
        name: 'Redo',
        options: [{ type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => this.ui({ command: 'redo', module: String(event.options.module) }),
      },
      tab_jump_module: {
        name: 'Go to module',
        description: 'Navigates your open tab on this production to the chosen module.',
        options: [{ type: 'dropdown', id: 'module', label: 'Go to', default: 'work', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => this.ui({ command: 'jump_module', module: String(event.options.module) }),
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
      cursor_off_live: {
        type: 'boolean',
        name: 'Cue cursor is NOT on the live cue',
        defaultStyle: { bgcolor: combineRgb(245, 158, 11), color: combineRgb(0, 0, 0) },
        options: [],
        callback: () => this.cursorOffset() !== 0,
      },
      eos_connected: {
        type: 'boolean',
        name: 'Eos desk connected (read-only reader)',
        defaultStyle: { bgcolor: combineRgb(22, 163, 74), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => (this.eos ? this.cues.length > 0 || this.liveCue !== null : false),
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
      { variableId: 'cue_cursor', name: 'Eos: cue the next note lands on (live, or where you stepped)' },
      { variableId: 'cue_cursor_label', name: 'Eos: label of the cursor cue' },
      { variableId: 'cue_cursor_offset', name: 'Eos: cursor offset from live (0 = live)' },
      { variableId: 'eos_connected', name: 'Eos desk connected (true/false)' },
    ]

    this.setActionDefinitions(actions)
    this.setFeedbackDefinitions(feedbacks)
    this.setVariableDefinitions(variables)
    this.setPresetDefinitions(this.buildPresets())
  }

  /**
   * One ready-made key per module × type from THIS show: the New note action
   * with that type, the matching chip colour, and the live cue on the face.
   */
  private buildPresets(): CompanionPresetDefinitions {
    const presets: CompanionPresetDefinitions = {}
    const cueVar = '$(thenoteslist:cue_cursor)'
    {
      presets.cue_prev = { type: 'button', category: 'Cue cursor', name: 'Cue ◀', style: { text: '◀ CUE\n$(thenoteslist:cue_cursor)', size: 'auto', bgcolor: combineRgb(30, 30, 30), color: combineRgb(255, 255, 255) }, steps: [{ down: [{ actionId: 'cue_cursor_prev', options: {} }], up: [] }], feedbacks: [{ feedbackId: 'cursor_off_live', options: {} }] }
      presets.cue_next = { type: 'button', category: 'Cue cursor', name: 'Cue ▶', style: { text: 'CUE ▶\n$(thenoteslist:cue_cursor)', size: 'auto', bgcolor: combineRgb(30, 30, 30), color: combineRgb(255, 255, 255) }, steps: [{ down: [{ actionId: 'cue_cursor_next', options: {} }], up: [] }], feedbacks: [{ feedbackId: 'cursor_off_live', options: {} }] }
      // Display-only keys: no action, just the numbers, large.
      presets.display_live = { type: 'button', category: 'Cue cursor', name: 'Display: live cue', style: { text: 'LIVE\n$(thenoteslist:cue_live)\n$(thenoteslist:cue_live_label)', size: 'auto', bgcolor: combineRgb(0, 0, 0), color: combineRgb(255, 255, 255) }, steps: [{ down: [], up: [] }], feedbacks: [{ feedbackId: 'eos_connected', options: {}, style: { color: combineRgb(255, 255, 255), bgcolor: combineRgb(0, 70, 0) } }] }
      presets.display_cursor = { type: 'button', category: 'Cue cursor', name: 'Display: note cue (cursor)', style: { text: 'NOTE CUE\n$(thenoteslist:cue_cursor)\n$(thenoteslist:cue_cursor_label)', size: 'auto', bgcolor: combineRgb(0, 0, 0), color: combineRgb(255, 255, 255) }, steps: [{ down: [], up: [] }], feedbacks: [{ feedbackId: 'cursor_off_live', options: {} }] }
      presets.cue_reset = { type: 'button', category: 'Cue cursor', name: 'Cue = live', style: { text: 'LIVE\n$(thenoteslist:cue_live)', size: 'auto', bgcolor: combineRgb(30, 30, 30), color: combineRgb(255, 255, 255) }, steps: [{ down: [{ actionId: 'cue_cursor_reset', options: {} }], up: [] }], feedbacks: [{ feedbackId: 'eos_connected', options: {} }] }
    }
    for (const m of MODULES) {
      const types = this.options?.[m.id]?.types ?? []
      for (const t of types) {
        const style = t.color ? keyStyle(t.color) : { bgcolor: combineRgb(40, 40, 40), color: combineRgb(255, 255, 255) }
        presets[`new_${m.id}_${t.value}`] = {
          type: 'button',
          category: `New note · ${m.label}`,
          name: `${t.label} (${m.label})`,
          style: { text: `${t.label}\n${cueVar}`, size: 'auto', ...style },
          steps: [
            {
              down: [
                {
                  actionId: 'open_note_editor',
                  options: { module: m.id, [`type_${m.id}`]: t.value, [`priority_${m.id}`]: 'medium', cueNumber: cueVar },
                },
              ],
              up: [],
            },
          ],
          feedbacks: [{ feedbackId: 'type_color', options: { module: m.id, [`type_${m.id}`]: t.value } }],
        }
      }
    }
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
    for (const t of this.timers) clearInterval(t)
    this.timers = []
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

/** Background = the chip colour; text white or black by luminance so it stays readable. */
function keyStyle(hex: string): { bgcolor: number; color: number } {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16)
  if ([r, g, b].some((n) => Number.isNaN(n))) return { bgcolor: combineRgb(40, 40, 40), color: combineRgb(255, 255, 255) }
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return { bgcolor: combineRgb(r, g, b), color: luminance > 0.6 ? combineRgb(0, 0, 0) : combineRgb(255, 255, 255) }
}

function clamp(i: number, len: number): number {
  return Math.max(0, Math.min(len - 1, i))
}

function describe(e: unknown): string {
  const err = e as Partial<ApiError> & { message?: string }
  return err?.message ?? String(e)
}

runEntrypoint(NotesListInstance, [])
