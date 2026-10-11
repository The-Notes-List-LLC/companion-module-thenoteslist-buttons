import { combineRgb, type CompanionPresetDefinitions } from '@companion-module/base'
import { MODULE_COLORS, brandedStyle } from './brand.js'
import { MODULES } from './choices.js'
import type { NotesListInstance } from './main.js'

/**
 * Ready-made keys in the house look (N mark top-left, text right-aligned):
 *  - New note · <Module>: one per type of THIS show, coloured like the chip
 *  - Go to module: one per module, module colour
 *  - Selected cue: ◀ / ▶ / = live and two display keys
 */
export function UpdatePresets(self: NotesListInstance): void {
	const presets: CompanionPresetDefinitions = {}
	const L = self.label
	const cueVar = `$(${L}:selected_cue)`
	// Key faces have room for ~5 letters beside the N. Known types get the
	// abbreviation the booth already uses; multi-word customs become initials;
	// anything else is clipped to 5 letters.
	const ABBR: Record<string, string> = {
		cue: 'CUE',
		director: 'DIR',
		choreographer: 'CHOR',
		designer: 'DSGN',
		stage_manager: 'SM',
		associate: 'ASSOC',
		assistant: 'ASST',
		spot: 'SPOT',
		programmer: 'PROG',
		production: 'PROD',
		paperwork: 'PAPER',
		think: 'THINK',
		work: 'WORK',
		lighting: 'LX',
		focus: 'FOCUS',
		electrics: 'ELEC',
		rigging: 'RIG',
		sound: 'SND',
		scenic: 'SET',
		props: 'PROPS',
	}
	const short = (value: string, label: string) => {
		if (ABBR[value]) return ABBR[value]
		const words = label.trim().split(/\s+/)
		if (words.length > 1)
			return words
				.map((w) => w[0])
				.join('')
				.toUpperCase()
		return label.toUpperCase().slice(0, 5)
	}

	for (const m of MODULES) {
		const types = self.options?.[m.id]?.types ?? []
		for (const t of types) {
			presets[`new_${m.id}_${t.value}`] = {
				type: 'button',
				category: `New note · ${m.label}`,
				name: `${t.label} (${m.label})`,
				style: brandedStyle(`ADD\n${short(t.value, t.label)}\nNOTE`, t.color ?? MODULE_COLORS[m.id], 'auto'),
				steps: [
					{
						down: [
							{
								actionId: 'open_note_editor',
								options: {
									module: m.id,
									[`type_${m.id}`]: t.value,
									[`priority_${m.id}`]: 'medium',
									cueNumber: cueVar,
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			}
		}
		presets[`goto_${m.id}`] = {
			type: 'button',
			category: 'Go to module',
			name: `Go to ${m.label}`,
			// Same grammar as the note keys: two short words, module colour, N in the corner.
			style: brandedStyle(
				`${({ cue: 'CUE', work: 'WORK', production: 'PROD', electrician: 'ELEC' } as Record<string, string>)[m.id]}\nNOTES`,
				MODULE_COLORS[m.id],
				18,
			),
			steps: [{ down: [{ actionId: 'tab_jump_module', options: { module: m.id } }], up: [] }],
			feedbacks: [],
		}
	}

	// Selected-cue keys follow the same grammar: one short word, one number, the
	// N in the corner. Dark keys; amber while the selection is off the live cue.
	const dark = '#1f1f1f'
	const amber = { bgcolor: combineRgb(245, 158, 11), color: combineRgb(0, 0, 0) }
	const offLive = { feedbackId: 'selected_cue_off_live', options: {}, style: amber }
	const connected = {
		feedbackId: 'eos_connected',
		options: {},
		style: { bgcolor: combineRgb(0, 70, 0), color: combineRgb(255, 255, 255) },
	}
	presets.selected_prev = {
		type: 'button',
		category: 'Selected cue',
		name: 'Selected cue ◀',
		style: brandedStyle(`◀ CUE\n${cueVar}`, dark, 18),
		steps: [{ down: [{ actionId: 'selected_cue_prev', options: {} }], up: [] }],
		feedbacks: [offLive],
	}
	presets.selected_next = {
		type: 'button',
		category: 'Selected cue',
		name: 'Selected cue ▶',
		style: brandedStyle(`CUE ▶\n${cueVar}`, dark, 18),
		steps: [{ down: [{ actionId: 'selected_cue_next', options: {} }], up: [] }],
		feedbacks: [offLive],
	}
	presets.selected_live = {
		type: 'button',
		category: 'Selected cue',
		name: 'Selected cue = live',
		style: brandedStyle(`LIVE\n$(${L}:cue_live)`, dark, 18),
		steps: [{ down: [{ actionId: 'selected_cue_live', options: {} }], up: [] }],
		feedbacks: [connected],
	}
	presets.display_live = {
		type: 'button',
		category: 'Selected cue',
		name: 'Display: live cue',
		style: brandedStyle(`LIVE\n$(${L}:cue_live)`, '#000000', 18),
		steps: [{ down: [], up: [] }],
		// Stays black: green belongs to the "Selected cue = live" key, which does something.
		feedbacks: [],
	}
	presets.display_selected = {
		type: 'button',
		category: 'Selected cue',
		name: 'Display: selected cue',
		style: brandedStyle(`NOTE\n${cueVar}`, '#000000', 18),
		steps: [{ down: [], up: [] }],
		feedbacks: [offLive],
	}
	self.setPresetDefinitions(presets)
}
