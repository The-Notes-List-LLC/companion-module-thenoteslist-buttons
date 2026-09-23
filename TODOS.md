# TODOs

From the gstack eng / CEO / design reviews of 2026-09-23 (module code at 7a2180d, Companion v5.0.5).
Line numbers refer to that commit.

## Eng — bugs and risks

### High

- [x] **Detect a silently dead Eos connection.** After the walk the reader sends nothing; no `/eos/ping`, keepalive or reply deadline. A rebooted desk or pulled cable leaves the socket half-open, `close` never fires, `cue_live` freezes and notes land on a stale cue. (`src/eos.ts:130-171`)
  - Send `/eos/ping` every 5 s; `socket.close()` if nothing arrives in ~10 s.
- [x] **`eos_connected` feedback stays green while disconnected.** It returns `cues.length > 0 || liveCue !== null`, neither of which is cleared on close. (`src/main.ts:486`)
  - Drive it from a boolean set by `onStatus`; blank cue variables while disconnected.
- [x] **Cursor is stored as a sheet index, not a cue.** An insert/delete on the desk or a reconnect clears `byIndex`; after the re-walk the index points at a different cue and a note goes one cue off with no warning. (`src/main.ts:60`, `src/eos.ts:137,262`)
  - Store the cursor as a cue number (plus offset hint) and resolve the index on demand.
- [x] **Stepping onto an uncached index falls back to the live cue** while `selected_cue_offset` is non-zero, and New note uses the live cue. (`src/main.ts:263,267,281-282`)
  - Show `selected_cue` as blank / "…" while the target loads instead of falling back to live.
- [x] **Pairing success never started the paired session.** Companion saves a module's own `saveConfig` with `skipNotifyConnection`, so `configUpdated` never ran: status stayed "PAIR CODE…" and nothing polled until restart. Fixed: `pollPairing` calls `configUpdated` itself; the Eos reader only restarts when desk settings change.

### Medium

- [ ] **No fetch timeout.** Node fetch has no default deadline. (`src/api.ts:18`)
  - Pass `signal: AbortSignal.timeout(8000)`.
- [ ] **Polls overlap.** `setInterval` fires `refreshCounts` every 5 s whether or not the last call finished; requests pile up on a slow server. (`src/main.ts:103`)
  - Use a `setTimeout` chain started after each call finishes, or an in-flight guard.
- [ ] **Pairing poll race.** Poll A gets the token, poll B (already in flight) gets 409/410 and sets "Pairing ended" right after a successful pair. (`src/main.ts:126,137-171`)
- [ ] **`configUpdated` can run concurrently** (`void` from `init` plus a user save). Both runs push intervals after their awaits, doubling polling; a superseded run can start pairing with the old config. (`src/main.ts:65,84-106`)
  - Bump a generation counter on entry; return after each await if it changed.
- [ ] **Counts polling ignores network errors.** Only 401/402/403/410 are handled; timeouts / DNS / ECONNREFUSED leave status OK and counts stale. After revocation every tick makes 2 requests forever. (`src/main.ts:337-340`)
  - On any error mark disconnected and blank counts; on 401 stop the counts timer.
- [x] **Reconnect only partly resets reader state.** `ready` clears `byIndex` but not `walkAnnounced`, `queue`, `queued`; `onQueueIdle` then returns early and unanswered indexes are never retried. (`src/eos.ts:134-147,208`)

### Low

- [ ] Duplicate desk requests: background entries are never in `queued`, so an index enqueued at high priority while still in `background` is sent twice. Check `byIndex.has(i)` in `drain`. (`src/eos.ts:182-195`)
- [x] `cues` getter copies and sorts the whole map on every call (several per `publishCursor` / feedback check); `labelOf` is a linear scan. Cache a sorted array plus a number→index map, rebuilt on cache change. (`src/main.ts:54`, `src/eos.ts:93-101`)
- [x] `selected_cue_offset` counts indexes (parts included) but keep-offset counts base cues; one step over a part shows 2. Use `baseOffset()`. (`src/main.ts:246-250`)
- [x] Forward step can come to rest on a part at the end of the list (`next < max` guard). (`src/main.ts:263`)
- [ ] Verify OSC framing on port 3032: the `osc` library's `TCPSocketPort` always SLIP-encodes what it sends (it extends `SLIPPort`); `useSLIP: false` only changes decoding. Eos documents 3032 as OSC 1.0 length-prefixed. It works against the desk today, so check whether Eos tolerates it or the "Use TCP SLIP" box is what's in use. Seen while testing with a fake desk.
- [ ] One record stays unanswered on some walks (desk reports 1802, walk ends at 824 cues + 977 parts, the one retry doesn't recover it; another walk the same day got all 825). Harmless unless the cursor steps onto it (it then waits, "still loading"). Consider retrying missing indexes again when the cursor reaches them, or logging which index it is.
- [ ] `describe()` shows "fetch failed" and drops `e.cause.code` (ENOTFOUND, ECONNREFUSED…). (`src/main.ts:657`)

### Packaging / housekeeping

- [x] `pkg/` and `thenoteslist-0.1.0.tgz` are committed and date from Sep 2, older than every commit in the last-15 log. Gitignore both.
- [ ] `manifest.json` `apiVersion` 1.12.0 vs installed `@companion-module/base` 1.14.1.
- [ ] Runtime `node18` is end-of-life; move to `node22`.
- [ ] Token is stored in plain config and appears in config exports; move it to `secrets` (base 1.14).
- [x] HELP.md says the reader subscribes "once the list is cached"; the code subscribes on connect.
- [x] HELP.md still mentions a display-only key under "Selected cue" presets; check wording after the LIVE preset removal.

### Tests (none exist)

- [x] Add vitest with fake timers.
- [ ] Inject a socket factory into `EosReader` so tests can script OSC in and record what's sent. Cover:
  - by-number reply at index -1 is never cached
  - count change triggers a re-walk
  - notify → re-fetch via `walkAll`
  - reconnect resets state
  - live-cue window requests go before background
  - no duplicate sends
- [x] Extract the cursor into a pure `CueCursor` class and test:
  - stepping over parts both ways, and bounds
  - keep-offset across parts
  - uncached targets
  - insert above the cursor
- [ ] Mock fetch for the instance and test:
  - pairing success path
  - overlapping pair-poll race
  - concurrent `configUpdated`
  - slow counts request

### Architecture

- [ ] One HTTP scheduler: one call in flight, per-request timeout, backoff on errors, generation token so config changes cancel superseded runs.
- [x] Explicit Eos health: ping with deadline; a single connected flag drives variables and feedbacks.
- [x] Reader exposes an indexed view (sorted array + number map) rebuilt only on cache change.

## App side (thenoteslist repo)

- [ ] **Button stations page doesn't refresh when a station collects its token.** After pairing, the page kept saying "waiting for Companion" until a manual reload, although the module had paired (log: "Paired as …") and was polling. Seen 2026-09-23. It should poll or subscribe until the pair is claimed.
- [ ] Starting a second pairing from the same Companion connection revokes the first station (the module revokes its old token on purpose). Consider showing "replaced by a new pairing" instead of a bare revoked row.

## Features (CEO review)

The job in the booth is "mark this moment on this cue without looking away from the stage". Opening the editor in the browser tab should not be the only loop.

### Do next

- [ ] **One-press capture.** Use the unused `createNote()` in `src/api.ts` (it already takes an idempotent id). A press creates a real note on the selected cue with type/priority and a "[needs text] <cue label>" description; text is filled in later. Offer a "Capture" preset beside each ADD key. (S module-side; app needs a draft flag or "needs text" filter — M)
- [ ] **Show the highlighted note on the deck.** App pushes highlight state back (note id, cue, first ~16 chars, status, priority colour) as variables plus a HIGHLIGHTED display key, so SET DONE isn't pressed blind. (M; needs a tab→station state channel: poll or SSE)
- [ ] **Success / failure flashes on keys.** Green OK, red FAIL, amber "tab not open". Today a failed or unheard command is silent. (S for create; for tab commands `sent: true` must mean a tab received it — M server-side)

### Later

- [ ] "That last note" key using the unused `setLastStatus()` — cancel or re-prioritise a mis-capture without finding it. (S, endpoint exists)
- [ ] Priority modifier key (tap to cycle LOW/MED/HIGH, next capture uses it) instead of type × priority presets. (S)
- [ ] Open-note count for the selected cue on the NOTE key, e.g. "47.5 · 3 open". (M; needs counts-by-cue endpoint)
- [ ] Offline queue for captures, retried with the same idempotent id. (S–M)
- [ ] Hold-to-record voice memo, transcribed into the description (via the paired browser tab). (L; audio storage + transcription)
- [ ] Native QLab reader — only if asked; before grandMA3. (M)

### Don't build

- More Eos features (multi-list, part targeting, pending cue) before capture works.
- Text entry on the deck (T9, macros).
- Anything that sends commands to the console — read-only is a selling point; say so in the listing.
- Presets for every type × priority × module.
- More blind destructive status keys before the highlighted-note echo ships.

## Button design (design review)

Scores: hierarchy 3, colour meaning 3, error-proofing 3, consistency 4, legibility 5, state/feedback 5, brand 5.

### Fixes

- [ ] **Action colours on Highlighted-note keys.** All are module purple, so SET CANCL looks like NEXT NOTE. Green (#16a34a) Done, red (#dc2626) Cancel, neutral dark (#1f1f1f) for next/prev/undo/redo/To Do. (`src/main.ts:580-594`)
- [ ] **Text collides with the N** on Go-to keys (WORK / PROD / ELEC NOTES) and NEXT / PREV NOTE. Apply the bottom-align rule from `brand.ts`, or drop the N on those keys. (`src/main.ts:573,586-587`)
- [ ] **"ADD ___ NOTE" spends 2 of 3 lines on filler.** Make the type word (SM, DIR) 24px with a small "ADD" label; drop "NOTE". (`src/main.ts:562`)
- [x] **LIVE key green means "Eos connected", not "on the live cue".** Green only when on live; grey "NO DESK" when the desk is offline. (`src/main.ts:604,607`)
- [ ] **Baselines jump across a row.** UNDO / REDO are `right:bottom` beside centred keys; put every key on one baseline. (`src/main.ts:592-593`)
- [ ] **NOTE display key**: 14px label unreadable at booth distance, and it looks pressable. 12px "NOTE ON" label, 24px number, outline style so it reads as a display. (`src/main.ts:608`)
- [ ] **Chip colours can clash with module colours** (ADD SM / ADD PROG ≈ Cue purple; ADD PROD grey ≈ empty keys). Darken a chip colour that sits within a small ΔE of a module or action colour. (`src/brand.ts` `keyStyle`)
- [ ] **Preset category order is alphabetical**, burying Selected cue. Prefix: "1 · Selected cue", "2 · New note · …", "3 · Highlighted note · …", "4 · Go to module".
- [ ] **Go-to keys could show outstanding counts** (`$(…:work_outstanding)`, red when > 0); variables and feedback already exist.
- [ ] Consider Companion 5 layered drawing for presets — needs a module SDK upgrade past 1.12 first.

### Key-face system (proposal)

- 72 px key, 4 px margin.
- Zone A (top 18 px): small 10–12 px caps label (ADD / SET / GO / CUE); N only where Zone A is otherwise empty (Go-to, LIVE).
- Zone B (bottom 50 px): one main word, right-aligned, same baseline on every key. 24 px for ≤ 4 chars, 18 px for 5–6. Never 14 px for content.
- Colour: module colour = navigation only; chip colour = ADD keys only; action colour overrides both; amber reserved for "off live".
- Destructive keys (CANCEL): red, and consider press-and-hold or double-tap.

```
ADD SM NOTE      SET DONE         SET CANCL
+----------+     +----------+     +----------+
|       ADD|     |       SET|     |  ! CANCEL|  red bg
|          |     |          |     |          |
|        SM|     |      DONE|     |      HOLD|
+----------+     +----------+     +----------+
 chip colour      green bg

◀ CUE            LIVE             GO TO WORK
+----------+     +----------+     +----------+
|◀ PREV CUE|     |N     LIVE|     |N  GO TO  |
|          |     |          |     |       12 |  $(work_outstanding)
|       957|     |       957|     |      WORK|
+----------+     +----------+     +----------+
 amber off live   green on live;   work blue
                  grey NO DESK
```

### User's own deck (not code)

- [ ] Re-drag presets: page 2 ADD keys and page 3 NOTE key (text over the N) are stale copies; deck buttons don't pick up preset changes. Add a "re-drag presets" note to the changelog.
- [ ] Page 1 has two identical LIVE keys; page 3's manual keys duplicate the Highlighted-note presets.
