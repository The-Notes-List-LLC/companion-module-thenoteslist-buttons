import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The instance against a stand-in Companion base class and a scripted fetch.
 * Covers the polling rules: one request in flight per loop, a config re-save
 * never doubles polling, pairing polls never overlap, and network failures are
 * reported instead of leaving stale counts.
 */
const h = vi.hoisted(() => ({
  cls: null as null | (new () => any),
  status: [] as Array<[string, string | undefined]>,
  vars: {} as Record<string, unknown>,
  saved: [] as unknown[],
  savedSecrets: [] as unknown[],
}))

vi.mock('@companion-module/base', () => {
  class InstanceBase {
    label = 'nl'
    updateStatus(s: string, m?: string) { h.status.push([s, m]) }
    setVariableValues(v: Record<string, unknown>) { Object.assign(h.vars, v) }
    checkFeedbacks() {}
    log() {}
    saveConfig(c: unknown, s?: unknown) { if (c) h.saved.push(c); if (s) h.savedSecrets.push(s) }
    setActionDefinitions() {}
    setFeedbackDefinitions() {}
    setVariableDefinitions() {}
    setPresetDefinitions() {}
  }
  return {
    InstanceBase,
    InstanceStatus: { Ok: 'ok', Connecting: 'connecting', ConnectionFailure: 'connection_failure', BadConfig: 'bad_config', Disconnected: 'disconnected' },
    combineRgb: (r: number, g: number, b: number) => (r << 16) + (g << 8) + b,
    runEntrypoint: (cls: new () => unknown) => { h.cls = cls as new () => any },
  }
})

type Reply = { status?: number; body?: unknown } | 'hang' | 'network'
/** Scripted server: a handler per path; records every call. */
let routes: Record<string, (n: number) => Reply>
let calls: string[]
let hanging: Array<() => void>

function mockFetch() {
  calls = []
  hanging = []
  sentAuth = []
  vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string> }) => {
    const path = new URL(url).pathname
    calls.push(path)
    if (init?.headers?.authorization) sentAuth.push(init.headers.authorization)
    const n = calls.filter((p) => p === path).length
    const r = routes[path]?.(n) ?? { status: 404, body: { error: 'not_found' } }
    if (r === 'network') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    if (r === 'hang') await new Promise<void>((resolve) => hanging.push(resolve))
    const { status = 200, body = {} } = r === 'hang' ? {} : r
    return { ok: status < 400, status, statusText: '', json: async () => body }
  })
}

const ME = { station: { id: 's', name: 'deck' }, production: { id: 'p', name: 'Show' }, modules: {} }
const COUNTS = { cue: { todo: 1, review: 0, outstanding: 3 }, work: { todo: 0, review: 0, outstanding: 0 }, production: { todo: 0, review: 0, outstanding: 0 }, electrician: { todo: 0, review: 0, outstanding: 0 }, asOf: '' }
const PAIRED = { baseUrl: 'https://notes.test', startPairing: false } as Record<string, unknown>
const SECRETS = { token: 't' }
let sentAuth: string[] = []

const count = (path: string) => calls.filter((p) => p === path).length
const flush = () => vi.advanceTimersByTimeAsync(0)

let inst: any
beforeEach(async () => {
  vi.useFakeTimers()
  h.status = []
  h.vars = {}
  h.saved = []
  h.savedSecrets = []
  routes = {
    '/api/stations/me': () => ({ body: ME }),
    '/api/stations/counts': () => ({ body: COUNTS }),
  }
  mockFetch()
  if (!h.cls) await import('../src/main.js')
  inst = new h.cls!()
})
afterEach(async () => {
  await inst.destroy()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('polling', () => {
  it('polls counts every 5 s and /me every 60 s once paired', async () => {
    await inst.configUpdated(PAIRED, SECRETS)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(count('/api/stations/counts')).toBe(13) // now, then every 5 s
    expect(count('/api/stations/me')).toBe(2) // at start, then at 60 s
    expect(h.vars.cue_outstanding).toBe(3)
  })

  it('never has two counts requests in flight on a slow server', async () => {
    routes['/api/stations/counts'] = () => 'hang'
    await inst.configUpdated(PAIRED, SECRETS)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(count('/api/stations/counts')).toBe(1)
    hanging.forEach((r) => r())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(count('/api/stations/counts')).toBe(2)
  })

  it('a re-save while /me is in flight does not double polling', async () => {
    routes['/api/stations/me'] = (n) => (n === 1 ? 'hang' : { body: ME })
    const first = inst.configUpdated(PAIRED, SECRETS)
    await flush()
    const second = inst.configUpdated(PAIRED, SECRETS)
    await flush()
    hanging.forEach((r) => r()) // the first session's /me answers late
    await Promise.all([first, second])
    calls = []
    await vi.advanceTimersByTimeAsync(30_000)
    expect(count('/api/stations/counts')).toBe(6) // one loop, not two
  })
})

describe('network failures', () => {
  it('reports the outage from the second miss, blanks counts, backs off, and recovers', async () => {
    await inst.configUpdated(PAIRED, SECRETS)
    await flush() // the first counts poll runs in the background
    expect(h.vars.cue_outstanding).toBe(3)
    routes['/api/stations/counts'] = () => 'network'
    await vi.advanceTimersByTimeAsync(5_000) // first miss: a blip, nothing shown yet
    expect(h.vars.cue_outstanding).toBe(3)
    await vi.advanceTimersByTimeAsync(10_000) // second miss after a 10 s backoff
    expect(h.vars.cue_outstanding).toBe('')
    expect(h.vars.connected).toBe('false')
    expect(h.status.at(-1)).toEqual(['connection_failure', 'Cannot reach notes.test (ECONNREFUSED)'])
    // Backoff: 5, 10, 20, 30, 30 … instead of every 5 s.
    calls = []
    await vi.advanceTimersByTimeAsync(80_000)
    expect(count('/api/stations/counts')).toBeLessThanOrEqual(4)
    routes['/api/stations/counts'] = () => ({ body: COUNTS })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.vars.cue_outstanding).toBe(3)
    expect(h.status.at(-1)?.[0]).toBe('ok')
  })

  it('stops asking for counts once the station is revoked', async () => {
    await inst.configUpdated(PAIRED, SECRETS)
    routes['/api/stations/counts'] = () => ({ status: 401, body: { error: 'unauthorized', message: 'revoked' } })
    routes['/api/stations/me'] = () => ({ status: 401, body: { error: 'unauthorized', message: 'revoked' } })
    await vi.advanceTimersByTimeAsync(5_000)
    calls = []
    await vi.advanceTimersByTimeAsync(50_000)
    expect(count('/api/stations/counts')).toBe(0)
    expect(h.status.at(-1)?.[0]).toBe('bad_config')
  })
})

describe('pairing', () => {
  const UNPAIRED = { baseUrl: 'https://notes.test', token: '', startPairing: true }
  beforeEach(() => {
    routes['/api/stations/pair/start'] = () => ({ body: { code: 'ABC123', pollSecret: 'x', expiresAt: new Date(Date.now() + 600_000).toISOString() } })
  })

  it('never overlaps polls, so a slow success is not followed by "Pairing ended"', async () => {
    routes['/api/stations/pair/poll'] = (n) => (n === 1 ? 'hang' : { status: 409, body: { error: 'claimed', message: 'already claimed' } })
    await inst.configUpdated(UNPAIRED)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(count('/api/stations/pair/poll')).toBe(1)
  })

  it('starts the paired session itself after a successful pair', async () => {
    routes['/api/stations/pair/poll'] = () => ({ body: { token: 'new', station: { id: 's', name: 'deck', productionId: 'p', productionName: 'Show' } } })
    await inst.configUpdated(UNPAIRED)
    await vi.advanceTimersByTimeAsync(3_500)
    expect(h.saved.at(-1)).toMatchObject({ startPairing: false })
    expect(h.saved.at(-1)).not.toHaveProperty('token', 'new') // never in the plain config
    expect(h.savedSecrets.at(-1)).toEqual({ token: 'new' })
    expect(h.status.at(-1)?.[0]).toBe('ok')
    calls = []
    await vi.advanceTimersByTimeAsync(10_000)
    expect(count('/api/stations/counts')).toBe(2)
    expect(count('/api/stations/pair/poll')).toBe(0)
  })
})

describe('token storage', () => {
  it('moves a legacy config token into secrets, and it wins over a stale secret', async () => {
    await inst.configUpdated({ ...PAIRED, token: 'tnl_real' }, { token: 'CJ6GXX' })
    expect(h.savedSecrets.at(-1)).toEqual({ token: 'tnl_real' })
    expect(h.saved.at(-1)).toMatchObject({ token: '' })
    expect(sentAuth.at(-1)).toBe('Bearer tnl_real')
  })

  it('uses the secret when the config holds no token', async () => {
    await inst.configUpdated(PAIRED, { token: 'from_secrets' })
    expect(h.savedSecrets).toEqual([])
    expect(sentAuth.at(-1)).toBe('Bearer from_secrets')
  })
})
