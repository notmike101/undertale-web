# Installed UNDERTALE inspection

Inspected the user's installation at `C:/Games/steam/steamapps/common/Undertale`
on 2026-10-17. This report describes static observations. It does not claim a
complete playthrough or behavioral equivalence with the original runner.

## Reproduce the inventory

```powershell
py -3 tools/inspect_game.py 'C:/Games/steam/steamapps/common/Undertale'
```

The standard-library-only inspector reads installed files without modifying or
executing them. Its default output is `.private/reports/game-inventory.json`.
The report contains installed-file hashes, chunk boundaries, resource counts,
room metadata, function names, and static function callers. It exports no
images, audio, dialogue, decompiled code, or save contents. It deliberately
accepts WAD v16 only. Malformed sizes, pointers, and reference cycles fail.

## Source identity

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `data.win` | 62,921,978 | `b718f8223a5bb31979ffeed10be6140c857b882fc0d0462b89d6287ae38c81c7` |
| `UNDERTALE.exe` | 4,136,960 | `c8c4191026bf5587a6fad120855b8b82ffb4fa0c3eaf10515be472ad84248e58` |
| `steam_api.dll` | 215,120 | `64eb5531bbee05db713dcd47e4a74c59e27bf067b0cfe9603eeaea5a4601fe90` |

There are 219 regular files at the installation root, including 212 external
Ogg audio files. Embedded audio is additional to those external files. The
inventory hashes every root file, so later installation changes can be detected.

## Container and execution model

`data.win` begins with `FORM`; its declared payload size exactly matches the
remaining file length. The first `GEN8` payload begins at file offset `0x10`.
Its byte at offset `0x11` is `0x10`: WAD/bytecode version **16**. The stored
runtime version tuple is `1.0.0.1539`; this field should not be used as a precise
compiler-release identifier. The default window is 640 by 480. Every room's
stored speed is 30 steps per second.

| Chunk | Meaning | Records |
| --- | --- | ---: |
| `ROOM` | Rooms | 336 |
| `OBJT` | Objects | 1,709 |
| `SPRT` | Sprites | 2,583 |
| `BGND` | Backgrounds | 249 |
| `PATH` | Paths | 45 |
| `SCPT` | Scripts | 238 |
| `CODE` | Bytecode entries | 6,272 |
| `FUNC` | Referenced function records | 427 |
| `STRG` | Strings | 63,977 |
| `FONT` | Fonts | 20 |
| `TPAG` | Texture-page items | 6,550 |
| `TXTR` | Embedded textures | 26 |
| `SOND` | Sound definitions | 443 |
| `AUDO` | Embedded audio | 231 |
| `EXTN` | Extension definitions | 0 |
| `SHDR`, `TMLN`, `GLOB`, `AGRP` | Shaders, timelines, globals, audio groups | 0 each |

The room sequence begins `room_start`, `room_introstory`, `room_introimage`,
`room_intromenu`, `room_area1`, `room_area1_2`. Menu rooms store a 320 by 240
logical room size; the first area stores 680 by 260. A port must honor views and
room dimensions instead of assuming every room equals the 640 by 480 window.

The `FUNC` table has 240 builtin names and 187 referenced game-script names,
classified by exact membership in `SCPT`. The inspector follows each function's
v16 occurrence chain and maps the instruction address back to its `CODE` entry.
This is evidence of compiled references, not evidence that every branch runs.

Format interpretation was checked against the primary UndertaleModTool sources:
[general header](https://github.com/UnderminersTeam/UndertaleModTool/blob/master/UndertaleModLib/Models/UndertaleGeneralInfo.cs),
[function records](https://github.com/UnderminersTeam/UndertaleModTool/blob/master/UndertaleModLib/Models/UndertaleFunction.cs),
and [code records/reference chains](https://github.com/UnderminersTeam/UndertaleModTool/blob/master/UndertaleModLib/Models/UndertaleCode.cs).

## Persistence and platform calls

Observed save-related string literals are `file0`, `file8`, `file9`,
`undertale.ini`, `system_information_962`, and `system_information_963`.
These are filename evidence, not an exhaustive specification of save semantics.
The inspector never reads the user's existing saves.

Static call chains connect `scr_saveprocess` to the game's `ossafe_file_text_*`
write wrappers, and `scr_load` to their read wrappers. Those wrappers in turn
reference the runner's `file_text_*` builtins. `ossafe_ini_open` references both
`ini_open` and `ini_open_from_string`; `ossafe_ini_close` references `ini_close`.
Other compiled references include `file_exists`, `file_delete`, `file_rename`,
`ini_read_real`, `ini_write_real`, `ini_read_string`, and `ini_write_string`.

`SCR_GAMESTART` references `steam_initialised`, `steam_file_exists`, and
`steam_file_delete`. Later events also reference `steam_file_write_file`.
Browser persistence therefore needs to preserve the game's filesystem model;
pretending a save succeeded without a persistence implementation would be wrong.
The browser runtime's Steam fallback needs separate implementation inspection.

There are no extension definitions in `EXTN`, and no builtin `external_*`
references among the 240 builtin function records. This narrowly establishes
absence from those tables; it does not prove the native runner has no platform
dependencies. Window calls include fullscreen, positioning, centering, captions,
and size queries. `game_end` and `game_restart` are compiled into the game, so
browser exit/restart behavior is a compatibility concern. Keyboard and gamepad
functions are both present.

REA independently inspected `steam_api.dll` through its target-free PE resource
parser. Evidence ID:
`ev_2504e397e7f8a0536014427cffda4db2be92db29bcab28a15f302ce8f30e8962`.
It identified PE32/x86 (machine 332), three resource records, and the SHA-256
above. Coverage was complete for its bounded resource tree. This inspection did
not execute Steam, inspect exported function behavior, or prove cloud-save calls
succeed. Native EXE inspection is a separate evidence layer.

## Runner compatibility decision

[Butterscotch's primary README](https://github.com/ButterscotchRunner/Butterscotch)
lists WAD v16 and Web support, and includes Undertale v16 examples. That matches
the installed container's format and supports reusing its bytecode interpreter
instead of recreating the game logic or rewriting all 336 rooms. Upstream also
warns that matching the format version does not guarantee game compatibility.

The evidence supports the architecture, not a claim that every route works.
Unresolved behavior includes late-game events, exact collision/rendering parity,
audio timing, Steam fallbacks, browser exit/restart handling, and persistence
after a browser reload. Runtime verification and any observed limitations belong
in the delivery notes; this static report should not be read as those checks.

No tests were created or run for this inspection, as requested. The inventory
command itself was executed against the installed data to produce the report.
