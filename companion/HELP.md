# The Notes List

Drive one production of [The Notes List](https://thenoteslist.com) from your Companion surface.

## Pairing

1. Add this connection. Leave **Base URL** as `https://thenoteslist.com` unless you are on beta/alpha.
2. Tick **Start pairing** and save. Close and reopen the connection's settings: the 6-character code is shown large at the top. It is also in the Log tab, the status text, and the variable `$(<connection label>:pairing_code)` (drop it on a button to read it off the deck).
3. In The Notes List, open the show → **Settings** → **Button stations**, type the code, give the station a name, press **Pair**.
4. Within a few seconds the status turns **OK**. The token is stored in this connection; you never see it.

A station belongs to one production. To move to another show, revoke it in Settings and pair again.

## Following the lighting console (ETC Eos, read-only)

Enter the desk's IP in **Eos desk IP** (tick **Use TCP SLIP** if the desk uses port 3037 / OSC 1.1; the Eos default is port 3032). Enable OSC RX/TX on the desk under Setup → System → Show Control → OSC. This module then follows the live cue of cue list 1 (change **Cue list** if needed), fetches the cues around it first, and walks the whole list in the background one request at a time (a 1700-cue show takes under a minute and the desk never sees a burst). Once the list is cached it subscribes, so cue edits on the desk (renumber, insert, relabel) update the cache by themselves; the wheel and channel traffic that comes with a subscription is ignored. It never sends a command to the desk. **Eos: reload the cue list** is there if you ever want to force a fresh read.

**Selected cue.** Notes land on the selected cue, which normally follows the live cue. If a press comes late, **Selected cue ◀** / **▶** move the selection back or forward through the cached list without touching the console; **Selected cue = live** follows the running cue again. When the desk fires the next cue the selection returns to live (tick **Keep cursor offset** to hold the offset instead). Key faces: `$(<connection label>:selected_cue)` (with `selected_cue_label`), `$(<connection label>:cue_live)`; the **Selected cue is not the live cue** feedback turns a key amber while stepped. Presets under "Selected cue" include two display-only keys (live cue, selected cue).

### Other consoles

The **Cue number** box on a New note key is variable-aware, so with another console's Companion module you can type its variable there (for example a QLab or grandMA3 cue variable) instead of the Eos cursor.

## Actions

Everything acts on **your own open browser tab** of The Notes List, on the page for the chosen module. Other members' tabs never react.

- **New note (opens the editor in your tab)** — module, type and priority (this show's real choices), cue number (defaults to the console's live cue). Opens the Add Note dialog prefilled; you finish the text at the keyboard.
- **Highlight next / previous note** — moves the blue ring through the visible list. Clicking a row in the app also highlights it.
- **Set status of highlighted note** — Complete, Cancelled, In Review (Work Notes only) or back to To Do.
- **Undo / Redo**.
- **Go to module** — navigates your tab to another module of the same show.

## Presets

Under **Presets**: one key per note type of your show ("New note · Cue Notes" → ADD CUE NOTE, ADD SM NOTE…) in the house look (N mark, chip colour), a **Go to module** key per module, and the **Selected cue** keys. Drag them onto the deck.

## Feedbacks

- **Colour key by note type** / **by priority** — background matches the chip colour in the app (renamed or recoloured types follow within a minute).

- **Outstanding count above threshold** — colour a button when a module has more than N open notes.
- **Connected** — station is paired and the production accepts it.

## Variables

`$(<connection label>:cue_outstanding)`, `work_outstanding`, `production_outstanding`, `electrician_outstanding`, `station_name`, `production_name`, `pairing_code`, `connected`.
