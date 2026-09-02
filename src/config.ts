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

export function getConfigFields(): SomeCompanionConfigField[] {
  return [
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
    { type: 'static-text', id: 'paired', width: 12, label: 'Paired as', value: 'Not paired yet.' },
    { type: 'secret-text', id: 'token', label: 'Station token (set by pairing)', width: 12, default: '' },
  ]
}
