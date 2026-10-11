import { combineRgb, type CompanionPresetDefinitions } from '@companion-module/base'
import { ACTION_COLORS, MODULE_COLORS, N_PNG64_DARK, brandedStyle, tint } from './brand.js'
import { MODULES } from './choices.js'
import type { NotesListInstance } from './main.js'

/**
 * Ready-made keys in the house look (N mark top-left, text on the bottom edge,
 * colour says what a key does). Categories are numbered in the order a booth
 * lays them out:
 *  1 Selected cue: ◀ / ▶ / = live and a display key with the cue's label
 *  2 New note · <Module>: one per type of THIS show, coloured like the chip
 *  3 Highlighted note · <Module>: next, prev, set Done / Cancl / Revw / To Do, undo, redo
 *  4 Go to module: one per module, with its open count
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
		costume: 'COS',
		costumes: 'COS',
		wardrobe: 'WARD',
		directing: 'DIR',
		direction: 'DIR',
		electric: 'ELEC',
		electrical: 'ELEC',
		electrician: 'ELEC',
		electricians: 'ELEC',
		video: 'VID',
		projection: 'PROJ',
		projections: 'PROJ',
		automation: 'AUTO',
		followspot: 'SPOT',
		music: 'MUS',
		musical: 'MUS',
		choreography: 'CHOR',
		dance: 'DNC',
		puppetry: 'PUP',
		wigs: 'WIGS',
		deck: 'DECK',
		fly: 'FLY',
		flys: 'FLY',
	}
	const short = (value: string, label: string) => {
		const words = label.trim().split(/\s+/)
		const key = words.length === 1 ? words[0].toLowerCase() : ''
		if (ABBR[value]) return ABBR[value]
		if (key && ABBR[key]) return ABBR[key]
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
			// "ADD / SM": the type is the word that tells keys apart, so no "NOTE"
			// filler. One size for every ADD key so a row of them lines up.
			const abbr = short(t.value, t.label)
			presets[`new_${m.id}_${t.value}`] = {
				type: 'button',
				category: `2 · New note · ${m.label}`,
				name: `${t.label} (${m.label})`,
				style: brandedStyle(`ADD\n${abbr}`, t.color ?? MODULE_COLORS[m.id]),
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
				feedbacks: [],
			}
		}
		presets[`goto_${m.id}`] = {
			type: 'button',
			category: '4 · Go to module',
			name: `Go to ${m.label}`,
			// Module colour and the module's open count ("WORK / 3 OPEN").
			style: brandedStyle(
				`${({ cue: 'CUE', work: 'WORK', production: 'PROD', electrician: 'ELEC' } as Record<string, string>)[m.id]}\n$(${L}:${m.id}_outstanding) OPEN`,
				MODULE_COLORS[m.id],
			),
			steps: [{ down: [{ actionId: 'tab_jump_module', options: { module: m.id } }], up: [] }],
			feedbacks: [],
		}
	}

	// Working the list in the open tab. Colour says what a key DOES: green
	// completes, red cancels, slate sends to review. Everything else is a dark
	// key whose text carries the module colour, so a NEXT for Work still reads
	// as Work and nothing looks like a status change that is not one.
	for (const m of MODULES) {
		const cat = `3 · Highlighted note · ${m.label}`
		const mod = tint(MODULE_COLORS[m.id], 0.4) // module colour, lifted so it reads on the dark key
		const key = (
			id: string,
			name: string,
			face: string,
			bg: string,
			text: string | undefined,
			actionId: string,
			options: Record<string, string>,
		) => {
			presets[`${id}_${m.id}`] = {
				type: 'button',
				category: cat,
				name: `${name} (${m.label})`,
				style: brandedStyle(face, bg, 18, text),
				steps: [{ down: [{ actionId, options }], up: [] }],
				feedbacks: [],
			}
		}
		const { done, cancel, review, neutral } = ACTION_COLORS
		key('next', 'Highlight next note', 'NEXT\nNOTE', neutral, mod, 'tab_next_note', { module: m.id })
		key('prev', 'Highlight previous note', 'PREV\nNOTE', neutral, mod, 'tab_prev_note', { module: m.id })
		key('done', 'Mark highlighted note complete', 'SET\nDONE', done, undefined, 'tab_set_highlighted_status', {
			module: m.id,
			status: 'complete',
		})
		key('cancel', 'Mark highlighted note cancelled', 'SET\nCANCL', cancel, undefined, 'tab_set_highlighted_status', {
			module: m.id,
			status: 'cancelled',
		})
		if (m.id === 'work')
			key('review', 'Mark highlighted note in review', 'SET\nREVW', review, undefined, 'tab_set_highlighted_status', {
				module: m.id,
				status: 'review',
			})
		key('todo', 'Highlighted note back to To Do', 'SET\nTO DO', neutral, mod, 'tab_set_highlighted_status', {
			module: m.id,
			status: 'todo',
		})
		key('undo', 'Undo', 'UNDO', neutral, mod, 'tab_undo', { module: m.id })
		key('redo', 'Redo', 'REDO', neutral, mod, 'tab_redo', { module: m.id })
	}

	// Selected-cue keys follow the same grammar: one short word, one number, the
	// N in the corner. Dark keys; amber while the selection is off the live cue.
	// Fixed 18 px: with 'auto' an empty cue line (no desk yet) lets the lone word
	// inflate and break mid-word ("LIV / E").
	const dark = ACTION_COLORS.neutral
	const sel = '1 · Selected cue'
	const amber = { bgcolor: combineRgb(245, 158, 11), color: combineRgb(0, 0, 0), png64: N_PNG64_DARK }
	const offLive = { feedbackId: 'selected_cue_off_live', options: {}, style: amber }
	// LIVE is green only while the selection IS the live cue; stepped away it
	// stays dark (the ◀ / ▶ keys go amber). Without a desk it says so in grey.
	const onLive = {
		feedbackId: 'selected_cue_on_live',
		options: {},
		style: { bgcolor: combineRgb(0, 70, 0), color: combineRgb(255, 255, 255) },
	}
	const noDesk = {
		feedbackId: 'eos_connected',
		options: {},
		isInverted: true,
		style: { text: 'NO\nDESK', color: combineRgb(128, 128, 128) },
	}
	presets.selected_prev = {
		type: 'button',
		category: sel,
		name: 'Selected cue ◀',
		style: brandedStyle(`◀ CUE\n${cueVar}`, dark),
		steps: [{ down: [{ actionId: 'selected_cue_prev', options: {} }], up: [] }],
		feedbacks: [offLive],
	}
	presets.selected_next = {
		type: 'button',
		category: sel,
		name: 'Selected cue ▶',
		style: brandedStyle(`CUE ▶\n${cueVar}`, dark),
		steps: [{ down: [{ actionId: 'selected_cue_next', options: {} }], up: [] }],
		feedbacks: [offLive],
	}
	presets.selected_live = {
		type: 'button',
		category: sel,
		name: 'Selected cue = live',
		style: brandedStyle(`LIVE\n$(${L}:cue_live)`, dark),
		steps: [{ down: [{ actionId: 'selected_cue_live', options: {} }], up: [] }],
		feedbacks: [onLive, noDesk],
	}
	presets.display_selected = {
		type: 'button',
		category: sel,
		name: 'Display: selected cue (number and label)',
		style: brandedStyle(`NOTE\n${cueVar}\n$(${L}:selected_cue_label_short)`, '#000000', 14),
		steps: [{ down: [], up: [] }],
		feedbacks: [offLive],
	}
	self.setPresetDefinitions(presets)
}
