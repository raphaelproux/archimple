"""Shared document state for every connected client.

One in-memory document is authoritative; every applied operation is
followed by a solve and the full state is broadcast to all clients.
"""

from __future__ import annotations

import asyncio

from .model import DEFAULT_THICKNESS, Document
from .solver import solve_document


class Hub:
    def __init__(self) -> None:
        self.doc = Document()
        self.clients: set = set()
        self.lock = asyncio.Lock()
        self.status = solve_document(self.doc).to_dict()

    def state(self) -> dict:
        data = self.doc.to_dict()
        data["status"] = self.status
        return data

    def apply_op(self, op: dict) -> None:
        kind = op.get("op")
        doc = self.doc
        if kind == "add_wall_path":
            doc.add_wall_path(
                op["vertices"],
                thickness=float(op.get("thickness", DEFAULT_THICKNESS)),
                closed=bool(op.get("closed", False)),
                joins=op.get("joins"),
            )
            self._solve()
        elif kind == "cut_wall":
            doc.cut_wall(op["id"], float(op["station"]))
            self._solve()
        elif kind == "add_wall":
            doc.add_wall(
                (float(op["x1"]), float(op["y1"])),
                (float(op["x2"]), float(op["y2"])),
                thickness=float(op["thickness"]) if "thickness" in op else DEFAULT_THICKNESS,
                joins=op.get("joins") or (),
            )
            self._solve()
        elif kind == "add_rectangle":
            doc.add_rectangle(
                float(op["x1"]),
                float(op["y1"]),
                float(op["x2"]),
                float(op["y2"]),
                symbol=op.get("symbol"),
            )
            self._solve()
        elif kind == "update_rectangle":
            doc.update_rectangle(
                op["id"],
                float(op["x1"]),
                float(op["y1"]),
                float(op["x2"]),
                float(op["y2"]),
            )
            self._solve()
        elif kind == "update_rectangle_corners":
            doc.update_rectangle_corners(op["id"], op["corners"])
            self._solve()
        elif kind == "detach_rectangle":
            doc.detach_rectangle(op["id"])
            self._solve()
        elif kind == "save_symbol":
            doc.save_symbol(op["id"], op["label"])
            self._solve()
        elif kind == "drag":
            points = op["points"]
            for pid, xy in points.items():
                doc.move_point(pid, float(xy[0]), float(xy[1]))
            self._solve(pinned=list(points), max_iter=25)
            self._propagate_symbol_sizes(set(points))
        elif kind == "drag_end":
            self._solve()
            self._propagate_symbol_sizes(set())
        elif kind == "add_opening":
            doc.add_opening(op["wall"], float(op["start"]), float(op["end"]))
            self._solve()
        elif kind == "update_opening":
            doc.update_opening(op["id"], float(op["start"]), float(op["end"]))
            self._solve()
        elif kind == "add_constraint":
            doc.add_constraint(op["constraint"])
            self._solve()
        elif kind == "update_constraint":
            doc.update_constraint(op["id"], float(op["value"]))
            self._solve()
        elif kind == "delete":
            doc.delete(op["id"])
            self._solve()
        elif kind == "solve":
            self._solve()
        else:
            raise ValueError(f"unknown operation {kind!r}")

    def _solve(self, pinned=(), max_iter: int = 80) -> None:
        self.status = solve_document(self.doc, pinned=pinned, max_iter=max_iter).to_dict()

    def _propagate_symbol_sizes(self, moved: set[str]) -> None:
        """Push a size change made by dragging points onto sibling instances."""
        doc = self.doc
        instances = [r for r in doc.rectangles.values() if r.symbol in doc.symbols]
        ordered = sorted(instances, key=lambda r: not (moved & set(r.corners)))
        changed = False
        for rectangle in ordered:
            symbol = doc.symbols[rectangle.symbol]
            p = [doc.points[pid] for pid in rectangle.corners]
            width = ((p[1].x - p[0].x) ** 2 + (p[1].y - p[0].y) ** 2) ** 0.5
            height = ((p[3].x - p[0].x) ** 2 + (p[3].y - p[0].y) ** 2) ** 0.5
            if abs(width - symbol.width) > 1e-6 or abs(height - symbol.height) > 1e-6:
                doc.update_rectangle_corners(rectangle.id, [(q.x, q.y) for q in p])
                changed = True
        if changed:
            self._solve(pinned=moved, max_iter=25)

    async def broadcast(self) -> None:
        state = self.state()
        dead = []
        for client in list(self.clients):
            try:
                await client.send_json(state)
            except Exception:
                dead.append(client)
        for c in dead:
            self.clients.discard(c)
