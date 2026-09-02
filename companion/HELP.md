# The Notes List

Drive one production of [The Notes List](https://thenoteslist.com) from your Companion surface.

## Pairing

1. Add this connection. Leave **Base URL** as `https://thenoteslist.com` unless you are on beta/alpha.
2. Tick **Start pairing** and save. Close and reopen the connection's settings: the 6-character code is shown large at the top. It is also in the Log tab, the status text, and the variable `$(thenoteslist:pairing_code)` (drop it on a button to read it off the deck).
3. In The Notes List, open the show → **Settings** → **Button stations**, type the code, give the station a name, press **Pair**.
4. Within a few seconds the status turns **OK**. The token is stored in this connection; you never see it.

A station belongs to one production. To move to another show, revoke it in Settings and pair again.

## Actions

- **Create note** — module (Cue / Work / Production / Electrician), text, priority, type.
- **Set status of last created note** — Complete, Cancelled, In Review (Work Notes only), or back to To Do. Applies to the last note *this station* created.

## Feedbacks

- **Outstanding count above threshold** — colour a button when a module has more than N open notes.
- **Connected** — station is paired and the production accepts it.

## Variables

`$(thenoteslist:cue_outstanding)`, `work_outstanding`, `production_outstanding`, `electrician_outstanding`, `station_name`, `production_name`, `last_note_status`, `connected`.
