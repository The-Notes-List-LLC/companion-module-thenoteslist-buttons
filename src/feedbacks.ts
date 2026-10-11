import { combineRgb, type CompanionFeedbackDefinitions } from '@companion-module/base'
import { keyStyle } from './brand.js'
import { FALLBACK_PRIORITIES, moduleDropdown, perModuleChoices, type ModuleId } from './choices.js'
import type { NotesListInstance } from './main.js'

export function UpdateFeedbacks(self: NotesListInstance): void {
	const feedbacks: CompanionFeedbackDefinitions = {
		outstanding_above: {
			type: 'boolean',
			name: 'Outstanding count above threshold',
			defaultStyle: { bgcolor: combineRgb(220, 38, 38), color: combineRgb(255, 255, 255) },
			options: [
				moduleDropdown('work'),
				{ type: 'number', id: 'threshold', label: 'More than', default: 0, min: 0, max: 9999 },
			],
			callback: (fb) => self.counts[fb.options.module as ModuleId] > Number(fb.options.threshold ?? 0),
		},
		type_color: {
			type: 'advanced',
			name: 'Colour key by note type (matches the chip in the app)',
			options: [moduleDropdown(), ...perModuleChoices('type', 'Type', (m) => self.options?.[m]?.types ?? [], '')],
			callback: (fb) => {
				const mod = fb.options.module as ModuleId
				const opt = (self.options?.[mod]?.types ?? []).find((t) => t.value === fb.options[`type_${mod}`])
				return opt?.color ? keyStyle(opt.color) : {}
			},
		},
		priority_color: {
			type: 'advanced',
			name: 'Colour key by priority (matches the chip in the app)',
			options: [
				moduleDropdown(),
				...perModuleChoices(
					'priority',
					'Priority',
					(m) => self.options?.[m]?.priorities ?? FALLBACK_PRIORITIES,
					'medium',
				),
			],
			callback: (fb) => {
				const mod = fb.options.module as ModuleId
				const opt = (self.options?.[mod]?.priorities ?? []).find((p) => p.value === fb.options[`priority_${mod}`])
				return opt?.color ? keyStyle(opt.color) : {}
			},
		},
		selected_cue_off_live: {
			type: 'boolean',
			name: 'Selected cue is not the live cue',
			defaultStyle: { bgcolor: combineRgb(245, 158, 11), color: combineRgb(0, 0, 0) },
			options: [],
			callback: () => self.cursorOffset() !== 0,
		},
		eos_connected: {
			type: 'boolean',
			name: 'Eos desk connected (read-only reader)',
			defaultStyle: { bgcolor: combineRgb(22, 163, 74), color: combineRgb(255, 255, 255) },
			options: [],
			callback: () => self.eosConnected,
		},
		connected: {
			type: 'boolean',
			name: 'Connected',
			defaultStyle: { bgcolor: combineRgb(22, 163, 74), color: combineRgb(255, 255, 255) },
			options: [],
			callback: () => self.connected,
		},
	}
	self.setFeedbackDefinitions(feedbacks)
}
