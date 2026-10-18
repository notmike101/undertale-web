"""Loopback-only static host with read-only access to explicitly selected game files."""

import argparse
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_GAME = Path(r"C:\Games\steam\steamapps\common\Undertale")


class Handler(SimpleHTTPRequestHandler):
    """Serve the web directory and a strict allowlist of installed game assets."""

    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript"}

    def __init__(self, *args, game_dir, **kwargs):
        self.game_dir = game_dir
        super().__init__(*args, directory=str(ROOT / "web"), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def assets(self):
        if not self.game_dir.is_dir():
            return {}
        return {p.name: p for p in self.game_dir.iterdir()
                if p.is_file() and not p.is_symlink()
                and (p.name.lower() == "data.win" or p.suffix.lower() == ".ogg")}

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/api/game":
            assets = self.assets()
            if "data.win" not in assets:
                self.send_error(404, "Undertale installation not found; use Import folder")
                return
            data = json.dumps({"files": [{"name": name, "size": p.stat().st_size}
                                         for name, p in sorted(assets.items())]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif path.startswith("/game/"):
            asset = self.assets().get(path.removeprefix("/game/"))
            if asset is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "audio/ogg" if asset.suffix == ".ogg" else "application/octet-stream")
            self.send_header("Content-Length", str(asset.stat().st_size))
            self.end_headers()
            with asset.open("rb") as stream:
                self.copyfile(stream, self.wfile)
        else:
            super().do_GET()

    def list_directory(self, path):
        self.send_error(403, "Directory listing disabled")
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--game-dir", type=Path, default=DEFAULT_GAME)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, game_dir=args.game_dir.resolve()))
    print(f"Undertale Web: http://127.0.0.1:{args.port}", flush=True)
    print("Original installation is read-only. Browser saves stay in this browser profile.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
