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

- **Create note** — module (Cue / Work / Production / Electrician), text, priority, type.
- **Set status of last created note** — Complete, Cancelled, In Review (Work Notes only), or back to To Do. Applies to the last note *this station* created.

- **Open the new-note editor in my open tab** — pops the Add Note dialog in your browser tab that is on that module's page (Cue Notes lands you in the cue number field). Only your own tabs react; nothing happens if none is open.

- **Tab: highlight next / previous note**, **Tab: set status of the highlighted note**, **Tab: undo / redo**, **Tab: jump to module** — all act on YOUR open browser tab (clicking a row in the app also highlights it).

## Feedbacks

- **Outstanding count above threshold** — colour a button when a module has more than N open notes.
- **Connected** — station is paired and the production accepts it.

## Variables

`$(thenoteslist:cue_outstanding)`, `work_outstanding`, `production_outstanding`, `electrician_outstanding`, `station_name`, `production_name`, `last_note_status`, `connected`.
