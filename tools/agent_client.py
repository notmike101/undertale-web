"""Local JSON controller client. Watch reconnects; commands are never retried."""

import argparse
import asyncio
import base64
import json
from pathlib import Path
import sys
from urllib.parse import urlencode, urlsplit

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake

DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / ".private" / "controller.json"


def endpoint(config_path):
    config = json.loads(config_path.read_text(encoding="utf-8"))
    url = urlsplit(config["url"])
    if url.scheme != "ws" or url.hostname != "127.0.0.1" or url.path not in {"", "/"}:
        raise ValueError("Controller config must point to the loopback WebSocket server")
    return config["url"].rstrip("/") + "/agent?" + urlencode({"token": config["token"]})


def output(value):
    print(json.dumps(value, ensure_ascii=True, separators=(",", ":")), flush=True)


async def request(socket, method, params):
    """Correlate one reply and retain intervening events for lossless watch startup."""
    await socket.send(json.dumps({"type": "request", "id": "cli", "method": method, "params": params}))
    buffered = []
    async with asyncio.timeout(40):
        async for raw in socket:
            message = json.loads(raw)
            if message.get("type") == "response" and message.get("id") == "cli":
                if not message.get("ok"):
                    raise ValueError(message.get("error", "Controller request failed"))
                return message.get("result"), buffered
            if message.get("type") == "event":
                buffered.append(message["event"])
    raise ConnectionError("Connection closed before the reply; command not retried")


async def watch(args):
    """Reconnect with the last seen session and sequence, reporting any replay gap."""
    session, sequence = args.session, args.after
    delay = 0.5
    while True:
        try:
            async with connect(endpoint(args.config), proxy=None, max_size=16 * 1024 * 1024) as socket:
                await socket.recv()
                replay, buffered = await request(socket, "replay", {"sessionId": session, "afterSeq": sequence})
                if replay["gap"]:
                    output({"type": "gap", "sessionId": replay["sessionId"], "afterSeq": sequence,
                            "oldestSeq": replay["oldestSeq"], "latestSeq": replay["latestSeq"], "sessionChanged": replay["sessionChanged"]})
                if session != replay["sessionId"] or sequence > replay["latestSeq"]:
                    session, sequence = replay["sessionId"], 0
                for event in replay["events"] + [event for event in buffered if event["sessionId"] == replay["sessionId"]]:
                    if event["sessionId"] != session:
                        output({"type": "session", "sessionId": event["sessionId"], "previousSessionId": session})
                        session, sequence = event["sessionId"], 0
                    if event["seq"] > sequence:
                        if event["seq"] > sequence + 1:
                            output({"type": "gap", "sessionId": session, "afterSeq": sequence, "nextSeq": event["seq"]})
                        sequence = event["seq"]
                        output({"type": "event", "event": event})
                delay = 0.5
                async for raw in socket:
                    message = json.loads(raw)
                    if message.get("type") == "event":
                        event = message["event"]
                        if event["sessionId"] != session:
                            output({"type": "session", "sessionId": event["sessionId"], "previousSessionId": session})
                            session, sequence = event["sessionId"], 0
                        if event["seq"] <= sequence:
                            continue
                        if event["seq"] > sequence + 1:
                            output({"type": "gap", "sessionId": session, "afterSeq": sequence, "nextSeq": event["seq"]})
                        sequence = event["seq"]
                    output(message)
                output({"type": "disconnected", "retrySeconds": delay, "sessionId": session, "afterSeq": sequence})
        except (OSError, ConnectionClosed, InvalidHandshake, TimeoutError, ValueError, KeyError):
            output({"type": "disconnected", "retrySeconds": delay, "sessionId": session, "afterSeq": sequence})
        await asyncio.sleep(delay)
        delay = min(delay * 2, 5)


async def command(args):
    params = {}
    method = args.command
    if method == "history":
        method, params = "replay", {"afterSeq": args.after, "sessionId": args.session}
    elif method == "act":
        params = {"keys": args.keys, "milliseconds": args.ms}
    elif method == "type":
        params = {"text": args.text}
    elif method == "dialogueHistory":
        params = {"afterId": args.after_id}
    async with connect(endpoint(args.config), proxy=None, max_size=16 * 1024 * 1024) as socket:
        await socket.recv()
        result, _ = await request(socket, method, params)
        if method == "screenshot":
            if not isinstance(result, str) or not result.startswith("data:image/png;base64,"):
                raise ValueError("Browser did not return a PNG data URL")
            image = base64.b64decode(result.split(",", 1)[1], validate=True)
            if not image.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("Invalid PNG signature")
            args.path.parent.mkdir(parents=True, exist_ok=True)
            with args.path.open("xb") as destination:
                destination.write(image)
            result = {"path": str(args.path.resolve()), "bytes": len(image)}
        output(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG, help="Private local connection config")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("watch", "history"):
        child = sub.add_parser(name, help="Stream events with reconnect" if name == "watch" else "Replay retained events")
        child.add_argument("--after", type=int, default=0)
        child.add_argument("--session")
    for name in ("look", "observe", "status", "controls", "pause", "resume", "save"):
        sub.add_parser(name)
    dialogue = sub.add_parser("dialogueHistory", help="Retained browser dialogue after a dialogue record id")
    dialogue.add_argument("--after-id", type=int, default=0)
    act = sub.add_parser("act", help="Hold keys for a bounded duration; disconnect releases and pauses")
    act.add_argument("keys", nargs="*")
    act.add_argument("--ms", type=int, default=100)
    text = sub.add_parser("type", help="Enter text through real character input")
    text.add_argument("text")
    screenshot = sub.add_parser("screenshot", help="Write a new PNG file; existing files are never overwritten")
    screenshot.add_argument("path", type=Path)
    args = parser.parse_args()
    try:
        asyncio.run(watch(args) if args.command == "watch" else command(args))
    except KeyboardInterrupt:
        pass
    except ValueError as error:
        output({"type": "error", "error": str(error), "retried": False})
        raise SystemExit(1) from None
    except (OSError, ConnectionClosed, InvalidHandshake, TimeoutError, KeyError):
        print("Controller request failed; no command was retried. Check the server, browser, private config, and parameters.", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
