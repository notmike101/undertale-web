"""Authenticated loopback broker for the browser's real-input controller."""

import asyncio
from collections import deque
from concurrent.futures import Future
from http import HTTPStatus
import json
import math
from pathlib import Path
import secrets
from threading import Thread
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

ROOT = Path(__file__).resolve().parents[1]
READ_METHODS = {"look", "observe", "screenshot", "controls", "dialogueHistory"}
WRITE_METHODS = {"save", "act", "type", "pause", "resume", "keysDown", "keysUp", "releaseAll"}
KEYS = {"ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Shift", "Control", "Backspace", " "}
KEYS.update("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
KEYS.update(".,-=!?/';")


def validate(method, params):
    """Reject oversized and malformed commands before they reach the browser."""
    if not isinstance(method, str):
        raise ValueError("method must be a string")
    if not isinstance(params, dict) or len(json.dumps(params, allow_nan=False)) > 8192:
        raise ValueError("params must be an object smaller than 8 KiB")
    if method in {"act", "keysDown", "keysUp"}:
        keys = params.get("keys", [])
        if not isinstance(keys, list) or len(keys) > 16 or any(not isinstance(key, str) or key not in KEYS for key in keys):
            raise ValueError("keys must contain at most 16 supported key names")
    if method == "act":
        duration = params.get("milliseconds", 100)
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 <= duration <= 5000:
            raise ValueError("milliseconds must be between 0 and 5000")
    if method == "type" and (not isinstance(params.get("text"), str) or len(params["text"]) > 256 or any(not 32 <= ord(character) <= 126 for character in params["text"])):
        raise ValueError("text must contain at most 256 printable ASCII characters")
    if method == "dialogueHistory" and (type(params.get("afterId", 0)) is not int or params.get("afterId", 0) < 0):
        raise ValueError("afterId must be a nonnegative integer")


class Broker:
    """Keep one browser bridge, one controlling client, and bounded replay history."""

    def __init__(self, token, http_port):
        self.token = token
        self.origin = f"http://127.0.0.1:{http_port}"
        self.bridge = None
        self.clients = {}
        self.owner = None
        self.mutating = False
        self.pending = {}
        self.history = deque()
        self.history_bytes = 0
        self.session = None
        self.latest = 0
        self.latest_state = None

    def authenticate(self, connection, request):
        """Authenticate without logging the token-bearing URL."""
        url = urlsplit(request.path)
        tokens = parse_qs(url.query).get("token", [])
        if url.path not in {"/bridge", "/agent"} or len(tokens) != 1 or not secrets.compare_digest(tokens[0].encode(), self.token.encode()):
            return connection.respond(HTTPStatus.UNAUTHORIZED, "Controller authentication required\n")
        origins = request.headers.get_all("Origin")
        if len(origins) > 1 or (origins and origins[0] != self.origin):
            return connection.respond(HTTPStatus.FORBIDDEN, "Origin is not allowed\n")
        if url.path == "/bridge" and (not origins or origins[0] != self.origin):
            return connection.respond(HTTPStatus.FORBIDDEN, "Bridge must use the application origin\n")
        return None

    def status(self, client=None):
        return {"protocol": 1, "connected": self.bridge is not None, "sessionId": self.session,
                "oldestSeq": self.history[0][0]["seq"] if self.history else None,
                "latestSeq": self.latest, "lease": "yours" if self.owner is client and client else "held" if self.owner else "free",
                "state": self.latest_state}

    def emit(self, client, message):
        queue = self.clients.get(client)
        if queue is None:
            return
        try:
            queue.put_nowait(json.dumps(message, separators=(",", ":"), allow_nan=False))
        except asyncio.QueueFull:
            self.clients.pop(client, None)
            asyncio.create_task(client.close(1013, "Slow consumer; reconnect and replay"))

    async def sender(self, client, queue):
        try:
            while True:
                await asyncio.wait_for(client.send(await queue.get()), 5)
        except (ConnectionClosed, TimeoutError):
            await client.close(1013, "Reconnect and replay")

    def replay(self, params):
        after = params.get("afterSeq", 0)
        if type(after) is not int or after < 0:
            raise ValueError("afterSeq must be a nonnegative integer")
        changed = params.get("sessionId") not in {None, self.session}
        cursor = 0 if changed or after > self.latest else after
        events = [event for event, _ in self.history if event["seq"] > cursor]
        gap = changed or after > self.latest
        for event in events:
            gap = gap or event["seq"] > cursor + 1 or event["type"] == "gap"
            cursor = event["seq"]
        return {**self.status(), "events": events, "gap": gap, "sessionChanged": changed}

    async def record(self, event):
        if not isinstance(event, dict) or type(event.get("seq")) is not int or event["seq"] < 1:
            raise ValueError("Invalid event sequence")
        session = event.get("sessionId")
        if not isinstance(session, str) or not 1 <= len(session) <= 128 or not isinstance(event.get("type"), str):
            raise ValueError("Invalid event identity")
        size = len(json.dumps(event))
        if size > 262144:
            raise ValueError("Events must be smaller than 256 KiB")
        if session != self.session:
            if self.session is not None:
                for future in tuple(self.pending.values()):
                    if not future.done():
                        future.set_exception(ConnectionError("Game session changed; command outcome may be unknown; not retried"))
            self.history.clear()
            self.history_bytes = 0
            self.session, self.latest, self.latest_state = session, 0, None
        if event["seq"] <= self.latest:
            return
        self.latest = event["seq"]
        self.history.append((event, size))
        self.history_bytes += size
        while len(self.history) > 4096 or self.history_bytes > 8 * 1024 * 1024:
            _, removed_size = self.history.popleft()
            self.history_bytes -= removed_size
        if event["type"] == "state":
            self.latest_state = event
        for client in tuple(self.clients):
            self.emit(client, {"type": "event", "event": event})

    async def bridge_connection(self, socket):
        if self.bridge is not None:
            await socket.close(1008, "A browser bridge is already connected")
            return
        self.bridge = socket
        await socket.send(json.dumps({"type": "hello", **self.status()}))
        for client in tuple(self.clients):
            self.emit(client, {"type": "bridge", **self.status(client)})
        try:
            async for raw in socket:
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise ValueError("Expected an object")
                if message.get("type") == "event":
                    await self.record(message.get("event"))
                elif message.get("type") == "response":
                    future = self.pending.get(message.get("id"))
                    if future is not None and not future.done():
                        future.set_result(message)
                else:
                    raise ValueError("Unknown bridge message")
        except (ValueError, TypeError, KeyError):
            await socket.close(1008, "Invalid bridge message")
        except ConnectionClosed:
            pass
        finally:
            self.bridge = None
            for future in tuple(self.pending.values()):
                if not future.done():
                    future.set_exception(ConnectionError("Browser disconnected; command outcome may be unknown; not retried"))
            for client in tuple(self.clients):
                self.emit(client, {"type": "bridge", **self.status(client)})

    async def relay(self, method, params):
        bridge = self.bridge
        if bridge is None:
            raise ConnectionError("Browser bridge is offline")
        if len(self.pending) >= 32 and method != "releaseAll":
            raise ValueError("Too many outstanding commands")
        command_id = secrets.token_hex(12)
        future = asyncio.get_running_loop().create_future()
        self.pending[command_id] = future
        try:
            await bridge.send(json.dumps({"type": "request", "id": command_id, "method": method, "params": params}))
            response = await asyncio.wait_for(future, 35)
            if response.get("ok") is not True:
                raise ValueError(str(response.get("error", "Browser command failed")))
            return response.get("result")
        except TimeoutError as error:
            raise TimeoutError("Command timed out; outcome may be unknown; not retried") from error
        finally:
            self.pending.pop(command_id, None)

    async def release_owner(self, client):
        if self.owner is not client:
            return
        self.mutating = True
        try:
            if self.bridge is not None:
                try:
                    await self.relay("releaseAll", {"pause": True})
                except (ConnectionError, ConnectionClosed, ValueError, TimeoutError):
                    pass
        finally:
            self.owner = None
            self.mutating = False

    async def request(self, client, message):
        request_id = message["id"]
        try:
            method, params = message.get("method"), message.get("params", {})
            validate(method, params)
            if method in {"hello", "status"}:
                result = self.status(client)
            elif method == "replay":
                result = self.replay(params)
            elif method == "acquire":
                if self.owner not in {None, client}:
                    raise ValueError("control_busy: another client owns the control lease")
                self.owner = client
                result = self.status(client)
            elif method == "release":
                if self.owner is client and self.mutating:
                    raise ValueError("control_busy: wait for the previous command")
                await self.release_owner(client)
                result = self.status(client)
            elif method in READ_METHODS | WRITE_METHODS:
                mutation = method in WRITE_METHODS
                if mutation:
                    if self.owner not in {None, client}:
                        raise ValueError("control_busy: another client owns the control lease")
                    if self.mutating:
                        raise ValueError("control_busy: wait for the previous command")
                    self.owner = client
                    self.mutating = True
                try:
                    result = await self.relay(method, params)
                finally:
                    if mutation:
                        self.mutating = False
            else:
                raise ValueError("Unknown method")
            self.emit(client, {"type": "response", "id": request_id, "ok": True, "result": result})
        except (ValueError, TypeError, ConnectionError, ConnectionClosed, TimeoutError) as error:
            self.emit(client, {"type": "response", "id": request_id, "ok": False, "error": str(error)})

    async def agent_connection(self, socket):
        if len(self.clients) >= 16:
            await socket.close(1013, "Controller client limit reached")
            return
        queue = asyncio.Queue(maxsize=64)
        self.clients[socket] = queue
        writer = asyncio.create_task(self.sender(socket, queue))
        tasks = {}
        self.emit(socket, {"type": "hello", **self.status(socket)})
        try:
            async for raw in socket:
                if len(raw) > 16384:
                    raise ValueError("Request is too large")
                message = json.loads(raw)
                if not isinstance(message, dict) or message.get("type") != "request":
                    raise ValueError("Expected a request object")
                request_id = message.get("id")
                if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
                    raise ValueError("Request id must be a short string")
                tasks = {key: task for key, task in tasks.items() if not task.done()}
                if request_id in tasks or len(tasks) >= 8:
                    self.emit(socket, {"type": "response", "id": request_id, "ok": False, "error": "Duplicate id or too many pending requests"})
                    continue
                tasks[request_id] = asyncio.create_task(self.request(socket, message))
        except (ValueError, TypeError):
            await socket.close(1008, "Invalid controller request")
        except ConnectionClosed:
            pass
        finally:
            self.clients.pop(socket, None)
            writer.cancel()
            for task in tasks.values():
                task.cancel()
            await asyncio.gather(writer, *tasks.values(), return_exceptions=True)
            await self.release_owner(socket)

    async def handle(self, socket):
        if urlsplit(socket.request.path).path == "/bridge":
            await self.bridge_connection(socket)
        else:
            await self.agent_connection(socket)


def create_controller(http_port, ws_port=8767):
    """Start the broker on a daemon thread and return private connection details."""
    token = secrets.token_urlsafe(32)
    ready = Future()

    async def run():
        broker = Broker(token, http_port)
        try:
            async with serve(broker.handle, "127.0.0.1", ws_port, process_request=broker.authenticate,
                             max_size=16 * 1024 * 1024, max_queue=16, compression=None) as server:
                port = server.sockets[0].getsockname()[1]
                info = {"url": f"ws://127.0.0.1:{port}", "token": token, "protocol": 1}
                destination = ROOT / ".private" / "controller.json"
                destination.parent.mkdir(exist_ok=True)
                destination.write_text(json.dumps(info), encoding="utf-8")
                ready.set_result(info)
                await server.serve_forever()
        except Exception as error:
            if not ready.done():
                ready.set_exception(error)
            else:
                raise

    Thread(target=lambda: asyncio.run(run()), name="undertale-controller", daemon=True).start()
    return ready.result(timeout=10)
