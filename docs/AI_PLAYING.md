# Play Undertale with an AI agent

The controller is available as `globalThis.undertaleAgent` in the game page. It feeds the same runtime input queue as human keyboard controls. It does not teleport, edit HP, rewrite saves, or simulate an alternate game.

## Start

1. Install the local controller dependency with `py -3 -m pip install -r requirements.txt`, then run `py -3 tools/serve.py` in this repository (or `npm start`).
2. Open `http://127.0.0.1:8766` in current Chrome or Edge.
3. Click **Play installed copy**. On a static host, use **Import game folder** and select your own Undertale installation.
4. Wait until `undertaleAgent.status().running` is `true`. Startup normally takes a few seconds.
5. Use your browser tool's JavaScript evaluation to call the API below. With Playwright, use `page.evaluate(() => globalThis.undertaleAgent.look())`.

Keep the same browser profile and exact origin to retain progress. The local development server listens only on loopback. No account or external game service is needed.

## WebSocket controller

The included server starts the broker at `ws://127.0.0.1:8767`. Change it with `--controller-port`; the HTTP port remains separately configurable with `--port`. If the dependency is missing or the controller port cannot bind, ordinary play remains available and `/api/controller` returns an explicit unavailable response.

The browser connects to `/bridge?token=...`; agents connect to `/agent?token=...`. Each server start creates a fresh secret in ignored `.private/controller.json`. The browser receives the same configuration from the same-origin `/api/controller` endpoint. Clients should read the file instead of displaying or copying the secret. Both listeners bind to `127.0.0.1`; the broker rejects other browser origins and allows origin-less local agent connections.

For the common operations:

```powershell
py -3 tools/agent_client.py status
py -3 tools/agent_client.py look
py -3 tools/agent_client.py watch
py -3 tools/agent_client.py history --after 120 --session SESSION_ID
py -3 tools/agent_client.py dialogueHistory --after-id 12
py -3 tools/agent_client.py act ArrowRight --ms 250
py -3 tools/agent_client.py type "hello"
py -3 tools/agent_client.py screenshot .private/view.png
```

Screenshot output refuses to overwrite an existing file. `watch` produces JSONL, retains the last event cursor in memory, and reconnects with bounded backoff. Ordinary commands run once and never retry automatically. A disconnect or timeout can leave an action's outcome unknown; observe the current state before deciding whether to repeat it.

Each connection receives a `hello` message containing `protocol`, `connected`, `sessionId`, `oldestSeq`, `latestSeq`, `lease`, and the latest compact `state` event. Send requests as JSON:

```json
{"type":"request","id":"move-1","method":"act","params":{"keys":["ArrowRight"],"milliseconds":250}}
```

Replies contain the same `id`, `type: "response"`, and either `ok: true` with `result`, or `ok: false` with `error`. Event messages have `type: "event"` and an `event` object containing `sessionId`, a strictly increasing `seq`, and an event `type`. Handle events while awaiting a response; they are interleaved on the same connection.

| Method | Parameters and purpose |
| --- | --- |
| `hello`, `status` | `{}`; broker connectivity, current session, latest state, and lease ownership. |
| `replay` | `{afterSeq: 0, sessionId: null}`; retained events, oldest/latest sequence, explicit `gap` and `sessionChanged` flags. |
| `acquire`, `release` | `{}`; explicitly claim or relinquish the input lease. Mutating requests also acquire it automatically. |
| `look`, `observe`, `screenshot`, `controls` | `{}`; read current compact/full state, PNG, or supported controls. |
| `dialogueHistory` | `{afterId: 0}`; browser-retained dialogue records after a record ID. This ID differs from transport `seq`. |
| `act` | `{keys: ["z"], milliseconds: 100}`; bounded press and release. |
| `type` | `{text: "hello"}`; at most 256 printable ASCII characters. |
| `keysDown`, `keysUp` | `{keys: ["ArrowRight"]}`; update held keys for a persistent real-time control loop. |
| `pause`, `resume`, `save` | `{}`; runner lifecycle and flushing game-created save files. |
| `releaseAll` | `{pause: true}`; release held inputs, optionally pausing. |

The broker gives only one connected client the mutating lease. Other clients can observe and watch events but receive `control_busy` when attempting mutations. Mutating commands are serialized: await each reply. When the controlling client disconnects or releases its lease, the broker asks the browser to release all inputs and pause. Disconnecting an observer does not pause gameplay. A one-shot CLI mutation therefore pauses on exit, including `resume`; use a persistent connection to keep gameplay running.

The broker retains at most 4,096 events or 8 MiB, whichever fills first. Browser reconnects resend retained events after the broker's last sequence. A missing prefix, sequence jump, or new browser session is explicit in replay/watch output. History is bounded diagnostic context, not a permanent transcript: callers needing durable history should save the JSONL locally. Server restarts discard broker history, and browser reloads start a new game session.

Rendered-text capture runs every presented frame, and compact state sampling runs every three frames: nominally 30 Hz text capture and 10 Hz state sampling at the game's 30 FPS. This is not a scheduling guarantee. Pausing stops frame presentation, and rendering delays can reduce these rates. See the practical decision guide below before treating captured text as dialogue or choosing an input.

## Controller

| Call | Result / behavior |
| --- | --- |
| `status()` | Synchronous lifecycle, error, source, pause state and last 15 log messages. |
| `look()` | Current compact state: context, control hints, player/battle data, rendered text, writer progress, actors, and capture provenance. Start here. |
| `observe()` | Raw runner snapshot including instances, variables, tiles and globals. It can contain queued or future text that has not been displayed. It is not the visible dialogue feed. |
| `screenshot()` | PNG data URL of the game canvas. Browser screenshots are also supported and show the surrounding controls. |
| `pause()` | Pause the actual runner immediately while deciding. |
| `resume()` | Resume continuous gameplay immediately. |
| `await act(keys, milliseconds = 100)` | Hold supported keys together for 0–5000 ms, release, and return compact `look()` state. If paused initially, resume for the action and pause again afterwards. |
| `await type(text)` | Feed up to 256 printable ASCII characters to the real text-input path, spaced across frames; returns compact `look()` state. |
| `release()` | Release all held gameplay keys. |
| `await releaseAll({pause: true})` | Cancel current agent input, release all keys, and optionally pause. |
| `keysDown({keys: ['ArrowRight']})` / `keysUp({keys: ['ArrowRight']})` | Update held keys for a persistent control loop; returns compact state. An unrefreshed hold releases and pauses after two seconds. Resume first if paused. |
| `controls()` | Current inferred context, underlying conditions, relevant input hints, and selection details. |
| `dialogueHistory({afterId: 0})` | Retained screen-text pages, with `oldestId`, `latestId`, and `gap`. The current page can grow under its existing ID. |
| `events(afterSeq = 0)` | Browser journal replay with `sessionId`, `events`, `oldestSeq`, `latestSeq`, and `gap`. This is the browser API; use broker `replay` over WebSocket. |
| `await save()` | Flush files the game has already written into IndexedDB; returns `true` on success. This does **not** create an in-game SAVE or capture arbitrary game state. |
| `keys` | Supported key names. Arrows, letters, digits, space, Enter, Escape, Shift, Control, Backspace and common punctuation. |

Normal controls: arrows move/select; Z or Enter confirms/interacts; X or Shift cancels/skips text; C or Control opens the menu where permitted. For character naming, use the original on-screen letter grid. Text input does not replace navigation controls. Escape can quit the game; it is not a universal back button.

## Read the scene before acting

`look()` is designed for decisions without exposing the writer's future dialogue. Its main fields are:

| Field | How to use it |
| --- | --- |
| `sessionId`, `frame`, `room` | Identify the current run and room. Reset your history cursors when the session changes. |
| `snapshotFrame`, `snapshotAgeFrames` | Check how old the sampled variables are relative to the presented frame. A state event may lag the newest rendered text by a few frames. |
| `context`, `controls` | An inferred control mode, specific observed conditions, selection details, and available input hints. Bespoke scenes can behave differently; use screenshots when the inference is uncertain. |
| `player`, `battle` | Selected player/battle variables such as HP, maximum HP, LV, plot, battle phase, and target health. Absent fields are not known values. |
| `dialogue.present`, `dialogue.writerPresent` | Whether a recognized text-writer instance exists. This does not establish that every captured string is spoken dialogue. |
| `dialogue.renderedTextPresent`, `dialogue.text`, `dialogue.lines` | Captured text draw commands, reconstructed into approximate reading order. These can contain menus, HUD labels, numbers, and speech. |
| `dialogue.waitingForConfirm`, `dialogue.writers` | Writer progress and halt markers. A true waiting flag means a writer is at a confirmation boundary; check context and any choice before advancing. |
| `dialogue.choice`, `dialogue.historyId` | Current choice details when recognized and the current screen-text page ID. |
| `actors`, `actorCount` | Up to 256 compact actor records and the total actor count. Coordinates are game/world coordinates; actors are not automatically enemies. |
| `capture.eventCursor`, `capture.droppedDraws`, `capture.coverage` | Event cursor and known capture limits. A dropped-draw count calls for screenshot inspection, not an assumption that missing text never appeared. |

Screen text is derived from rendering commands, not a complete speech transcript. Sprite-based lettering is not text-draw data. Occlusion, offscreen surfaces, and draw order can also make reconstructed text differ from the final visible pixels. A screenshot remains the reference for what is actually visible. Raw `observe()` may include control codes and future queued strings; do not quote those as words already shown to the player.

Start a decision with `look()`. Read `context`, then the rendered text, and then `controls.details`/`controls.actions`. If `dialogue.present` is true and `waitingForConfirm` is false, allow text to reveal or inspect the current writer phase before sending confirm. If a choice is present, select according to the human's requested route; do not automatically choose a highlighted option merely because a writer is waiting.

| Observed context | Practical input reference |
| --- | --- |
| `dialogue-revealing` | Wait with `act([], 100)`; X/Shift may finish the reveal when the current controller permits it. |
| `dialogue-wait` | After reading the page and checking for choices, Z/Enter advances or closes it. Release between presses. |
| `choice`, `battle-response` | Read the choices, use left/right to select, then confirm when allowed. `choice` includes `confirmReady`. |
| `overworld` | Short arrow holds move; Z/Enter interacts with an adjacent target when allowed. C/Control opens the menu when the hints permit it. |
| `overworld-menu`, `battle-menu` | Arrows select, Z/Enter confirms, X/Shift returns from a submenu. Battle menu details identify the current selection and root actions when available. |
| `battle-dodge` | Use small directional actions or a persistent held-key loop, informed by heart mode and screenshots. X/Shift slows standard free movement; shooting is available only when indicated. |
| `attack-timing` | Confirm attempts a timing hit; the weapon and scene determine the timing. The hint does not imply that attacking matches the requested route. |
| `text-entry` | Use `type(text)` and Backspace when entry is enabled. |
| `unknown-or-cutscene` | Wait briefly and inspect screenshots/state. Do not assume movement or confirmation is accepted. |

## Catch up on events and text

The browser journal retains 4,096 events and 500 screen-text pages. The broker separately retains up to 4,096 events or 8 MiB. These limits can be reached quickly during animated text; they are not a whole-game transcript.

| Event type | Payload and meaning |
| --- | --- |
| `state` | `event.state` is a compact observation from a fresh state sample. |
| `text-page-started` | `event.page` contains a new observed screen-text page/revision group. |
| `text-page-updated` | `event.page` updates the same page ID as text grows; replace your stored version rather than appending it as another spoken line. |
| `text-page-closed` | `event.pageId` identifies a page that no longer represents the current text. |
| `capture-gap` | Capture reached a limit, such as dropped draw commands. Inspect `reason` and `droppedDraws`; this is separate from a transport/history sequence gap. |

Use `events(lastSeq)` in browser tools or broker `replay({afterSeq, sessionId})` after reconnecting. Process in sequence, deduplicate repeated events, and inspect `gap`/`sessionChanged`. If there is a gap, obtain a new `look()` and screenshot and treat missing history as unknown. `dialogueHistory({afterId})` is a shorter catch-up view of retained pages; it includes an unclosed current page even when its ID equals `afterId`, because that page may have grown. For every observed text revision, replay events instead. Page IDs and event sequence numbers are different cursors, both scoped to the session.

## Bounded browser decision loop

```js
await undertaleAgent.pause();
const scene = await undertaleAgent.look();
// Read scene, and inspect a screenshot when text or geometry is unclear.
await undertaleAgent.act(['ArrowRight'], 250);
await undertaleAgent.act(['z'], 80);
const nextScene = await undertaleAgent.look();
```

`act()` returns compact state. Project the fields your next decision needs instead of dumping raw `observe()` snapshots:

```js
await page.evaluate(async () => {
    const scene = await globalThis.undertaleAgent.act(['ArrowUp'], 200);
    return { frame: scene.frame, context: scene.context, player: scene.player, dialogue: scene.dialogue };
});
```

Use short actions near exits, menus, hazards and battles. `act([], 200)` lets animations/dialogue advance without holding keys. Do not run actions or observations concurrently. Wait for each Promise before issuing the next call. Pausing is for agent thinking time; action duration is wall-clock time, **not deterministic frame stepping**. Transitions and scheduling can add frames. Read the returned `frame` rather than assuming an exact count.

For continuous held-key control, use one persistent connection, resume the runner, and send `keysDown`/`keysUp` as the selected action changes. Refresh an intended hold before the two-second watchdog expires; otherwise the browser releases the keys and pauses. Release unnecessary keys before changing direction. Pause during long model deliberation. Neither the watchdog nor the transport provides deterministic frame stepping.

Play according to the human's requested route. Do not change game globals, jump rooms, import fabricated saves or invoke unexposed debug keys to claim a legitimate playthrough. A new run begins from the ordinary menus and uses ordinary interactions. When a SAVE point is reached, complete its menu interaction and then call `save()`. The **Export save** button creates a portable backup.

When the game intentionally closes, `status().running` becomes false and the page offers **Restart**. Relaunch preserves the game's persistent files, which Undertale may use across restarts. Do not clear browser storage to bypass the game's consequences.

## Persistent Python decision loop

Run this from the repository root with the game already started. It reuses the CLI's credential loading and initial replay helper, then keeps a receiver running while a human or model decides. Requests are correlated with replies while events update the current scene. The example prompts for each decision instead of choosing a route: enter, for example, `{"method":"act","params":{"keys":["ArrowRight"],"milliseconds":100}}` only after checking that moving right is appropriate. Enter `quit` to release control. Replace the `input` call with your agent's decision function when integrating a model.

```python
import asyncio
import json
from tools.agent_client import DEFAULT_CONFIG, endpoint, request
from websockets.asyncio.client import connect

async def run():
    async with connect(endpoint(DEFAULT_CONFIG), proxy=None,
                       max_size=16 * 1024 * 1024) as socket:
        await socket.recv()  # Initial broker hello.
        replay, buffered = await request(socket, 'replay', {'afterSeq': 0})
        scene = {}
        session, sequence = replay['sessionId'], 0
        pending = {}
        counter = 0

        def event_received(event):
            nonlocal scene, session, sequence
            if event['sessionId'] != session:
                session, sequence, scene = event['sessionId'], 0, {}
                print('New game session; discard old decisions and cursors.')
            if event['seq'] <= sequence:
                return
            if event['seq'] > sequence + 1:
                print('History gap: inspect a fresh look/screenshot.')
            sequence = event['seq']
            if event['type'] == 'state':
                scene = event['state']
            elif event['type'] in {'text-page-started', 'text-page-updated'}:
                print('Screen text:', event['page']['text'])
            elif event['type'] == 'capture-gap':
                print('Capture gap: inspect a screenshot.')

        if replay['gap']:
            print('Earlier history is missing; do not infer its contents.')
        for event in replay['events'] + buffered:
            if event['sessionId'] == replay['sessionId']:
                event_received(event)

        async def receive():
            try:
                async for raw in socket:
                    message = json.loads(raw)
                    if message.get('type') == 'event':
                        event_received(message['event'])
                    elif message.get('type') == 'response':
                        future = pending.get(message['id'])
                        if future is not None and not future.done():
                            future.set_result(message)
            finally:
                for future in pending.values():
                    if not future.done():
                        future.set_exception(ConnectionError('Disconnected; command not retried'))

        async def rpc(method, params=None):
            nonlocal counter
            counter += 1
            request_id = str(counter)
            future = asyncio.get_running_loop().create_future()
            pending[request_id] = future
            try:
                await socket.send(json.dumps({'type': 'request', 'id': request_id,
                                              'method': method, 'params': params or {}}))
                reply = await asyncio.wait_for(future, 40)
                if not reply['ok']:
                    raise RuntimeError(reply['error'])
                return reply.get('result')
            finally:
                pending.pop(request_id, None)

        receiver = asyncio.create_task(receive())
        try:
            await rpc('acquire')
            await rpc('pause')
            while True:
                scene = await rpc('look')
                print(json.dumps({key: scene.get(key) for key in
                                  ('frame', 'context', 'controls', 'player', 'dialogue')}))
                decision = await asyncio.to_thread(input, 'Command JSON, or quit: ')
                if decision.strip() == 'quit':
                    break
                command = json.loads(decision)
                await rpc(command['method'], command.get('params', {}))
        finally:
            receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)
            # Closing the connection releases the lease, keys, and pauses the game.

asyncio.run(run())
```

This example stops on a transport failure instead of replaying a potentially completed action. A production agent can reconnect using the last `session`/`sequence`, request replay, inspect any gaps, acquire control again, and obtain a fresh scene before choosing its next action. The packaged `watch` command already implements read-only reconnect/catch-up. Keep screenshots and retained text local if you record a longer run.

## Limits

- The controller is implemented and opening gameplay has been exercised; this is not a claim that an autonomous agent has completed a route.
- Pause/resume and input use the actual runner. The game is not paused automatically just because an agent is thinking unless `pause()` was called.
- ASCII text input matches this runner's character-input support. IME/non-ASCII composition is not implemented.
- Use one active game tab per origin. The launcher takes a browser lock to protect saves from another tab.
- The WebSocket broker is available with the included local Python server. Static hosting retains the browser API but has no local broker by itself.
- If saving returns false, export a backup and inspect the page log. Relaunch refuses to proceed after a failed final save.
