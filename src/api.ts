/**
 * Thin client for /api/stations/* (see docs/BUTTON_STATIONS.md in the app repo).
 * Every response is JSON; errors carry { error, message }.
 */
export class ApiError extends Error {
	constructor(
		public status: number,
		public error: string,
		message: string,
	) {
		super(message)
	}
}

type ModuleKey = 'cue' | 'work' | 'production' | 'electrician'
type Choice = { value: string; label: string; color?: string }

export type PairStartResponse = { code: string; pollSecret: string; expiresAt: string }
export type PairPollResponse = {
	status?: 'pending'
	token?: string
	station?: { id: string; name: string; productionId: string; productionName: string | null }
}
export type MeResponse = {
	station: { id: string; name: string }
	production: { id: string; name: string | null }
	modules: Record<ModuleKey, boolean>
	options?: Record<ModuleKey, { priorities: Choice[]; types: Choice[] }>
}
export type CountsResponse = Record<ModuleKey, { todo: number; review: number; outstanding: number }> & {
	asOf: string
}
export type CreateNoteResponse = {
	note: { id: string; status: string; priority: string; type: string | null }
	coerced: Record<string, string | null>
	replayed: boolean
}
export type UiBody = {
	command: string
	module: string
	status?: string
	cueNumber?: string
	type?: string
	priority?: string
}

const REQUEST_TIMEOUT_MS = 10000

export class StationApi {
	/** Aborted by abort(): cancels every request still in flight. */
	private readonly controller = new AbortController()

	constructor(
		private baseUrl: string,
		private token: string | null,
	) {}

	/** Cancel in-flight requests (settings saved or connection removed). */
	abort(): void {
		this.controller.abort()
	}

	setToken(token: string | null): void {
		this.token = token
	}

	private async call<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			...(init.headers as Record<string, string> | undefined),
		}
		if (auth) {
			if (!this.token) throw new ApiError(401, 'unauthorized', 'Not paired')
			headers.authorization = `Bearer ${this.token}`
		}
		const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
			...init,
			headers,
			signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
		})
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
		if (!res.ok) {
			throw new ApiError(
				res.status,
				typeof body.error === 'string' ? body.error : 'error',
				typeof body.message === 'string' ? body.message : res.statusText,
			)
		}
		return body as T
	}

	async pairStart(): Promise<PairStartResponse> {
		return this.call<PairStartResponse>('/api/stations/pair/start', { method: 'POST' }, false)
	}
	async pairPoll(code: string, pollSecret: string): Promise<PairPollResponse> {
		return this.call<PairPollResponse>(
			'/api/stations/pair/poll',
			{ method: 'POST', body: JSON.stringify({ code, pollSecret }) },
			false,
		)
	}
	async me(): Promise<MeResponse> {
		return this.call<MeResponse>('/api/stations/me')
	}
	async counts(): Promise<CountsResponse> {
		return this.call<CountsResponse>('/api/stations/counts')
	}
	async createNote(body: {
		module: string
		description: string
		priority?: string
		type?: string
		id: string
		cueNumber?: string
	}): Promise<CreateNoteResponse> {
		return this.call<CreateNoteResponse>('/api/stations/notes', { method: 'POST', body: JSON.stringify(body) })
	}
	async openNoteEditor(module: string, cueNumber?: string): Promise<{ sent: boolean }> {
		return this.ui({ command: 'open_note_editor', module, cueNumber })
	}
	async ui(body: UiBody): Promise<{ sent: boolean; prefill?: Record<string, string> }> {
		return this.call<{ sent: boolean; prefill?: Record<string, string> }>('/api/stations/ui', {
			method: 'POST',
			body: JSON.stringify(body),
		})
	}
	async revokeSelf(): Promise<{ revoked: boolean }> {
		return this.call<{ revoked: boolean }>('/api/stations/me', { method: 'DELETE' })
	}
	async setLastStatus(status: string): Promise<{ note: { id: string; status: string } }> {
		return this.call<{ note: { id: string; status: string } }>('/api/stations/notes/last/status', {
			method: 'POST',
			body: JSON.stringify({ status }),
		})
	}
}
