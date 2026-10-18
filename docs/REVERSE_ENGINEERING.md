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

## Focused missing-function investigation

The upstream runner's registration table initially omitted ten builtin names
present in this installed game's `FUNC` table. To distinguish active behavior
from unused or platform-specific code, UndertaleModTool CLI 0.9.2.0 was obtained
from its [official release](https://github.com/UnderminersTeam/UndertaleModTool/releases/tag/0.9.2.0).
The Windows archive SHA-256 is
`e7573e45d107be34f81f955c6e4afc3c7c8f2628e5a6f307a871e3825b3dfb40`.
The tool and all recovered code remain under ignored `.private/utmt`; no game
source or recovered code belongs in the distributable project.

The decompiler emitted 6,272 code-entry files. Focused entry dumps are in
`.private/utmt/decompiled/CodeEntries`, and the complete private search corpus is
`.private/utmt/all/CodeEntries`. The code analysis found:

| Missing registration | Static finding | Consequence / remaining limit |
| --- | --- | --- |
| `steam_file_delete`, `steam_file_write_file` | Calls are inside `steam_initialised()` or `global.steam_int == 1` guards. Only the successful initialization branch sets that flag to 1. | The runner's false Steam initialization fallback avoids these calls; local filesystem persistence remains necessary. |
| `buffer_async_group_option` | Only in the `osflavor > 2` console savedata branches. | Desktop filesystem path avoids it. |
| `get_string_async` | Essay input calls it only when `osflavor > 2`, indicating no keyboard. | Desktop path uses keyboard input. |
| `texture_set_interpolation` | Only inside `osflavor >= 3` application-surface presentation. | Desktop presentation avoids it. |
| `extension_stubfunc_real` | Used with an `os_type == os_ps4` condition. | Result is immaterial for desktop; eager boolean evaluation could still execute it. |
| `sprite_prefetch` | Texture warmup calls; return values unused. | Omitting warmup can affect timing but does not replace texture rendering. |
| `draw_getpixel` | Only two legacy effect objects, `obj_vaporized_old` (157) and `obj_vaporacquirer` (161). | Neither has room placements, inheriting children, or named references in the complete decompiled corpus. Dynamic numeric creation is not excluded by this bounded search. Active vapor effects use different objects. |
| `sprite_replace` | 65 unconditional attempts in Flowey initialization, all targeting missing `external/` files. | Embedded Flowey sprites exist; native failure semantics require separate inspection. |
| `sprite_collision_mask` | One unconditional call after those replacement attempts. | Its requested bounds differ from the embedded sprite; native mutability checks must be preserved before treating this as a required bounds change. |

The only discovered assignments to `global.osflavor` are in `obj_time` creation:
Windows maps to 1, PS4/Vita to 4, and all other platforms to 2. This conclusion
comes from searching all recovered code, not just startup strings.

### Flowey native mask guard

Raw PE address mapping ties the `sprite_collision_mask` registration at
`0x51d078` to native function `0x5185c0`, and `sprite_replace` registrations to
`0x517e00`. The game requests a manual rectangle for `spr_floweynuke` with left
13, top 44, right 34, bottom 100. The embedded sprite is 79 by 133 and has left
22, top 20, right 55, bottom 100. These are observed values; they alone do not
establish a gameplay mismatch.

REA/Ghidra inspection of the original native runner showed that the mask entry
looks up the sprite and calls helper `0x494190`. That helper returns before
changing bounds when the pointer at sprite offset `0x54` is nonzero and the byte
at `0x36` is zero. Later accesses identify `0x54` as a per-frame texture-entry
array; interpreting `0x36` as a dynamic/modifiable flag is an inference. This
guard is consistent with GameMaker's documented restriction that
[collision-mask mutation applies to added/duplicated sprites](https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Reference/Asset_Management/Sprites/Sprite_Manipulation/sprite_collision_mask.htm).
Blindly overwriting the embedded sprite's bounds would risk changing the game.

| REA operation | Evidence ID | Private report |
| --- | --- | --- |
| Native mask entry `0x5185c0` | `ev_b2a353caba39c25ce81141276b4039e448287d93a6d7954d7f8fe01d51b9051e` | `native-sprite-mask.json` |
| Mask application helper `0x494190` | `ev_d2660788703962b0cb0c0a02041a0b9d2f704103c5f054a7ea04926697aff61e` | `native-sprite-mask-apply.json` |
| Sprite lookup `0x498130` | `ev_acae84dd21a445a68af1c10c170ebb3b5211badec86e0d9a81ac661837f84d90` | `native-sprite-lookup.json` |

These reports are in `.private/reports`. Pseudocode is decompiler output, not
original source; precise original field names and live flag values remain
unobserved. The initial apparent collision discrepancy was therefore narrowed
to an unresolved mutability question rather than presented as a confirmed bug.

No tests were created or run for this inspection, as requested. The inventory
and decompiler commands were executed to produce the static evidence.
