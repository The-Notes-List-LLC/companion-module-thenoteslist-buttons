# The Notes List

Drive one production of [The Notes List](https://thenoteslist.com) from your Companion surface.

## Pairing

1. Add this connection. Leave **Base URL** as `https://thenoteslist.com` unless you are on beta/alpha.
2. Tick **Start pairing** and save. Close and reopen the connection's settings: the 6-character code is shown large at the top. It is also in the Log tab, the status text, and the variable `$(thenoteslist:pairing_code)` (drop it on a button to read it off the deck).
3. In The Notes List, open the show → **Settings** → **Button stations**, type the code, give the station a name, press **Pair**.
4. Within a few seconds the status turns **OK**. The token is stored in this connection; you never see it.

A station belongs to one production. To move to another show, revoke it in Settings and pair again.

## Following the lighting console (ETC Eos, read-only)

Enter the desk's IP in **Eos desk IP** (tick **Use TCP SLIP** if the desk uses port 3037 / OSC 1.1; the Eos default is port 3032). Enable OSC RX/TX on the desk under Setup → System → Show Control → OSC. This module then follows the live cue of cue list 1 (change **Cue list** if needed), fetches the cues around it first, and walks the whole list in the background one request at a time (a 1700-cue show takes under a minute and the desk never sees a burst). It does not subscribe to the desk's parameter stream (no encoder or channel traffic) and never sends a command to it. Because it is not subscribed, edits made on the desk after connecting are not pushed to it: press the **Eos: reload the cue list** action after renumbering or inserting cues.

**Cue cursor.** Notes land on the cursor, which normally rides the live cue. If a press comes late, the keys **Cue ◀** / **Cue ▶** step the cursor back or forward through the cached list without touching the console; **Cue = live** snaps it back. When the desk fires the next cue the cursor returns to live (tick **Keep cursor offset** to hold the offset instead). Key faces: `$(thenoteslist:cue_cursor)` (with `cue_cursor_label`), `$(thenoteslist:cue_live)`; the **Cue cursor is NOT on the live cue** feedback turns a key amber while you are stepped away. Presets under "Cue cursor", including two display-only keys: **Display: live cue** (number + label, green when the desk is connected) and **Display: note cue** (the cursor, amber while stepped away from live).

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

Under **Presets** you get one ready-made key per note type of your show ("New note · Cue Notes" → Cue, Director, Stage Manager…): the editor action with that type, the key coloured like the chip in the app, and the console's live cue on the face. Drag them onto the deck.

## Feedbacks

- **Colour key by note type** / **by priority** — background matches the chip colour in the app (renamed or recoloured types follow within a minute).

- **Outstanding count above threshold** — colour a button when a module has more than N open notes.
- **Connected** — station is paired and the production accepts it.

## Variables

`$(thenoteslist:cue_outstanding)`, `work_outstanding`, `production_outstanding`, `electrician_outstanding`, `station_name`, `production_name`, `pairing_code`, `connected`.
