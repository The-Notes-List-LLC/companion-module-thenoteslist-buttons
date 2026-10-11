import type { CompanionInputFieldDropdown } from '@companion-module/base'

export const MODULES = [
	{ id: 'cue', label: 'Cue Notes' },
	{ id: 'work', label: 'Work Notes' },
	{ id: 'production', label: 'Production Notes' },
	{ id: 'electrician', label: 'Electrician Notes' },
] as const
export type ModuleId = (typeof MODULES)[number]['id']

export type Opt = { value: string; label: string; color?: string }
export type ModuleOptions = Record<ModuleId, { priorities: Opt[]; types: Opt[] }>

// Fallbacks until /me answers: the app's system defaults.
export const FALLBACK_PRIORITIES: Opt[] = [
	'critical',
	'very_high',
	'high',
	'medium_high',
	'medium',
	'medium_low',
	'low',
	'very_low',
	'uncritical',
].map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))

/** The Module dropdown most actions and feedbacks start with. */
export function moduleDropdown(defaultModule: ModuleId = 'cue', label = 'Module'): CompanionInputFieldDropdown {
	return {
		type: 'dropdown',
		id: 'module',
		label,
		default: defaultModule,
		choices: MODULES.map((m) => ({ id: m.id, label: m.label })),
	}
}

/**
 * One dropdown per module for a field whose choices differ by module, shown only
 * when that module is selected. Companion cannot make one dropdown's choices
 * depend on another option, so this is the idiom.
 */
export function perModuleChoices(
	field: 'priority' | 'type',
	label: string,
	choicesFor: (m: ModuleId) => Opt[],
	fallbackDefault: string,
): CompanionInputFieldDropdown[] {
	return MODULES.map((m) => {
		const opts = choicesFor(m.id)
		const choices =
			field === 'type'
				? [{ id: '', label: '(none)' }, ...opts.map((o) => ({ id: o.value, label: o.label }))]
				: opts.map((o) => ({ id: o.value, label: o.label }))
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
			isVisibleExpression: `$(options:module) == '${m.id}'`,
		}
	})
}
