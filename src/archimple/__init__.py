"""archimple — a web-based floor-plan sketcher with constraint solving."""

from __future__ import annotations


def main() -> None:
    import argparse

    import uvicorn

    from .server import app

    parser = argparse.ArgumentParser(
        prog="archimple",
        description="Sketch floor plans in the browser with CAD-style constraints.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="interface to bind (use 0.0.0.0 for LAN)")
    parser.add_argument("--port", type=int, default=8765, help="port to listen on")
    args = parser.parse_args()

    print(f"archimple running at http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


__all__ = ["main"]
