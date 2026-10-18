# Butterscotch runtime

WebAssembly runner based on [ButterscotchRunner/Butterscotch](https://github.com/ButterscotchRunner/Butterscotch), revision `f6f1d30a2f933e5e0e77941251c7bd38e361a2ce`, with one local browser text-input patch dated **2026-10-17**.

- Original upstream CI build: <https://github.com/ButterscotchRunner/Butterscotch/actions/runs/38919991284>
- Original upstream artifact: <https://nightly.link/ButterscotchRunner/Butterscotch/actions/runs/38919991284/butterscotch-web.zip>
- License: [GNU AGPL v3](LICENSE)
- Complete corresponding source, including build files and vendored dependency notices: [butterscotch-source.zip](butterscotch-source.zip)

No Undertale game data is included here. The runtime consumes the user's own GameMaker game files.

The local patch adds an exported `onCharacter` input callback to `src/backends/web.c` and exports it in `CMakeLists.txt`. The upstream web backend forwarded key presses but did not update `keyboard_lastchar` or `keyboard_string`, preventing text entry such as the Mettaton essay. Character events now pass through the same frame input queue as key events and call the existing shared keyboard implementation. The patch is recorded in the repository's `patches/runtime.patch`; the source archive already includes it. There are no collision or gameplay-rule changes.

## Restore

Run `pwsh -File scripts/setup-runtime.ps1` from the repository. It verifies the checked-in runtime and complete modified source against SHA-256, then extracts a private source copy if none exists. The shipped files work without downloading upstream CI artifacts, which may eventually expire. This setup does not overwrite an existing private source checkout.

## Rebuild from source

The source archive includes upstream CMake files and `.github/workflows/build-other.yml`. With Emscripten, CMake 3.21+ and Ninja installed, extract the source and run:

```sh
emcmake cmake -B build -G Ninja -DPLATFORM=web -DBACKEND=web -DCMAKE_BUILD_TYPE=Release -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON
cmake --build build
```

Copy the resulting `build/butterscotch.mjs` and `build/butterscotch.wasm` together. A rebuild with a different SDK need not be byte-identical. The shipped files were rebuilt locally with the browser text-input patch described above.

The Windows build used **Emscripten 6.0.12**, **CMake 4.4.4**, **Ninja 1.13.2**, and the SDK's **Python 3.13.3 / Node 24.19.0**. All tools were installed in ignored `.private/` folders, without permanent environment changes. After installing/activating that SDK in `.private/emsdk`, run `pwsh -File scripts/build-runtime.ps1`. CMake and Ninja may be on PATH or installed with `py -3 -m pip install --target .private/build-tools cmake==4.4.4 ninja==1.13.2`. The script builds `.private/Butterscotch` into `.private/runtime-build`; it does not automatically replace the shipped artifact.

The browser renderer is upstream's WebGL 2 backend. A WebGPU renderer would require a separate renderer implementation and was not needed to run the original game's existing drawing operations.

## Browser integration

Import the default factory from `butterscotch.mjs`, then await the factory with `print` and `printErr` callbacks. The browser must provide WebAssembly JavaScript Promise Integration (`WebAssembly.Suspending` and `WebAssembly.promising`) and WebGL 2. Run on the page's main thread for the upstream Web Audio backend.

Set `module.specialHTMLTargets['#canvas'] = canvas`. The exposed `module.FS` supports game-file loading and in-memory `readFile`, `writeFile`, `readdir`, `stat`, `mkdir`, `mkdirTree`, `rename`, and `unlink`. There is no `FS.syncfs`; the launcher persists its `/saves` contents with IndexedDB. The caller chooses a separate save directory and passes it with `--save-folder`. Upstream also exports an optional async `_mountOpfs()` that mounts browser storage at `/butterscotch`; this integration does not require it.

There is no `callMain`. Allocate each command-line string with `module.stringToNewUTF8`, allocate a pointer array with `module._malloc((args.length + 1) * 4)`, write pointers with `module.setValue(pointer, value, '*')`, and add a trailing null pointer. `await module._startRunner(args.length, argvPointer)` runs until game exit; free the strings and array afterwards. Pass the game's data-file path as the first argument. `_requestRunnerExit()` requests a clean stop.

Use `_onKeyDown(code)` and `_onKeyUp(code)` for GML keyboard codes: arrows 37–40, Enter 13, Escape 27, Z 90, X 88, C 67. These enqueue input for the next game frame. Mouse functions are also exported. The runtime can post `{ type: 'windowTitle', title }` messages to the page.

Call `_onCharacter(characterCode)` for typed characters in addition to their key-down events. Preserve actual case and punctuation; for browser keyboard events use `event.key.codePointAt(0)`. Backspace uses character code 8. The existing upstream `keyboard_lastchar` implementation supports printable ASCII (32–126), sufficient for the game's essay. Automated text entry should send one character per game frame because the game reads the last character seen that frame.

For observations, start with `--dump-frame-json-file /state.json`, then enqueue F11 (122). After the next frame, read `/state.json` as UTF-8 JSON. It contains `frame`, `room`, active `instances` with positions and self variables, `tiles`, and `globalVariables`. The observation is a snapshot, not a save-state format. Upstream handles `game_restart()` internally; `game_end()` resolves the start promise after cleanup, allowing the launcher to persist saves and offer relaunch.

## SHA-256

| File | SHA-256 |
| --- | --- |
| butterscotch.mjs | `fad2f26692c9b61fed73090e4f378afcade8a09103fefcb4b079eaf989ace966` |
| butterscotch.wasm | `b202189311012d24d5cbaf2f941ff40373a3cbaad03a969bfe81c23e93aaf5d2` |
| butterscotch-source.zip | `0afa091a94ec3115d0bb27ccef7445facebf2ebac7e773d967d3a9603b4519b8` |
| Upstream CI zip | `8ac4b5999fa4182aa5b70708bcbe1ff569cd6e43822970589ce466bdefb6c9df` |
