"""HTTP + WebSocket server for archimple.

Serves the single-page canvas client from ``static/`` and keeps each
in-memory session document in sync across its connected browsers.
"""

from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnected

from .store import SessionRegistry

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="archimple")
sessions = SessionRegistry()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    code = ws.query_params.get("session")
    await ws.accept()
    try:
        try:
            session_code, hub = sessions.get_or_create(code)
        except ValueError as exc:
            await ws.send_json({"op": "error", "message": str(exc), "session": True})
            await ws.close(code=1008)
            return
        hub.clients.add(ws)
        await ws.send_json({"op": "session", "code": session_code})
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
        if "hub" in locals():
            hub.clients.discard(ws)


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
