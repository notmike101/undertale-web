# Status — 2026-10-17

## Current work

Initial two-hour implementation window: prioritize a playable full-data browser build, then focused real-runtime validation. No speculative test suite.

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
- Upstream Butterscotch supplies WebAssembly build; integration underway.

## Remaining

1. Launch real game in browser.
2. Human keyboard/touch, audio, browser save persistence.
3. Agent observations/actions and real gameplay evidence.
4. ESLint zero warnings, reproducible setup, compatibility notes.
5. Commit and push coherent increments; retain explicit unknowns about full-game completion.
