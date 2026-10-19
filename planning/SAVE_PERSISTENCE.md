# Save persistence and save-management scope — 2026-10-19

Investigation requested: save game state in browser storage or a local file (File System Access API or Origin Private File System) so saves persist without manual export, and browser-controlled save management for loading different stored saves at startup. This document scopes the current behavior, storage options, and the management design space. It records observations separately from claims and hypotheses. No product code was changed. GitHub feature request: [issue #14](https://github.com/notmike101/undertale-web/issues/14).

Automatic persistence already exists; export is only a backup path. In `web/app.js`:

- `openDatabase`/`saveTransaction` (lines 17–50): one IndexedDB database `undertale-web`, store `saves`, a single key `undertale` holding the whole `/saves` directory as an array of `{ name, data }`.
- `launch` (lines 266–272): restores that snapshot into `FS` `/saves` before the runner starts.
- `persistSaves` (lines 105–124): serialized through `saveQueue`, replaces the snapshot wholesale; called from a 2 s interval while running (line 280), after game exit (line 286) and on its error path (line 292), on `visibilitychange` hidden (lines 426–430), before Restart reload (lines 385–389), and from the controller `save` method (`web/agent.js` line 614).
- `acquireGameLock` (lines 131–146): a `navigator.locks` lease prevents a second tab overwriting saves.
- `exportSave` (lines 350–364) downloads `undertale-save.json` (`undertale-web-save-v1`); the launcher's Restore-save input (lines 390–425) replaces the snapshot and is disabled while a game is running.

Gaps that remain relative to the request:

1. Best-effort storage only. Zero `navigator.storage` references in `web/*.js`. A live probe on the game origin returned `navigator.storage.persisted() === false`, so the snapshot is evictable under storage pressure.
2. One implicit snapshot per origin. No listing, naming, selection, per-save export, or deletion; loading always takes key `undertale`. Multiple playthroughs require manual export/rename/re-import.
3. OPFS is compiled into the runtime but unused. `web/runtime/butterscotch.mjs` exports `_mountOpfs` (the minified artifact contains 88 `opfs` and 57 `OPFS` string occurrences); `web/runtime/README.md` line 37 states it mounts browser storage at `/butterscotch` and that "this integration does not require it."
4. End-to-end save durability is unverified: `docs/PLAYABILITY.md` lines 18–29 record that the named-game SAVE/Continue cycle has not been exercised; only a storage transaction succeeded.

## Live probe (2026-10-19, automation Edge 155.0.0.0, http://127.0.0.1:8766)

- `WebAssembly.Suspending` present (JSPI available).
- `navigator.storage.getDirectory` present (OPFS reachable), `navigator.storage.persist` present, `persisted()` → `false`.
- `estimate()`: usage ≈ 1.98 MB, all attributed to `indexedDB`.
- `showDirectoryPicker` present (File System Access API, Chromium-only).
- `navigator.locks.request` present.
- Existing IDB `undertale-web` v1, key `undertale` → `file0` (1114 B), `file9` (1114 B), `undertale.ini` (93 B). This matches the save filename evidence in `docs/REVERSE_ENGINEERING.md` lines 77–78 (`file0`, `file8`, `file9`, `undertale.ini`): the game's own save slots and its INI already live inside the one browser snapshot.
- Launcher controls observed: `play-local`, `import-folder`, Restore-save file input, `pause`, `fullscreen`, `export-save`, `restart`.

## Storage options considered (evaluation, not proposals)

1. IndexedDB snapshot (current). Works everywhere the game runs, survives reloads; but best-effort unless the persistent-storage flag is granted, and each persist rewrites the whole snapshot.
2. Persistent Storage flag (`navigator.storage.persist()`). Chromium grants it heuristically (or via persistent-context heuristics); Firefox requires a prompt. Not currently requested anywhere in the app. This changes durability of the existing store, not its shape.
3. OPFS via the runtime's `_mountOpfs()`. The compiled runtime already supports mounting OPFS at `/butterscotch`; the integration instead uses `--save-folder /saves` with the IndexedDB snapshot. Untested from this codebase: whether `_mountOpfs` accepts a mount path, its synchronous-OPFS-worker semantics under JSPI, and how game-side `file_*`/`ini_*` writes behave there. OPFS is also eviction-eligible without the persistent flag.
4. File System Access API (`showDirectoryPicker`). Would give real user-visible files, but needs a user gesture per session unless handles are kept in IndexedDB (Chromium-only), and conflicts with the no-interaction launch flows and the controller path.

Hypothesis (unconfirmed): options 1+2 are the minimal durable base; option 3 could remove the snapshot round-trip but its runtime behavior is unmeasured here.

## Save-management design space

- Multiple named snapshots: store per-save records (id, label, captured timestamp, file list) instead of one key; keep a "last active" selection so normal launches still resume automatically.
- Startup picker before `launch` binds the game: list stored saves with metadata, choose one as active, plus rename/delete/per-save export; keep Restore-save import as another source.
- Concurrency: management writes must respect the same `navigator.locks` lease used by launch and restore.
- Controller surface: the `save` method currently means "flush"; management adds listing/selecting semantics that must stay non-destructive by default.
- Migration: the existing single `undertale` key becomes the initial unnamed save record; existing users keep their progress.
- Interaction with in-game slots: the game already manages `file0`/`file8`/`file9` inside a snapshot; browser-level saves are snapshots-of-all-slots, not per-slot entries. A save record's label could be derived from detected file names plus capture time.

## Out of scope

- Syncing with native Steam saves (project decision: keep them separate).
- Cross-browser or cross-origin save sync (IDB is origin+profile-scoped; README documents this).
- Verifying full-route save fidelity (tracked separately as unverified in STATUS/PLAYABILITY).

## Evidence gaps

- No storage-pressure eviction experiment; `persisted() === false` only establishes eligibility.
- No end-to-end named-game SAVE → close → relaunch → Continue run under the current build.
- `_mountOpfs()` argument handling, error modes, and OPFS worker behavior untested.
- Persistence flush on abrupt tab close is `visibilitychange`-only and fire-and-forget; whether the final IndexedDB transaction commits was not tested (hypothesis only).
