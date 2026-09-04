import type { SomeCompanionConfigField } from '@companion-module/base'

export interface ModuleConfig {
  baseUrl: string
  startPairing: boolean
  /** Filled by pairing and kept in the stored config; deliberately NOT a visible field. */
  token: string
  stationName: string
  productionName: string
  /** Written by the module while pairing; shown live in the settings window. */
  pairingCode: string
  /** ETC Eos desk IP for the read-only cue reader; blank = use the variable expression instead. */
  eosHost: string
  eosUseSlip: boolean
  eosCueList: number
  /** Keep the cursor's offset from live when the desk fires the next cue (default: snap back to live). */
  eosKeepOffset: boolean
}

export const DEFAULT_BASE_URL = 'https://thenoteslist.com'

export interface PairingView {
  code: string | null
  expiresAt: number | null
  stationName: string
  productionName: string
  connected: boolean
}

/** Config fields are rebuilt every time the settings window opens, so the live pairing state can sit at the top. */
export function getConfigFields(view: PairingView = { code: null, expiresAt: null, stationName: '', productionName: '', connected: false }): SomeCompanionConfigField[] {
  const minutesLeft = view.expiresAt ? Math.max(0, Math.round((view.expiresAt - Date.now()) / 60000)) : 0
  const banner = view.code
    ? `<div style="font-size:28px;font-weight:700;letter-spacing:0.25em;font-family:monospace;padding:12px 16px;border:2px solid #f59e0b;border-radius:8px;display:inline-block">${view.code}</div><div style="margin-top:8px">Type this into The Notes List → the show → <b>Settings → Button stations</b>. Expires in about ${minutesLeft} min. Close and reopen this window to refresh.</div>`
    : view.connected
      ? `<b>Paired</b> as "${view.stationName}" on ${view.productionName || 'the production'}. Tick "Start pairing" to pair a different show.`
      : 'Not paired yet. Tick "Start pairing" below, save, then reopen this window to see the code.'
  return [
    // --- The Notes List -------------------------------------------------------
    { type: 'static-text', id: 'section_app', width: 12, label: 'The Notes List', value: 'Where this station talks to. Use the live site unless you are testing a beta build.' },
    { type: 'textinput', id: 'baseUrl', label: 'Base URL', width: 12, default: DEFAULT_BASE_URL },

    // --- Pairing ----------------------------------------------------------------
    { type: 'static-text', id: 'pairing_state', width: 12, label: view.code ? 'PAIRING CODE' : 'Pairing', value: banner },
    { type: 'checkbox', id: 'startPairing', label: 'Start pairing', width: 4, default: false },
    { type: 'textinput', id: 'pairingCode', label: 'Pairing code (fills in by itself; type it into the app, then it clears)', width: 8, default: '' },
    { type: 'static-text', id: 'pairing_help', width: 12, label: '', value: 'Tick Start pairing and save. The code appears above and in the box; in The Notes List open the show → Settings → Button stations, type it, name the station, press Pair. A station belongs to one show; pair again for another.' },

    // --- ETC Eos -----------------------------------------------------------------
    { type: 'static-text', id: 'eos_info', width: 12, label: 'ETC Eos (read-only)', value: 'Enter the desk IP and this module reads the cue list itself: the live cue plus a cursor you can step back and forward with keys, so a late press still lands on the right cue. It never sends commands to the desk. Cue number boxes on keys stay variable-aware, so any Companion variable can still be typed there by hand.' },
    { type: 'textinput', id: 'eosHost', label: 'Eos desk IP', width: 5, default: '' },
    { type: 'checkbox', id: 'eosUseSlip', label: 'Use TCP SLIP (port 3037, Eos 3.1+)', width: 4, default: false },
    { type: 'number', id: 'eosCueList', label: 'Cue list', width: 3, default: 1, min: 1, max: 999 },
    { type: 'checkbox', id: 'eosKeepOffset', label: 'Keep cursor offset when the desk fires the next cue', width: 12, default: false },
  ]
}
