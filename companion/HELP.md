# The Notes List

Drive one production of [The Notes List](https://thenoteslist.com) from your Companion surface.

## Pairing

1. Add this connection. Leave **Base URL** as `https://thenoteslist.com` unless you are on beta/alpha.
2. Tick **Start pairing** and save. Close and reopen the connection's settings: the 6-character code is shown large at the top. It is also in the Log tab, the status text, and the variable `$(thenoteslist:pairing_code)` (drop it on a button to read it off the deck).
3. In The Notes List, open the show → **Settings** → **Button stations**, type the code, give the station a name, press **Pair**.
4. Within a few seconds the status turns **OK**. The token is stored in this connection; you never see it.

A station belongs to one production. To move to another show, revoke it in Settings and pair again.

## Following the lighting console

Add your console's own Companion connection (for ETC Eos: the **ETC Eos** module, OSC on port 3032, or 3037 with TCP SLIP; enable OSC TCP on the desk under Setup → System → Show Control). Set this module's **Console connection label** to that connection's label (default `eos`). Both note actions then default their **Cue number** to `$(eos:cue_active_num)`, the desk's live cue, resolved at the moment you press. Change it per key to `$(eos:cue_pending_num)` for the next cue, or any other module's variable.

## Actions

Everything acts on **your own open browser tab** of The Notes List, on the page for the chosen module. Other members' tabs never react.

- **New note (opens the editor in your tab)** — module, type and priority (this show's real choices), cue number (defaults to the console's live cue). Opens the Add Note dialog prefilled; you finish the text at the keyboard.
- **Highlight next / previous note** — moves the blue ring through the visible list. Clicking a row in the app also highlights it.
- **Set status of highlighted note** — Complete, Cancelled, In Review (Work Notes only) or back to To Do.
- **Undo / Redo**.
- **Go to module** — navigates your tab to another module of the same show.

## Feedbacks

- **Outstanding count above threshold** — colour a button when a module has more than N open notes.
- **Connected** — station is paired and the production accepts it.

## Variables

`$(thenoteslist:cue_outstanding)`, `work_outstanding`, `production_outstanding`, `electrician_outstanding`, `station_name`, `production_name`, `pairing_code`, `connected`.
