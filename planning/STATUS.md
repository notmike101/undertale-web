# Status — 2026-10-17

## Current work

Delivered a playable browser build and AI controller. The user explicitly stopped playthrough work to prioritize delivery; no complete-route run was attempted.

## Decisions

- Reuse Butterscotch's open-source C/WebAssembly GameMaker bytecode runtime.
- Serve a static browser application; a loopback-only Python development server can read this machine's authorized Undertale installation.
- Offer local folder import for other users; never publish game assets.
- Keep browser progress separate from native Undertale saves.
- Expose bounded keyboard actions and observations for AI play.
- Prefer upstream's working graphics backend first. A genuine WebGPU backend is not yet established; do not describe WebGL as WebGPU.

## Verified

- Repository initially empty, remote private: `notmike101/undertale-web`.
- Original executable identified by REA as x86 PE, SHA256 `c8c4191026bf5587a6fad120855b8b82ffb4fa0c3eaf10515be472ad84248e58`.
- Original `data.win` identified as GameMaker FORM archive, bytecode version 16.
- Original data contains 336 rooms and 6,272 code entries; 212 external music tracks plus credits are imported locally.
- Original opening, naming, movement, Flowey battle and first Ruins SAVE interaction exercised with real agent inputs.
- Rebuilt Butterscotch with a narrow character-input hook for typed in-game text. Complete source and patch shipped.
- Pause held frame268 unchanged across500ms; resume advanced to286. Screenshot and save transaction succeeded.
- Both requested ESLint configs enabled; authored JavaScript passes with zero warnings.
- Runtime restoration and optional local Windows build both executed successfully.

## Delivery

- Start: `py -3 tools/serve.py`, then `http://127.0.0.1:8766`.
- Controller instructions: `docs/AI_PLAYING.md`.
- Human keyboard controls, fullscreen, pause, IndexedDB save persistence, backup import/export and relaunch implemented.
- Active-game browser lock prevents concurrent tabs overwriting each other's saves.
- Loading cannot overwrite existing saves; relaunch waits for successful final persistence.

## Explicitly unverified / omitted

- Full routes/endings, complete fidelity, named-game SAVE/Continue cycle and device/browser matrix.
- WebGPU backend: uses working WebGL2 backend to prioritize the actual game.
- No public deployment or game-asset redistribution.
- No broad test suite, per user instruction. Focused evidence is in `docs/PLAYABILITY.md`.

## Realtime controller upgrade (implemented)

- Scope: runtime hooks, actions, rendered-text history, contextual guidance, loopback WebSocket broker, CLI and agent instructions.
- Capture every frame's submitted text; separate rendered observations from queued script text.
- Add session/sequence cursors, bounded replay with explicit gaps, and a controller lease. Preserve keyboard controls and browser-save isolation.
- Native immediate pause/state observation; semantic state sampled every three game frames. Realtime key holds expire after two seconds; controller disconnect releases inputs and pauses.
- Validate startup, draw capture, replay, action correlation, disconnect safety and zero-warning lint. No full playthrough.

- Live controller checks passed: rendered text and history, immediate pause, bounded actions, sequenced replay, held-key watchdog, controller disconnect pause, and typing cancellation.
- Focused JavaScript/Python controller checks passed; both required ESLint configs report zero warnings.
- Protocol and decision-loop guidance are in docs/AI_PLAYING.md; interpretation limits and live evidence are in docs/PLAYABILITY.md.

## Viewport layout

- Removed surrounding page chrome. Game retains its 640×480 resolution and scales to fit the viewport without cropping.
- Top-left pull-out menu holds pause/resume, fullscreen, export and restart; AI connection status overlays the game at top right.
- Browser verified at 1280×720 (960×720 game) and 600×900 (600×450 game), including fullscreen overlays. ESLint remains at zero warnings.

- Centering correction: explicit viewport-sized black stage and independently sized, absolutely centered game surface. Browser assertions passed at 600x900, 1280x720 and 900x900; stylesheet URL refreshed to invalidate stale styling.
