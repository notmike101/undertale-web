# Play Undertale with an AI agent

The controller is available as `globalThis.undertaleAgent` in the game page. It feeds the same runtime input queue as human keyboard/touch controls. It does not teleport, edit HP, rewrite saves, or simulate an alternate game.

## Start

1. Run `py -3 tools/serve.py` in this repository (or `npm start`).
2. Open `http://127.0.0.1:8766` in current Chrome or Edge.
3. Click **Play installed copy**. On a static host, use **Import game folder** and select your own Undertale installation.
4. Wait until `undertaleAgent.status().running` is `true`. Startup normally takes a few seconds.
5. Use your browser tool's JavaScript evaluation to call the API below. With Playwright, use `page.evaluate(() => globalThis.undertaleAgent.look())`.

Keep the same browser profile and exact origin to retain progress. The local development server listens only on loopback. No account or external game service is needed.

## Controller

| Call | Result / behavior |
| --- | --- |
| `status()` | Synchronous lifecycle, error, source, pause state and last 15 log messages. |
| `await look()` | Compact room/frame, HP/LV/plot, actor positions and writer string fields. Start here. |
| `await observe()` | Full original-runner JSON snapshot: frame, room, instances, variables, tiles and globals. Use when compact state lacks a needed detail. |
| `screenshot()` | PNG data URL of the game canvas. Browser screenshots are also supported and show the surrounding controls. |
| `await pause()` | Pause the runner while thinking. |
| `await resume()` | Resume continuous human gameplay. |
| `await act(keys, milliseconds = 100)` | Hold supported keys together for 0–5000 ms, release, return full observation. If paused initially, resume for the action and pause again afterwards. |
| `await type(text)` | Feed up to 256 printable ASCII characters to the real text-input path, spaced across frames; useful for Mettaton's essay. |
| `release()` | Release all held gameplay keys. |
| `await save()` | Flush files the game has already written into IndexedDB; returns `true` on success. This does **not** create an in-game SAVE or capture arbitrary game state. |
| `keys` | Supported key names. Arrows, letters, digits, space, Enter, Escape, Shift, Backspace and common punctuation. |

Normal controls: arrows move/select; Z or Enter confirms/interacts; X or Shift cancels/skips text; C opens the menu. For character naming, use the original on-screen letter grid. Text input does not replace navigation controls.

## Decision loop

```js
await undertaleAgent.pause();
const scene = await undertaleAgent.look();
// Read scene, and inspect a screenshot when text or geometry is unclear.
await undertaleAgent.act(['ArrowRight'], 250);
await undertaleAgent.act(['z'], 80);
const nextScene = await undertaleAgent.look();
```

`act()` returns a full state object. Avoid dumping that whole object into a model context on every call. Project only what you need inside the browser evaluation:

```js
await page.evaluate(async () => {
    await globalThis.undertaleAgent.act(['ArrowUp'], 200);
    return globalThis.undertaleAgent.look();
});
```

Use short actions near exits, menus, hazards and battles. `act([], 200)` lets animations/dialogue advance without holding keys. Do not run actions or observations concurrently. Wait for each Promise before issuing the next call. Pausing is for agent thinking time; action duration is wall-clock time, **not deterministic frame stepping**. Transitions and scheduling can add frames. Read the returned `frame` rather than assuming an exact count.

Use screenshots to interpret the current battle/menu/text. Writer fields may contain control codes or more text than is currently visible; they are supporting observations, not a guarantee of on-screen text. Actor coordinates are game/world coordinates and may require the full snapshot's view state to map to screen positions. Do not treat every visible actor as an enemy.

Play according to the human's requested route. Do not change game globals, jump rooms, import fabricated saves or invoke unexposed debug keys to claim a legitimate playthrough. A new run begins from the ordinary menus and uses ordinary interactions. When a SAVE point is reached, complete its menu interaction and then call `save()`. The **Export save** button creates a portable backup.

When the game intentionally closes, `status().running` becomes false and the page offers **Relaunch**. Relaunch preserves the game's persistent files, which Undertale may use across restarts. Do not clear browser storage to bypass the game's consequences.

## Limits

- The controller is implemented and opening gameplay has been exercised; this is not a claim that an autonomous agent has completed a route.
- Pause/resume and input use the actual runner. The game is not paused automatically just because an agent is thinking unless `pause()` was called.
- ASCII text input matches this runner's character-input support. IME/non-ASCII composition is not implemented.
- Use one active game tab per origin. The launcher takes a browser lock to protect saves from another tab.
- If saving returns false, export a backup and inspect the page log. Relaunch refuses to proceed after a failed final save.
