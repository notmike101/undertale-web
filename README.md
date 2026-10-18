# Undertale Web

Play your installed Undertale game in Chrome or Edge, with original game bytecode running in WebAssembly, keyboard/touch controls, browser saves and an AI controller.

The browser host uses [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch). This repository includes its pinned runtime, a small character-input patch, complete corresponding runtime source and license. **No Undertale game assets or recovered game code are included.**

## Play on Windows

```powershell
py -3 tools/serve.py
```

Open **[http://127.0.0.1:8766](http://127.0.0.1:8766)** and click **Play installed copy**. The default game directory is `C:\Games\steam\steamapps\common\Undertale`. Alternatively, double-click `start.bat` or use `npm start`.

For another installation:

```powershell
py -3 tools/serve.py --game-dir "D:\Games\Undertale" --port 8766
```

The installation is read-only. Native Steam saves are not touched. Browser progress lives in IndexedDB for this exact address and browser profile. Use the game's normal SAVE points; export a backup with **Export save**. A different port, hostname or browser profile has separate progress.

**Controls:** arrows move, Z/Enter confirm, X/Shift cancel, C opens the menu. Touch controls appear on touch devices. Pause, fullscreen, save export and relaunch are below the canvas. Ordinary typed text and Backspace are forwarded for in-game text entry.

## AI play

See **[AI controller and playing instructions](docs/AI_PLAYING.md)**. The page exposes:

```js
await undertaleAgent.pause();
await undertaleAgent.look();
await undertaleAgent.act(['ArrowRight'], 250);
await undertaleAgent.act(['z'], 80);
await undertaleAgent.resume();
```

The API supports observations, screenshots, bounded key actions, text entry and pause/resume. It uses real game inputs rather than editing game state.

## Portable static hosting

Serve the contents of `web/` on HTTPS or localhost, using `application/wasm` for `.wasm` and JavaScript MIME for `.mjs`. Use **Import game folder** to select an owned installation containing `data.win`, `credits.txt`, and the `.ogg` tracks. Files are read locally in the browser and are not uploaded. The installed-copy shortcut is available only with the included loopback server. Folder selection must be repeated after a page reload; saves persist separately.

## Development

```powershell
npm ci
npm run lint
py -3 tools/inspect_game.py --help
pwsh -File scripts/setup-runtime.ps1
```

JavaScript uses both requested configurations from `notmike101/eslint-configs`, pinned as local upstream package archives. `npm run lint` enforces zero warnings on authored code. Generated third-party runtime glue is excluded. No frontend framework or bundling step is required.

The browser runtime is already built. Optional Windows rebuilding is documented in [runtime provenance and build instructions](web/runtime/README.md). The development toolchain stays in ignored `.private/`.

## Evidence and limits

- [Current status](planning/STATUS.md)
- [Reverse-engineering findings](docs/REVERSE_ENGINEERING.md)
- [Focused playability observations](docs/PLAYABILITY.md)
- [Runtime license](web/runtime/LICENSE), [complete runtime source](web/runtime/butterscotch-source.zip), [local patch](patches/runtime.patch)

This uses **WebAssembly + WebGL 2**, not WebGPU. Current Chrome/Edge with WebAssembly JSPI support is required; other browsers are not claimed supported. The entire original archive and music are loaded, rather than a recreated subset of scenes. Opening gameplay has been exercised, but **start-to-finish route completion and perfect parity are unverified**. Per the requested priority, this work focused on playability and targeted runtime checks rather than a broad test suite.

Unofficial project; Undertale belongs to Toby Fox. The open-source runner and its licenses do not grant redistribution rights to Undertale assets.
