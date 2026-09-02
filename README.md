# companion-module-thenoteslist

Bitfocus Companion module for [The Notes List](https://thenoteslist.com). Spec: The-Notes-List-LLC/thenoteslist#910.

- Pair from the connection config (a 6-character code you type into the show's Settings).
- Actions: create note, set status of the last note this station created.
- Feedbacks: outstanding count above threshold, connected.
- Variables: per-module outstanding counts, station and production name.

## Develop

```bash
npm install
npm run build          # → dist/
```
Load as a developer module: point Companion's *Developer modules path* at the parent
folder of this repo (Settings → Developer). See `companion/HELP.md` for user docs and
`docs/BUTTON_STATIONS.md` in the app repo for the API contract.
