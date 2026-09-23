# Publishing this module to the Bitfocus store — findings (2026-09-23)

Written by the agent working in the app repo, for whoever is working in THIS repo.
Nothing below has been applied here; the working tree was left as found.

## How the Bitfocus process works

- Modules are released through the **Bitfocus Developer Portal** (https://developer.bitfocus.io, sign in with GitHub).
  Sidebar → **My Connections** → select the module → **Submit Version** → choose a git tag → Submit.
  Only versions submitted there are reviewed; reviews are by volunteers, feedback comes back in the portal,
  and an approved version is immediately downloadable by Companion v4.0.0+ users.
- A release is: bump `package.json` `version` (`major.minor.patch`; the build overrides
  `companion/manifest.json`'s version from it) → create a git tag `v<version>` (GitHub release or `git tag`) → submit.
- **Getting the module listed in the first place is a human step**: Bitfocus asks you to request a repository
  by posting in their Slack, channel `#module-development`, with your GitHub username and the module name in
  `manufacturer-product` form. Their docs do not say whether a repo hosted in our own org can be listed instead;
  assume the request is required and ask in the same message whether
  `The-Notes-List-LLC/companion-module-thenoteslist` can be linked as-is.
- Naming convention everywhere (repo, `package.json` name, `manifest.json` id, HELP.md):
  `companion-module-<manufacturer>-<product>`, all lowercase. Today the repo is `companion-module-thenoteslist`
  and the manifest id is `thenoteslist` — one segment, not two. Pick the product segment before the request
  (e.g. `thenoteslist-notes`); Nick decides.
- Sources: https://companion.free/for-developers/module-development/module-lifecycle/releasing-your-module/ ,
  https://companion.free/for-developers/module-development/module-development-101/ ,
  https://github.com/bitfocus/companion-module-requests (a request issue is NOT needed for an already-written module).

## State of this repo as found (main @ 5f3a5ca, 2026-09-04)

- Builds clean (`npm run build`), packages clean (`npx companion-module-build` → `thenoteslist-0.1.0.tgz`,
  with three license-inventory warnings for `osc`, `slip`, `wolfy87-eventemitter` — informational).
- `npm run lint` is BROKEN: ESLint 9 needs `eslint.config.mjs`; none exists. The fix that works is
  `import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'` exported as default with
  `{ enableTypescript: true }`, PLUS adding `typescript-eslint` (and whatever else the config imports) to
  devDependencies — without it the config fails with `Cannot find package 'typescript-eslint'`.
- No `LICENSE` file at the root, although `package.json` and the manifest say MIT and the packager writes
  `pkg/LICENSE` (a generated dependency inventory, not ours). Reviewers will expect a real MIT file
  (`Copyright (c) 2026 The Notes List LLC`).
- `pkg/` and the `.tgz` are TRACKED in git; they are build output. `.gitignore` only has `node_modules` and `dist`.
  Add `pkg` and `*.tgz` and `git rm --cached` them.
- No git tags yet; the GitHub repo is PRIVATE (must be public for the store).
- `companion/HELP.md` and `README.md` are current and good; `manifest.json` runtime is node18 / api nodejs-ipc 1.12.0.

## Done in this repo since (2026-09-23)

- `npm run lint` works: `eslint.config.mjs` uses the Companion preset with TypeScript; Prettier formatting is
  off (the code keeps its own layout), everything else passes.
- `LICENSE` (MIT, The Notes List LLC) at the root.
- `pkg/` and `*.tgz` gitignored and untracked.
- manifest runtime node22, apiVersion 1.14.1; `npm run package` builds clean.

- Name chosen: `thenoteslist-buttons` (matches the app's "Button stations"). package.json, manifest id/name/shortname
  (with `legacyIds: ["thenoteslist"]`), products `Button Stations`, README and repo URLs updated; the GitHub repo
  itself still has to be renamed to `companion-module-thenoteslist-buttons`.

- Repo renamed to `companion-module-thenoteslist-buttons` and made public; `v1.0.0` tagged (2026-09-23).
- Repository request posted in Bitfocus Slack (2026-09-23): GitHub user `nicksolyom`, module `thenoteslist-buttons`,
  asking whether the org repo can be linked as-is or must move/fork into the bitfocus org. Awaiting reply.

Still open: Bitfocus's answer on the repo; then Submit Version `v1.0.0` in the developer portal.

(Earlier list, for reference: renaming the GitHub repo, making it public, the tag, the Slack request and the portal submission.)

## Suggested order

1. Decide the two-segment name; rename repo + package + manifest id + HELP references together.
2. Lint config + license + gitignore (above), commit.
3. Make the GitHub repo public.
4. Tag `v1.0.0` (or `v0.1.0` marked prerelease).
5. Slack `#module-development` request; then Submit Version in the portal.

Context on the app side: contract in `docs/BUTTON_STATIONS.md` of the app repo; issue The-Notes-List-LLC/thenoteslist#907
stays open for this and the native Elgato plugin.
