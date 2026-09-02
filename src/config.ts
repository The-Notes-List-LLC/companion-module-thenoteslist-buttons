import type { SomeCompanionConfigField } from '@companion-module/base'

export interface ModuleConfig {
  baseUrl: string
  startPairing: boolean
  /** Filled by pairing. Never shown in full. */
  token: string
  stationName: string
  productionName: string
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
    { type: 'static-text', id: 'pairing_state', width: 12, label: view.code ? 'PAIRING CODE' : 'Status', value: banner },
    {
      type: 'static-text',
      id: 'info',
      width: 12,
      label: 'How pairing works',
      value:
        'Tick "Start pairing" and save. The connection status shows a 6-character code. In The Notes List open the show → Settings → Button stations, type the code, press Pair. The token arrives here automatically.',
    },
    { type: 'textinput', id: 'baseUrl', label: 'Base URL', width: 8, default: DEFAULT_BASE_URL },
    { type: 'checkbox', id: 'startPairing', label: 'Start pairing', width: 4, default: false },
    { type: 'secret-text', id: 'token', label: 'Station token (set by pairing)', width: 12, default: '' },
  ]
}
