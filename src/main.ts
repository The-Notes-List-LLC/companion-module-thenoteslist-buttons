import {
  InstanceBase,
  InstanceStatus,
  combineRgb,
  runEntrypoint,
  type CompanionActionDefinitions,
  type CompanionFeedbackDefinitions,
  type CompanionVariableDefinition,
  type SomeCompanionConfigField,
} from '@companion-module/base'
import { randomUUID } from 'node:crypto'
import { StationApi, type ApiError } from './api.js'
import { DEFAULT_BASE_URL, getConfigFields, type ModuleConfig } from './config.js'

const MODULES = [
  { id: 'cue', label: 'Cue Notes' },
  { id: 'work', label: 'Work Notes' },
  { id: 'production', label: 'Production Notes' },
  { id: 'electrician', label: 'Electrician Notes' },
] as const
type ModuleId = (typeof MODULES)[number]['id']

const PRIORITIES = ['critical', 'very_high', 'high', 'medium_high', 'medium', 'medium_low', 'low', 'very_low', 'uncritical']
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

  async init(config: ModuleConfig): Promise<void> {
    await this.configUpdated(config)
  }

  async destroy(): Promise<void> {
    this.clearTimers()
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

  // ---------------------------------------------------------------- polling
  private async refreshMe(): Promise<void> {
    try {
      const me = await this.api.me()
      this.connected = true
      this.updateStatus(InstanceStatus.Ok, `${me.station.name} · ${me.production.name ?? ''}`)
      this.setVariableValues({ station_name: me.station.name, production_name: me.production.name ?? '', connected: 'true' })
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
    const label = (this.config?.consoleLabel || 'eos').trim()
    const cueDefault = `$(${label}:cue_active_num)`
    const cueOption = {
      type: 'textinput' as const,
      id: 'cueNumber',
      label: 'Cue number (blank = none)',
      default: cueDefault,
      useVariables: true,
      tooltip: `Resolved when you press. Default is the console's live cue via the ${label} connection; use $(${label}:cue_pending_num) for the next cue, or type a number.`,
    }
    const actions: CompanionActionDefinitions = {
      create_note: {
        name: 'Create note',
        options: [
          { type: 'dropdown', id: 'module', label: 'Module', default: 'work', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) },
          { type: 'textinput', id: 'description', label: 'Text', default: '', useVariables: true },
          { type: 'dropdown', id: 'priority', label: 'Priority', default: 'medium', choices: PRIORITIES.map((p) => ({ id: p, label: p.replace('_', ' ') })) },
          { type: 'textinput', id: 'type', label: 'Type (value, optional)', default: '' },
          cueOption,
        ],
        callback: async (event, context) => {
          const description = await context.parseVariablesInString(String(event.options.description ?? ''))
          const cueNumber = (await context.parseVariablesInString(String(event.options.cueNumber ?? ''))).trim() || undefined
          // One id per PRESS: a retry after a dropped response replays the same note
          // instead of creating a twin (server answers 200 replayed:true).
          const body = {
            id: randomUUID(),
            module: String(event.options.module),
            description,
            cueNumber,
            priority: String(event.options.priority),
            type: String(event.options.type ?? '') || undefined,
          }
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const res = await this.api.createNote(body)
              this.setVariableValues({ last_note_status: res.note.status })
              for (const [k, v] of Object.entries(res.coerced ?? {})) {
                this.log('warn', `Create note: ${k} "${String((body as Record<string, unknown>)[k])}" is not available on this production; wrote ${v ?? 'none'}. Fix the button.`)
              }
              void this.refreshCounts()
              return
            } catch (e) {
              const err = e as ApiError
              // Only a transport failure (no HTTP status) is worth one retry with the same id.
              if (err.status !== undefined || attempt === 1) {
                this.log('warn', `Create note failed: ${describe(e)}`)
                return
              }
            }
          }
        },
      },
      open_note_editor: {
        name: 'Open the new-note editor in my open tab',
        description: 'Opens the Add Note dialog in your browser tab that is on this module page (cue number field focused on Cue Notes). Needs that tab open.',
        options: [
          { type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) },
          cueOption,
        ],
        callback: async (event, context) => {
          try {
            const cueNumber = (await context.parseVariablesInString(String(event.options.cueNumber ?? ''))).trim() || undefined
            await this.api.openNoteEditor(String(event.options.module), cueNumber)
          } catch (e) {
            this.log('warn', `Open editor failed: ${describe(e)}`)
          }
        },
      },
      tab_next_note: {
        name: 'Tab: highlight next note',
        description: 'Moves the highlight down one row in your open tab on this module page.',
        options: [{ type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => this.ui({ command: 'next_note', module: String(event.options.module) }),
      },
      tab_prev_note: {
        name: 'Tab: highlight previous note',
        options: [{ type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => this.ui({ command: 'prev_note', module: String(event.options.module) }),
      },
      tab_set_highlighted_status: {
        name: 'Tab: set status of the highlighted note',
        options: [
          { type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) },
          { type: 'dropdown', id: 'status', label: 'Status', default: 'complete', choices: STATUSES },
        ],
        callback: async (event) => this.ui({ command: 'set_highlighted_status', module: String(event.options.module), status: String(event.options.status) }),
      },
      tab_undo: {
        name: 'Tab: undo',
        options: [{ type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => this.ui({ command: 'undo', module: String(event.options.module) }),
      },
      tab_redo: {
        name: 'Tab: redo',
        options: [{ type: 'dropdown', id: 'module', label: 'Module', default: 'cue', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => this.ui({ command: 'redo', module: String(event.options.module) }),
      },
      tab_jump_module: {
        name: 'Tab: jump to module',
        description: 'Navigates your open tab on this production to the chosen module.',
        options: [{ type: 'dropdown', id: 'module', label: 'Go to', default: 'work', choices: MODULES.map((m) => ({ id: m.id, label: m.label })) }],
        callback: async (event) => this.ui({ command: 'jump_module', module: String(event.options.module) }),
      },
      set_last_status: {
        name: 'Set status of last created note',
        options: [{ type: 'dropdown', id: 'status', label: 'Status', default: 'complete', choices: STATUSES }],
        callback: async (event) => {
          try {
            const res = await this.api.setLastStatus(String(event.options.status))
            this.setVariableValues({ last_note_status: res.note.status })
            void this.refreshCounts()
          } catch (e) {
            this.log('warn', `Set status failed: ${describe(e)}`)
          }
        },
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
      { variableId: 'last_note_status', name: 'Status of the last note this station created' },
      { variableId: 'connected', name: 'Connected (true/false)' },
      { variableId: 'pairing_code', name: 'Pairing code while pairing is in progress (put it on a button)' },
    ]

    this.setActionDefinitions(actions)
    this.setFeedbackDefinitions(feedbacks)
    this.setVariableDefinitions(variables)
  }

  private async ui(body: { command: string; module: string; status?: string }): Promise<void> {
    try {
      await this.api.ui(body)
    } catch (e) {
      this.log('warn', `${body.command} failed: ${describe(e)}`)
    }
  }

  private clearTimers(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }
}

function describe(e: unknown): string {
  const err = e as Partial<ApiError> & { message?: string }
  return err?.message ?? String(e)
}

runEntrypoint(NotesListInstance, [])
