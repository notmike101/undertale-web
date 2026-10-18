"""Focused broker regression check; no game, browser, or real credentials needed."""

import asyncio
from functools import partial
import http.client
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
from threading import Thread

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from controller import Broker
from serve import Handler
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import InvalidStatus


async def request(socket, request_id, method, params=None):
    await socket.send(json.dumps({"type": "request", "id": request_id, "method": method, "params": params or {}}))
    async with asyncio.timeout(3):
        async for raw in socket:
            message = json.loads(raw)
            if message.get("type") == "response" and message.get("id") == request_id:
                return message
    raise AssertionError("Request did not receive a correlated reply")


async def check_broker():
    broker = Broker("test-token", 8766)
    async with serve(broker.handle, "127.0.0.1", 0, process_request=broker.authenticate) as server:
        root = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        for token, origin in [("wrong", None), ("test-token", "https://evil.invalid"), ("test-token", "null")]:
            try:
                async with connect(root + "/agent?token=" + token, origin=origin, proxy=None):
                    raise AssertionError("Invalid authentication or origin was accepted")
            except InvalidStatus:
                pass

        bridge_url = root + "/bridge?token=test-token"
        agent_url = root + "/agent?token=test-token"
        async with connect(bridge_url, origin="http://127.0.0.1:8766", proxy=None) as bridge:
            assert json.loads(await bridge.recv())["latestSeq"] == 0
            await bridge.send(json.dumps({"type": "event", "event": {"sessionId": "one", "seq": 1, "type": "state"}}))

            async def respond():
                async for raw in bridge:
                    message = json.loads(raw)
                    await bridge.send(json.dumps({"type": "response", "id": message["id"], "ok": True, "result": message["method"]}))

            responder = asyncio.create_task(respond())
            async with connect(agent_url, proxy=None) as owner, connect(agent_url, proxy=None) as observer:
                await owner.recv()
                await observer.recv()
                assert (await request(owner, "act", "act", {"keys": ["z"], "milliseconds": 10}))["ok"]
                denied = await request(observer, "denied", "act", {"keys": ["z"]})
                assert not denied["ok"] and "control_busy" in denied["error"]
                assert (await request(observer, "look", "look"))["result"] == "look"
                assert not (await request(owner, "invalid", "act", {"keys": ["F99"]}))["ok"]
                history = (await request(observer, "history", "replay"))["result"]
                assert len(history["events"]) == 1 and not history["gap"]
                await bridge.send(json.dumps({"type": "event", "event": {"sessionId": "one", "seq": 3, "type": "state"}}))
                while True:
                    event = json.loads(await observer.recv())
                    if event.get("type") == "event" and event["event"]["seq"] == 3:
                        break
                replay = (await request(observer, "gap", "replay", {"sessionId": "one", "afterSeq": 1}))["result"]
                assert replay["gap"]
                assert (await request(owner, "release", "release"))["result"]["lease"] == "free"
                responder.cancel()
                await asyncio.gather(responder, return_exceptions=True)
                pending = asyncio.create_task(request(observer, "pending", "look"))
                assert json.loads(await bridge.recv())["method"] == "look"
                await bridge.close()
                failed = await pending
                assert not failed["ok"] and "not retried" in failed["error"]

        async with connect(bridge_url, origin="http://127.0.0.1:8766", proxy=None) as bridge:
            assert json.loads(await bridge.recv())["latestSeq"] == 3
            async with connect(agent_url, proxy=None) as owner:
                await owner.recv()
                assert (await request(owner, "lease", "acquire"))["ok"]
            release = json.loads(await asyncio.wait_for(bridge.recv(), 3))
            assert release["method"] == "releaseAll" and release["params"] == {"pause": True}
            await bridge.send(json.dumps({"type": "response", "id": release["id"], "ok": True, "result": None}))
            async with connect(agent_url, proxy=None) as observer:
                await observer.recv()
                await request(observer, "status", "status")

        await broker.record({"sessionId": "new", "seq": 1, "type": "state"})
        replay = broker.replay({"sessionId": "one", "afterSeq": 3})
        assert replay["sessionChanged"] and replay["gap"] and len(replay["events"]) == 1
        for sequence in range(2, 4100):
            await broker.record({"sessionId": "new", "seq": sequence, "type": "state"})
        assert len(broker.history) == 4096
        assert broker.replay({"sessionId": "new", "afterSeq": 0})["gap"]


def check_http():
    class QuietHandler(Handler):
        def log_message(self, *_args):
            pass

    info = {"available": True, "url": "ws://127.0.0.1:8767", "token": "test-token", "protocol": 1}
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, game_dir=Path("missing-test-game"), controller_info=info))
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        cases = [({}, 200), ({"Origin": "https://evil.invalid"}, 403), ({"Host": "evil.invalid"}, 403), ({"Sec-Fetch-Site": "cross-site"}, 403)]
        for headers, status in cases:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            connection.request("GET", "/api/controller", headers=headers)
            response = connection.getresponse()
            assert response.status == status
            if status == 200:
                assert json.loads(response.read())["protocol"] == 1
            connection.close()
        info.clear()
        info.update(available=False, error="unavailable")
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        connection.request("GET", "/api/controller")
        assert connection.getresponse().status == 503
        connection.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    asyncio.run(check_broker())
    check_http()
    print("PASS: controller auth, origins, relay, lease, disconnect cleanup, replay gaps, retention, HTTP config")
