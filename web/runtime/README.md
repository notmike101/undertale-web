# Butterscotch runtime

Unmodified upstream WebAssembly runner from [ButterscotchRunner/Butterscotch](https://github.com/ButterscotchRunner/Butterscotch), revision `f6f1d30a2f933e5e0e77941251c7bd38e361a2ce`.

- CI build: <https://github.com/ButterscotchRunner/Butterscotch/actions/runs/38919991284>
- Artifact: <https://nightly.link/ButterscotchRunner/Butterscotch/actions/runs/38919991284/butterscotch-web.zip>
- License: [GNU AGPL v3](LICENSE)
- Complete corresponding source, including build files and vendored dependency notices: [butterscotch-source.zip](butterscotch-source.zip)

No Undertale game data is included here. The runtime consumes the user's own GameMaker game files.

## Restore

Run `pwsh -File scripts/setup-runtime.ps1` from the repository. It downloads the pinned public CI artifact and complete source, verifies SHA-256, and extracts a private source copy. CI artifacts may eventually expire; the checked-in runtime and source archive preserve this build.

## Rebuild from source

The source archive includes upstream CMake files and `.github/workflows/build-other.yml`. With Emscripten, CMake 3.21+ and Ninja installed, extract the source and run:

```sh
emcmake cmake -B build -G Ninja -DPLATFORM=web -DBACKEND=web -DCMAKE_BUILD_TYPE=Release -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON
cmake --build build
```

Copy the resulting `build/butterscotch.mjs` and `build/butterscotch.wasm` together. Upstream CI used its current Emscripten SDK; a rebuild with a different SDK need not be byte-identical. This integration used the verified upstream artifact without compiling a local replacement.

## Browser integration

Import the default factory from `butterscotch.mjs`, then await the factory with `print` and `printErr` callbacks. The browser must provide WebAssembly JavaScript Promise Integration (`WebAssembly.Suspending` and `WebAssembly.promising`) and WebGL 2. Run on the page's main thread for the upstream Web Audio backend.

Set `module.specialHTMLTargets['#canvas'] = canvas`. The exposed `module.FS` supports game-file loading and in-memory `readFile`, `writeFile`, `readdir`, `stat`, `mkdir`, `mkdirTree`, `rename`, and `unlink`. There is no `FS.syncfs`; the launcher persists its `/saves` contents with IndexedDB. The caller chooses a separate save directory and passes it with `--save-folder`. Upstream also exports an optional async `_mountOpfs()` that mounts browser storage at `/butterscotch`; this integration does not require it.

There is no `callMain`. Allocate each command-line string with `module.stringToNewUTF8`, allocate a pointer array with `module._malloc((args.length + 1) * 4)`, write pointers with `module.setValue(pointer, value, '*')`, and add a trailing null pointer. `await module._startRunner(args.length, argvPointer)` runs until game exit; free the strings and array afterwards. Pass the game's data-file path as the first argument. `_requestRunnerExit()` requests a clean stop.

Use `_onKeyDown(code)` and `_onKeyUp(code)` for GML keyboard codes: arrows 37–40, Enter 13, Escape 27, Z 90, X 88, C 67. These enqueue input for the next game frame. Mouse functions are also exported. The runtime can post `{ type: 'windowTitle', title }` messages to the page.

For observations, start with `--dump-frame-json-file /state.json`, then enqueue F11 (122). After the next frame, read `/state.json` as UTF-8 JSON. It contains `frame`, `room`, active `instances` with positions and self variables, `tiles`, and `globalVariables`. The observation is a snapshot, not a save-state format. Upstream handles `game_restart()` internally; `game_end()` resolves the start promise after cleanup, allowing the launcher to persist saves and offer relaunch.

## SHA-256

| File | SHA-256 |
| --- | --- |
| butterscotch.mjs | `95ef6132dc9fbe4b4905535faf7c8bb96697967406395c8f272c29db2d02a31e` |
| butterscotch.wasm | `b4a887dca6f68f5e85cece10cd17bf8349798f0a60990533140ba03111b733b8` |
| butterscotch-source.zip | `c2836fe2376d96b89cbea58404d08fb2509d3cf32ec2665848b0a891b91390e5` |
| Upstream CI zip | `8ac4b5999fa4182aa5b70708bcbe1ff569cd6e43822970589ce466bdefb6c9df` |
