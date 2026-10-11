import type { CompanionActionDefinitions } from '@companion-module/base'
import { FALLBACK_PRIORITIES, moduleDropdown, perModuleChoices, type ModuleId } from './choices.js'
import type { NotesListInstance } from './main.js'

const STATUSES = [
	{ id: 'complete', label: 'Complete' },
	{ id: 'cancelled', label: 'Cancelled' },
	{ id: 'review', label: 'In Review (Work Notes only)' },
	{ id: 'todo', label: 'Back to To Do' },
]

export function UpdateActions(self: NotesListInstance): void {
	const cueDefault = `$(${self.label}:selected_cue)`
	const cueOption = {
		type: 'textinput' as const,
		id: 'cueNumber',
		label: 'Cue number (blank = none)',
		default: cueDefault,
		useVariables: true,
		tooltip: `Resolved when you press. Default is the cue cursor ($(${self.label}:selected_cue)): the live cue unless you stepped it with the Selected cue ◀ / ▶ keys. $(${self.label}:cue_live) is always the live cue. Any other variable or a typed number also works.`,
	}
	const actions: CompanionActionDefinitions = {
		open_note_editor: {
			name: 'New note (opens the editor in your tab)',
			description:
				'Opens the Add Note dialog in your browser tab on this module page, prefilled with the type, priority and cue number below. Your tab must be open on that page.',
			options: [
				moduleDropdown(),
				...perModuleChoices('type', 'Type', (m) => self.options?.[m]?.types ?? [], ''),
				...perModuleChoices(
					'priority',
					'Priority',
					(m) => self.options?.[m]?.priorities ?? FALLBACK_PRIORITIES,
					'medium',
				),
				cueOption,
			],
			callback: async (event, context) => {
				const mod = String(event.options.module) as ModuleId
				let cueNumber: string | undefined =
					(await context.parseVariablesInString(String(event.options.cueNumber ?? ''))).trim() || undefined
				if (!cueNumber || cueNumber === '$NA') cueNumber = self.cursorCue()?.number
				await self.ui({
					command: 'open_note_editor',
					module: mod,
					cueNumber,
					type: String(event.options[`type_${mod}`] ?? '') || undefined,
					priority: String(event.options[`priority_${mod}`] ?? '') || undefined,
				})
			},
		},
		selected_cue_prev: {
			name: 'Selected cue ◀ (one cue earlier)',
			description:
				"Moves the selected cue one earlier in the desk's list without touching the console. New note lands on the selected cue.",
			options: [],
			callback: async () => self.stepCursor(-1),
		},
		selected_cue_next: {
			name: 'Selected cue ▶ (one cue later)',
			description:
				"Moves the selected cue one later in the desk's list without touching the console. New note lands on the selected cue.",
			options: [],
			callback: async () => self.stepCursor(1),
		},
		eos_reload_list: {
			name: 'Eos: reload the cue list (after edits on the desk)',
			description: 'Reads the whole cue list from the desk again, for when labels or numbers look out of date.',
			options: [],
			callback: async () => self.reloadCueList(),
		},
		selected_cue_live: {
			name: 'Selected cue = live (follow the running cue again)',
			description: 'Puts the selected cue back on the live cue; it then follows the desk as cues fire.',
			options: [],
			callback: async () => self.resetCursor(),
		},
		tab_next_note: {
			name: 'Highlight next note',
			description: 'Moves the highlight down one row in your open tab on this module page.',
			options: [moduleDropdown()],
			callback: async (event) => self.ui({ command: 'next_note', module: String(event.options.module) }),
		},
		tab_prev_note: {
			name: 'Highlight previous note',
			description: 'Moves the highlight up one row in your open tab on this module page.',
			options: [moduleDropdown()],
			callback: async (event) => self.ui({ command: 'prev_note', module: String(event.options.module) }),
		},
		tab_set_highlighted_status: {
			name: 'Set status of highlighted note',
			description: 'Sets the status of the highlighted note in your open tab on this module page.',
			options: [
				moduleDropdown(),
				{ type: 'dropdown', id: 'status', label: 'Status', default: 'complete', choices: STATUSES },
			],
			callback: async (event) =>
				self.ui({
					command: 'set_highlighted_status',
					module: String(event.options.module),
					status: String(event.options.status),
				}),
		},
		tab_undo: {
			name: 'Undo',
			description: 'Undoes the last change in your open tab on this module page.',
			options: [moduleDropdown()],
			callback: async (event) => self.ui({ command: 'undo', module: String(event.options.module) }),
		},
		tab_redo: {
			name: 'Redo',
			description: 'Redoes the last undone change in your open tab on this module page.',
			options: [moduleDropdown()],
			callback: async (event) => self.ui({ command: 'redo', module: String(event.options.module) }),
		},
		tab_jump_module: {
			name: 'Go to module',
			description: 'Navigates your open tab on this production to the chosen module.',
			options: [moduleDropdown('work', 'Go to')],
			callback: async (event) => self.ui({ command: 'jump_module', module: String(event.options.module) }),
		},
	}
	self.setActionDefinitions(actions)
}
