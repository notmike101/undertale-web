# Browser playability evidence

Observed on October 17, 2026 in the headed Chrome session `undertale`, using the local app at `http://127.0.0.1:8766` and the user's local game files.

## Verified through ordinary game input

- Started the original game and used its naming menu to choose `A`.
- Walked through the opening room (`room_area1`, index 4).
- Completed the Flowey introduction and battle sequence (`room_floweybattle`, index 307), including the scripted drop to 1 HP and subsequent recovery to 20 HP.
- Entered the first Ruins room (`room_ruins1`, index 6).
- Reached the first SAVE point at player coordinates x=150, y=198 and opened its dialogue. The observed HP was 20.
- Browser screenshots showed the original game rendering while real directional and confirm/cancel inputs advanced gameplay. Private screenshots remain in `.private/` and are not distributed.

All gameplay actions used `undertaleAgent.act`; observations used `undertaleAgent.observe` and browser screenshots. No game-memory edits, fabricated saves, debug room changes, or route skips were used.

## Limits and discovered issue

This is an opening-sequence check, not evidence that any complete route, ending, or every room works. Gameplay stopped at the user's request before completing the first SAVE interaction. Save-and-Continue persistence has not been verified.

The initial browser session exposed `TypeError: fs.isFile is not a function` in the save adapter. That session could not persist its progress. The application was subsequently corrected to inspect the file mode instead.

## Refreshed application checks

After reloading the corrected application and starting the local game again:

- Startup reached `room_introstory` with `running: true`, `loading: false`, and no application error.
- `pause()` followed by two observations 500 ms apart returned the same frame, 268. The agent reported `paused: true`.
- `resume()` followed by a 500 ms wait advanced the observed frame to 286 and cleared the paused state.
- `save()` returned `true`; the UI displayed its normal first-SAVE prompt, with no save-adapter error in the recent logs. This checked a storage transaction before any new game SAVE existed; it does not establish persistence of named-character progress.
- `screenshot()` returned a PNG data URL, and a separate browser screenshot showed the rendered introduction.

The opening was not replayed after this reload. The refreshed screenshot is retained privately as `.private/refreshed-startup.png`.

## Realtime controller checks

The upgraded native frame hook was exercised against the installed game in Chrome. Calling the immediate native snapshot from inside the presentation callback succeeded without a runtime error. Introductory text was reconstructed from real draw submissions and retained across pages; no game dialogue is copied into this repository.

A persistent authenticated WebSocket client verified:

- Direct pause froze the frame; a 700 ms no-key action advanced frame 656 to 676 and returned to paused state.
- Seven rendered-text history records were available, and 11 events replayed without a sequence gap in the checked window.
- State events, command response correlation, and reconnect catch-up operated through the live browser bridge.
- A held right-arrow expired after the two-second watchdog and paused the game.
- Disconnecting the controlling socket released input and paused. A new observer could read the result.
- Cancelling text input with release-and-pause stopped the typing operation with an explicit cancellation error.

Focused synthetic checks cover broker authentication/origin checks, leases, pending-command disconnects, retention gaps, browser transport, hidden queued-text exclusion, dialogue growth and disappearance, context precedence, and pause-state publication. Run `node --test tests/controller-state.test.js tests/controller-socket.test.js` and `py -3 tests/test_controller.py`. All passed, as did `npm run lint` with both requested configurations and zero warnings.

These checks exercise the controller, not a full route. Rendered text is captured before compositing, so sprite lettering, clipping, offscreen surfaces, and later overdraw still require screenshot interpretation. Expected controls and text-page boundaries are inferred from game state and rendering evidence.

## Injected input reliability (issue 2)

Observed on October 18, 2026 in the headless automation Chromium session against the installed copy at `http://127.0.0.1:8766`, base revision `66d5838`.

Reproduced silent input loss on the unfixed controller: three sequential `keysDown` calls (16 letters each) queued 64 runner input events within one browser task, filling the runtime's 64-entry per-frame queue exactly. The next `act(['ArrowRight'], 100)` returned normally with `running: true`, `paused: false`, and frames advancing, while the naming-grid cursor stayed at (5,1): its key-down was the dropped 65th event. The following `act` registered, reproducing the reported "ignored press, accepted press, no signal" signature.

After the controller fix, the same sequence behaved differently: the second `keysDown` threw an explicit queue-budget error before injecting anything, `status().input.pendingInjections` held at 48 (never reaching the runtime limit), and both subsequent `act(['ArrowRight'], 100)` calls registered (cursor advanced on each). A ten-press `act` loop then registered 10/10 and four `keysDown`/`keysUp` cycles 4/4 at the same grid. Paused-then-running `act` calls kept working (cursor advanced while paused, action re-paused after a confirmed drain). Across roughly 300 actions: `stalledActions: 0`, `rejectedInjections: 0`, one `gatedWaits` (the flood), drain confirmation added no visible delay to ordinary actions.

This proves the queue-overflow loss mode is closed at the controller boundary and that runner pipeline stalls now surface as errors, counters, and page-log warnings instead of silent no-ops. It is not proof that the separate time-bounded episode from the original report had this same cause; the original intermittency did not reproduce in this environment on either tree.
