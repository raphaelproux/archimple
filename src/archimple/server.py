"""HTTP + WebSocket server for archimple.

Serves the single-page canvas client from ``static/`` and keeps one
shared document in sync across all connected browsers.
"""

from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnected

from .store import Hub

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="archimple")
hub = Hub()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    hub.clients.add(ws)
    try:
        await ws.send_json(hub.state())
        while True:
            op = await ws.receive_json()
            async with hub.lock:
                try:
                    hub.apply_op(op)
                except (KeyError, ValueError, TypeError) as exc:
                    await ws.send_json({"op": "error", "message": str(exc)})
                    continue
                await hub.broadcast()
    except (WebSocketDisconnect, WebSocketDisconnected, RuntimeError):
        pass
    finally:
        hub.clients.discard(ws)


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
