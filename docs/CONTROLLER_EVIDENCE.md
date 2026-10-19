# Controller observations and dialogue boundaries

This is an implementation mapping for the installed WAD v16 game, SHA-256
`b718f8223a5bb31979ffeed10be6140c857b882fc0d0462b89d6287ae38c81c7`.
It contains metadata and behavioral descriptions, not copied game dialogue.
Evidence is the private UndertaleModTool 0.9.2.0 decompilation under
`.private/utmt/all/CodeEntries`. Source filenames and line numbers below refer
to that exact corpus. These are static observations, not a full-route playthrough.

## What counts as currently visible dialogue

The important family is `obj_base_writer` (object 783), whose children are
`OBJ_WRITER` (784), `OBJ_NOMSCWRITER` (786), `OBJ_INSTAWRITER` (787), and
`obj_flowey_writer` (1604, through `OBJ_NOMSCWRITER`). The parent relationships
were read from `OBJT`; inherited events matter even when a child has no own Draw
or Step code.

| Self variable | Meaning | Safe exposure |
| --- | --- | --- |
| `originalstring` | Current page, after desktop button substitution | Raw current-page data only; includes unrevealed suffix and formatting commands. |
| `stringpos` | Number of raw characters reached by the typewriter | Use as the reveal boundary before decoding formatting. |
| `stringno` | Index into this writer's page array | Useful page metadata; insufficient as a unique history key. |
| `mystring` | Page queue copied from `global.msg` when the writer starts | Do not present as visible dialogue. |
| `halt` | Writer control state set partly during drawing | Interpret using the table below and the surrounding interaction context. |
| `dfy` | External destruction request | `1` makes Begin Step destroy the writer. |
| `textspeed`, `alarm[0]` | Reveal cadence and scheduled reveal step | Timing information, not page completion. |
| `writingx`, `writingy`, `writingxend`, `myfont`, `mycolor`, `vtext` | Layout/style | Retain when reconstructing text placement. |

`global.msg`, `global.tmsg`, `global.rmsg`, and the writer's `mystring` may hold
future or previous text. They are not a transcript of what the player has seen.
`global.typer` is a text style/speaker preset, not a reliable speaker name.
`global.facechoice` and `global.faceemotion` can add presentation metadata, but
should not be promoted to an unverified named speaker.

Evidence: `gml_Object_obj_base_writer_Create_0.gml:6-16`,
`gml_Object_obj_base_writer_Alarm_0.gml:1-81`, and
`gml_Object_obj_base_writer_Draw_0.gml:11-18`.

### Decode only the revealed prefix

The renderer iterates raw character positions 1 through `stringpos`. Stop at
the first `/` or `%` encountered, even if the counter has advanced beyond it.
Do not strip formatting from the whole page and then slice by `stringpos`:
format commands consume raw positions without producing text.

| Raw command | Display/control effect |
| --- | --- |
| `&` | Explicit newline. |
| `^` followed by a nonzero digit | Delay metadata; neither character is rendered. |
| `^0` | A literal caret is rendered, and the zero is skipped. |
| Backslash plus `R/G/W/Y/X/B/O/L/P/p` | Color change; no displayed characters. |
| Backslash plus `E/F/M/T/S` and one following argument | Emotion, face, flag, style, or sound control; no displayed characters. |
| Backslash plus `C` | Triggers choice setup; no displayed characters. |
| Backslash plus `z` and an argument | A special graphical symbol, not ordinary text. |
| Backslash plus `*` and an argument | A control-button sprite. Preserve as a named button/icon token when known. |
| Backslash plus `>` and an argument | Choice-column positioning. Argument `1` selects the right column; other values select the left. |
| `/` | Stops rendering and sets a wait/control state; following marker determines which. |
| `%` | Automatic page transition; doubled `%` destroys the writer. |

Unknown backslash commands should remain recorded as unknown formatting rather
than being guessed as dialogue. Ordinary asterisks are ordinary displayed
characters. Width-based automatic line wrapping is additional to explicit `&`;
plain-text output need not pretend to reproduce exact screen wrapping.

Evidence: `gml_Object_obj_base_writer_Draw_0.gml:19-307` and `309-318`.

### Halt states and accepted actions

| `halt` | Observed meaning | Generic confirm behavior |
| ---: | --- | --- |
| 0 | Revealing or otherwise not stopped at a control delimiter | No generic advance. Wait, or reveal only when the enclosing dialog permits it. |
| 1 | `/`: next page waits for confirmation | Advances `stringno`, replaces `originalstring`, resets `stringpos` to 0. |
| 2 | `/%`: close waits for confirmation | Clears confirm and destroys the writer. |
| 3 | External forced destruction | Begin Step destroys; not a confirmation prompt. |
| 4 | Slash followed by caret and nonzero argument: battle handoff | Sets `global.myfight=0`, `global.mnfight=1`, destroys writer. |
| 5 | Choice state | Context-specific; outside battle, consult `obj_choicer`. Battle instant writers also use this value. |
| 6 | `/*`: special scripted stop | The generic confirmation handler has no branch for this value. Do not assume confirm advances it. |

Evidence: `gml_Object_obj_base_writer_Other_10.gml:1-19`,
`gml_Object_obj_base_writer_Other_11.gml:1-14`,
`gml_Object_obj_base_writer_Step_1.gml:11-14`, and Draw lines 276-307.

The base writer's Step calls its confirmation event on control 0. An overworld
`obj_dialoguer` permits control 1 to reveal the current page only when its
writer has `halt==0` and `global.typer!=10`. Battle reveal additionally requires
`obj_battlecontroller.active==1`, `global.mnfight==0`, and `global.flag[21]==0`.
Revealing and advancing are different actions. A held key produces only one
logical control press until released.

Evidence: `gml_Object_obj_base_writer_Step_0.gml`,
`gml_Object_obj_dialoguer_Step_0.gml:1-16`,
`gml_Object_obj_battlecontroller_Step_0.gml:403-415`, and
`gml_Script_control_update.gml:31-35`.

## Recording every observed page

An after-frame snapshot alone is insufficient. The writer's Draw event changes
`originalstring`, `stringno`, and `stringpos` when `%` is reached, and destroys
the instance on `%%`. An instant writer can reveal and disappear within one
draw. Capture before drawing, after alarm/step updates, and retain after-draw
state as a separate phase. Rendered text submission capture is stronger for
unusual writers and objects whose text is generated during Draw.

History must retain completed or interrupted entries when a writer disappears,
changes page, or resets its reveal counter. `scr_msgup` resets `stringno` to zero
on a surviving instance and replaces the page queue. Therefore use a local page
generation in addition to instance identity, page number, and raw-page changes.
Keep the longest actually observed revealed prefix for each generation; never
fill its unseen suffix from the raw page queue. Identical text on a later page
is still a distinct occurrence. Include monotonically increasing event/frame
IDs so a slow controller can request events after its last acknowledged ID.

If retention is bounded, report the earliest retained ID and a gap indicator.
Do not silently claim complete history after dropping entries. Snapshot capture
must not press confirmation or alter writer variables. Avoid using a debugger
key to observe: it is also delivered to the game's key-event machinery.

Evidence: `gml_Object_obj_base_writer_Draw_0.gml:294-307`,
`gml_Object_OBJ_INSTAWRITER_Create_0.gml:1-3`, and
`gml_Script_scr_msgup.gml:1-15`.

### Independent writers and rendered-text fallback

| Object | Already revealed field | Full/future field | Visibility/completion evidence |
| --- | --- | --- | --- |
| `obj_FinalWriter` (1687) | `string1` | `string0` | Draw only when `active==1`; `at` is the next character position, `stringln` the full length. Completion of reveal does not imply player confirmation is accepted. |
| `obj_songwriter` (1207) | `newstring` | `sting` | Draw when `active==1`; `scoord` counts revealed characters; `off` fades out when allowed. |
| `obj_essaystuff` | `mystring` | None for user-entered text | Text-entry buffer is drawn directly; `keyboard_present && cantype==1` accepts typing. |

Evidence: respective Create, Alarm, and Draw files; especially
`gml_Object_obj_FinalWriter_Draw_0.gml:11-21`,
`gml_Object_obj_songwriter_Draw_0.gml:1-18`, and
`gml_Object_obj_essaystuff_Step_0.gml:1-82`.

Objects with `writer` in their name are not all dialogue: damage writers draw
numbers/sprites, and `obj_mettatonnn_writer` draws a repeated visual effect.
Conversely, menus and scripted scenes can call text drawing without any writer
object. Capturing `draw_text`, `draw_text_ext`, and transformed variants with
position/style metadata closes much of this gap. It does not recover text baked
into sprites, or prove a draw is unoccluded or on the final displayed surface.
Keep screenshots as complementary evidence and label these coverage limits.

## Choices and control contexts

`control 0` is Z or Enter; `control 1` is X or Shift; `control 2` is C or Control.
The game computes pressed edges from its own previous control state. Tap then
release between menu steps rather than expecting a long hold to select again.
Evidence: `gml_Script_control_update.gml`.

| Context | Evidence-backed condition | Useful state and action guidance |
| --- | --- | --- |
| Two-choice overworld prompt | `obj_choicer` exists | `mychoice` is 0/1; either Left or Right toggles. Confirm is accepted only if `canchoose==1 && choiced==0`. `creator` identifies the writer. `global.choice` remains -1 until accepted. Labels come from visible writer text and its choice-position anchors. |
| Overworld movement | `obj_mainchara.movement==1` with an `obj_overworldcontroller` instance and `global.interact` absent or 0 | Arrows move; facing is 0 down, 1 right, 2 up, 3 left. Confirm interaction also requires `uncan==0`; C opens the menu unless `global.flag[17]` is nonzero (the menu opened while `global.flag` was absent). Live observation (2026-10-18, issue #6): a fresh `room_area1` after the scripted intro never creates the `interact` global, so requiring `interact==0` misread playable play as `unknown-or-cutscene`; held arrow keys moved `obj_mainchara` while the classifier fell through. |
| Overworld menu | `global.interact==5`, or an open overworld `menuno>=0` with `obj_mainchara` and `obj_overworldcontroller` present | Live observation (2026-10-18, issue #6): pressing C in a fresh `room_area1` opened the menu while `interact` stayed absent, so `interact==5` alone never fires there; `menuno` moved -1 to 0 and `menuchoice` appeared as `[1,1,0,0]` with `menucoord` absent, and X returned `menuno` to -1. `menuno`, `menucoord`, `menuchoice` expose page, selection, and availability. Root 0, inventory 1, stats 2, phone 3, save 4, item action 5, storage 6/7, dialogue 9. |
| Battle menu | `global.inbattle==1`, `mnfight==0`, `myfight==0`, controller `active==1` | `bmenuno` selects submenu; see table below. Writer presence does not make this modal dialogue. |
| Attack timing | `global.myfight==1` and an active `obj_targetchoice` variant | Confirm when the moving cursor is appropriately positioned. Standard variant accepts only while `image_speed==0`; expose cursor x/hspeed and target bounds. Weapon variants need their own timing details. |
| Dodge | `global.mnfight==2` with an active heart | Arrows move according to heart `movement` mode; control 1 slows standard red-heart movement. `shot==1` allows control 0 shooting. Do not describe all colors/modes as ordinary free movement. |
| Battle response choice | `global.myfight==3` and writer `halt>0` | `bmenucoord[6]` selects the two responses; confirm changes the battle response state. |
| Typed essay | `obj_essaystuff.keyboard_present && cantype==1` | Printable key/character pairs append `keyboard_lastchar`; Backspace edits; timeout is managed by `endbuffer` and alarms. Ordinary confirm/cancel controls are excluded from entered text. |

Battle menu coordinates:

| `global.bmenuno` | Selection variable | Meaning |
| ---: | --- | --- |
| 0 | `bmenucoord[0]` | Root actions: FIGHT, ACT, ITEM, MERCY, indices 0-3; some battles restrict actions. |
| 1, 2, 11 | `bmenucoord[1]` | Monster target slots; `monster[]` determines active slots. |
| 10 | `bmenucoord[2]` | ACT options; `choices[]` is availability, not text labels. |
| 3 through less than 4 | `bmenucoord[3]` plus page offset | Inventory page; English uses 3 and 3.5, Japanese also uses smaller page increments. |
| 4 | `bmenucoord[4]` | Mercy submenu. |
| 6 | `bmenucoord[6]` | Special two-choice battle response. |

Relevant battle globals include `hp`, `maxhp`, `turn`, `mytarget`, `monster`,
`monstername`, `monsterhp`, `monstermaxhp`, and `idealborder`. Global metadata can
contain information beyond what is visibly displayed; label this as game state,
not dialogue. Infer allowed actions conservatively, and let unknown phases
remain unknown instead of mapping every nonzero `myfight` value to attacking.

Evidence: `gml_Object_obj_choicer_Create_0.gml`, KeyPress 37/39 and Other 10;
`gml_Object_obj_mainchara_Step_2.gml:14-22`, Other 10 and Other 12;
`gml_Object_obj_overworldcontroller_Draw_0.gml`;
`gml_Object_obj_battlecontroller_Step_0.gml:96-110,223-292,403-476`;
`gml_Object_obj_battlecontroller_KeyPress_37.gml`, KeyPress 38;
`gml_Object_obj_heart_Step_0.gml:1-33`;
`gml_Object_obj_heart_Keyboard_37.gml:1-18`;
`gml_Object_obj_targetchoice_Step_0.gml:34-70`.

Recommended precedence is specific input state before generic dialogue:
typed essay, actual choicer, active attack timing, dodge, active battle menu,
overworld menu, then ordinary writer wait/reveal state. Cutscenes can override
these combinations, so retain the raw conditions and confidence alongside a
friendly context name. Do not send Escape as a generic cancel; it can exit.

No test suite was added. This mapping does not establish complete coverage of
every bespoke boss, animated sprite caption, or room script.
