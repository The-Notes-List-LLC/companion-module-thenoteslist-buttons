import type { NotesListInstance } from './main.js'

export function UpdateVariableDefinitions(self: NotesListInstance): void {
	self.setVariableDefinitions([
		{ variableId: 'cue_outstanding', name: 'Cue Notes outstanding' },
		{ variableId: 'work_outstanding', name: 'Work Notes outstanding' },
		{ variableId: 'production_outstanding', name: 'Production Notes outstanding' },
		{ variableId: 'electrician_outstanding', name: 'Electrician Notes outstanding' },
		{ variableId: 'station_name', name: 'Station name' },
		{ variableId: 'production_name', name: 'Production name' },
		{ variableId: 'connected', name: 'Connected (true/false)' },
		{ variableId: 'pairing_code', name: 'Pairing code while pairing is in progress (put it on a button)' },
		{ variableId: 'cue_live', name: 'Eos: live cue number (our read-only reader)' },
		{ variableId: 'cue_live_label', name: 'Eos: label of the live cue' },
		{ variableId: 'selected_cue', name: 'Selected cue: the cue the next note lands on (live unless you stepped)' },
		{ variableId: 'selected_cue_label', name: 'Selected cue label' },
		{ variableId: 'selected_cue_label_short', name: 'Selected cue label, first 7 characters (fits a key face)' },
		{ variableId: 'selected_cue_offset', name: 'Selected cue offset from live (0 = live)' },
		{ variableId: 'eos_connected', name: 'Eos desk connected (true/false)' },
	])
}
