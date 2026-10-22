"""Data model for the archimple floor-plan sketcher.

Walls are rectangles: every wall owns four corner points
(c0..c3 = start+, start-, end-, end+) laid out around its axis; hidden
solver constraints keep those four points rectangular and the thickness
non-negative. Constraints reference either a vertex (a corner point id)
or an edge (wall + side). Coordinates are always stored in metres.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass, field

DEFAULT_THICKNESS = 0.2  # metres


@dataclass
class Point:
    id: str
    name: str
    x: float
    y: float


@dataclass
class Wall:
    id: str
    name: str
    corners: list[str]  # [c0, c1, c2, c3] = start+, start-, end-, end+


@dataclass
class Coincident:
    id: str
    name: str
    a: str  # point ids
    b: str


@dataclass
class Distance:
    id: str
    name: str
    a: dict  # {"kind": "vertex", "pid": ...} | {"kind": "edge", "wall": ..., "side": ±1}
    b: dict
    length: float  # positive magnitude, metres
    offset: float | None  # signed distance, set whenever an edge ref is involved


@dataclass
class AngleBetween:
    id: str
    name: str
    wall_a: str
    wall_b: str
    degrees: float


@dataclass
class Horizontal:
    id: str
    name: str
    wall: str


@dataclass
class Vertical:
    id: str
    name: str
    wall: str


Constraint = Coincident | Distance | AngleBetween | Horizontal | Vertical


def _ref_key(ref: dict) -> str:
    return json.dumps(ref, sort_keys=True)


def ref_walls(ref: dict) -> set[str]:
    return {ref["wall"]} if ref["kind"] == "edge" else set()


def ref_points(ref: dict) -> set[str]:
    return {ref["pid"]} if ref["kind"] == "vertex" else set()


def _fold_angle(deg: float) -> float:
    """Fold a user-entered angle to a positive value in [0, 180]."""
    v = abs(float(deg))
    v = math.fmod(v, 360.0)
    if v > 180.0:
        v = 360.0 - v
    return v


@dataclass
class Document:
    points: dict[str, Point] = field(default_factory=dict)
    walls: dict[str, Wall] = field(default_factory=dict)
    constraints: dict[str, Constraint] = field(default_factory=dict)
    _counters: dict[str, int] = field(default_factory=dict, repr=False)

    def _next(self, prefix: str) -> tuple[str, str]:
        n = self._counters.get(prefix, 0) + 1
        self._counters[prefix] = n
        return f"{prefix}_{n}", f"{prefix.upper()}{n}"

    # -- construction ------------------------------------------------------

    def add_point(self, x: float, y: float) -> Point:
        pid, name = self._next("p")
        pt = Point(pid, name, x, y)
        self.points[pid] = pt
        return pt

    def add_wall(
        self,
        start: tuple[float, float],
        end: tuple[float, float],
        thickness: float = DEFAULT_THICKNESS,
        joins: Sequence[dict] = (),
    ) -> Wall:
        """Create a rectangular wall around the axis start→end.

        Each entry in ``joins`` is {"corner": 0..3, "pid": existing_point_id}
        and produces a coincident constraint between that new corner and the
        existing vertex, instead of the two walls sharing a point.
        """
        (ax, ay), (bx, by) = start, end
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        if length < 1e-6:
            raise ValueError("a wall needs a non-zero length")
        if thickness <= 0:
            raise ValueError("thickness must be positive")
        ux, uy = dx / length, dy / length
        nx, ny = -uy, ux
        h = thickness / 2.0
        corners = [
            self.add_point(ax + h * nx, ay + h * ny).id,  # c0 start+
            self.add_point(ax - h * nx, ay - h * ny).id,  # c1 start-
            self.add_point(bx - h * nx, by - h * ny).id,  # c2 end-
            self.add_point(bx + h * nx, by + h * ny).id,  # c3 end+
        ]
        wid, name = self._next("w")
        wall = Wall(wid, name, corners)
        self.walls[wid] = wall
        # every wall starts with a dimension between its two long edges,
        # so its thickness is immediately visible and editable
        self.add_constraint({
            "type": "distance",
            "a": {"kind": "edge", "wall": wid, "side": 1},
            "b": {"kind": "edge", "wall": wid, "side": -1},
            "length": thickness,
        })
        for join in joins:
            idx = int(join["corner"])
            pid = join["pid"]
            if not 0 <= idx <= 3:
                raise ValueError("invalid join corner index")
            if pid not in self.points:
                raise ValueError("join references an unknown point")
            self.add_constraint({"type": "coincident", "a": corners[idx], "b": pid})
        return wall

    def move_point(self, pid: str, x: float, y: float) -> None:
        pt = self.points[pid]  # KeyError -> client error message
        pt.x = float(x)
        pt.y = float(y)

    # -- constraint references --------------------------------------------

    def _validate_ref(self, ref: object) -> None:
        if not isinstance(ref, dict) or ref.get("kind") not in ("vertex", "edge"):
            raise ValueError("invalid constraint reference")
        if ref["kind"] == "vertex":
            if ref.get("pid") not in self.points:
                raise ValueError("reference to an unknown point")
        else:
            if ref.get("wall") not in self.walls:
                raise ValueError("reference to an unknown wall")
            if ref.get("side") not in (1, -1):
                raise ValueError("invalid edge side")

    def _edge_frame(self, ref: dict) -> tuple[Point, Point]:
        """First and second corner of an edge ref, as (P, Q) points."""
        w = self.walls[ref["wall"]]
        i = 0 if ref["side"] > 0 else 1
        return self.points[w.corners[i]], self.points[w.corners[3 if ref["side"] > 0 else 2]]

    def _signed_edge_distance(self, ea: dict, eb: dict) -> float:
        """Signed distance from edge ea's line to the target of eb."""
        p, q = self._edge_frame(ea)
        dx, dy = q.x - p.x, q.y - p.y
        m = math.hypot(dx, dy)
        if m < 1e-9:
            return 0.0
        nx, ny = -dy / m, dx / m
        if eb["kind"] == "vertex":
            target = self.points[eb["pid"]]
        else:
            target, _ = self._edge_frame(eb)
        return (target.x - p.x) * nx + (target.y - p.y) * ny

    def _check_edges_parallel(self, ea: dict, eb: dict) -> None:
        p1, q1 = self._edge_frame(ea)
        p2, q2 = self._edge_frame(eb)
        d1x, d1y = q1.x - p1.x, q1.y - p1.y
        d2x, d2y = q2.x - p2.x, q2.y - p2.y
        m1, m2 = math.hypot(d1x, d1y), math.hypot(d2x, d2y)
        if m1 < 1e-9 or m2 < 1e-9:
            return
        if abs(d1x * d2y - d1y * d2x) > 0.09 * m1 * m2:  # ~5°
            raise ValueError("edges must be nearly parallel")

    def _signed_axis_angle(self, wa: str, wb: str) -> float:
        """Current signed angle from wall wa's axis to wall wb's axis."""
        ax, ay = self._axis_dir(wa)
        bx, by = self._axis_dir(wb)
        return math.atan2(ax * by - ay * bx, ax * bx + ay * by)

    def _axis_dir(self, wid: str) -> tuple[float, float]:
        w = self.walls[wid]
        p0 = self.points[w.corners[0]]
        p3 = self.points[w.corners[3]]
        return p3.x - p0.x, p3.y - p0.y

    # -- constraints -------------------------------------------------------

    def add_constraint(self, data: dict) -> tuple[Constraint, bool]:
        """Add a constraint from a client payload.

        Returns ``(constraint, created)``. When the same pair already has a
        constraint of the same kind, the existing one is updated instead.
        """
        ctype = data["type"]
        if ctype == "distance":
            ra, rb = data["a"], data["b"]
            self._validate_ref(ra)
            self._validate_ref(rb)
            value = float(data["length"])
            if value <= 0:
                raise ValueError("distance must be positive")
            if ra["kind"] == "vertex" and rb["kind"] == "vertex":
                pa, pb = sorted((ra["pid"], rb["pid"]))
                if pa == pb:
                    raise ValueError("cannot dimension a point against itself")
                for c in self.constraints.values():
                    if (
                        isinstance(c, Distance)
                        and c.offset is None
                        and (c.a["pid"], c.b["pid"]) == (pa, pb)
                    ):
                        c.length = value
                        return c, False
                cid, name = self._next("d")
                c = Distance(
                    cid, name,
                    {"kind": "vertex", "pid": pa},
                    {"kind": "vertex", "pid": pb},
                    value, None,
                )
            else:
                if ra["kind"] == "edge" and rb["kind"] == "edge":
                    if ra["wall"] == rb["wall"] and ra["side"] == rb["side"]:
                        raise ValueError("pick two different edges")
                    self._check_edges_parallel(ra, rb)
                # normalize so the edge (if any) comes first: the signed
                # distance is measured from ref a's line to ref b's target
                pair = (ra, rb) if ra["kind"] == "edge" else (rb, ra)
                keys = sorted((_ref_key(pair[0]), _ref_key(pair[1])))
                for c in self.constraints.values():
                    if isinstance(c, Distance) and c.offset is not None:
                        if sorted((_ref_key(c.a), _ref_key(c.b))) == keys:
                            sign = -1.0 if c.offset < 0 else 1.0
                            c.length = value
                            c.offset = sign * value
                            return c, False
                d = self._signed_edge_distance(pair[0], pair[1])
                offset = -value if d < 0 else value
                cid, name = self._next("d")
                c = Distance(cid, name, pair[0], pair[1], value, offset)
        elif ctype == "angle":
            wa, wb = sorted((data["wall_a"], data["wall_b"]))
            if wa == wb:
                raise ValueError("pick two different walls")
            if wa not in self.walls or wb not in self.walls:
                raise ValueError("reference to an unknown wall")
            # user-facing angles are positive in [0, 180]
            value = _fold_angle(data["degrees"])
            for c in self.constraints.values():
                if isinstance(c, AngleBetween) and {c.wall_a, c.wall_b} == {wa, wb}:
                    # editing an existing constraint keeps its orientation
                    sign = -1.0 if c.degrees < 0 else 1.0
                    c.degrees = sign * value
                    return c, False
            # a new constraint targets the nearest orientation matching |value|,
            # so e.g. walls sitting at -93° given "90" rotate 3°, not 183°
            theta = self._signed_axis_angle(wa, wb)
            value = -value if theta < 0 else value
            cid, name = self._next("a")
            c = AngleBetween(cid, name, wa, wb, value)
        elif ctype == "coincident":
            a, b = data["a"], data["b"]
            if a not in self.points or b not in self.points:
                raise ValueError("reference to an unknown point")
            if a == b:
                raise ValueError("these points are already coincident")
            pa, pb = sorted((a, b))
            for c in self.constraints.values():
                if isinstance(c, Coincident) and (c.a, c.b) == (pa, pb):
                    return c, False
            cid, name = self._next("c")
            c = Coincident(cid, name, pa, pb)
        elif ctype in ("horizontal", "vertical"):
            wid = data["wall"]
            if wid not in self.walls:
                raise ValueError("reference to an unknown wall")
            cls = Horizontal if ctype == "horizontal" else Vertical
            for c in self.constraints.values():
                if isinstance(c, cls) and c.wall == wid:
                    return c, False
            cid, name = self._next("h" if ctype == "horizontal" else "v")
            c = cls(cid, name, wid)
        else:
            raise ValueError(f"unknown constraint type {ctype!r}")
        self.constraints[c.id] = c
        return c, True

    def update_constraint(self, cid: str, value: float) -> None:
        c = self.constraints[cid]  # KeyError -> client error message
        if isinstance(c, Distance):
            if value <= 0:
                raise ValueError("distance must be positive")
            c.length = value
            if c.offset is not None:
                sign = -1.0 if c.offset < 0 else 1.0
                c.offset = sign * value
        elif isinstance(c, AngleBetween):
            sign = -1.0 if c.degrees < 0 else 1.0
            c.degrees = sign * _fold_angle(value)
        else:
            raise ValueError("this constraint has no editable value")

    # -- deletion ----------------------------------------------------------

    def _constraint_walls(self, c: Constraint) -> set[str]:
        if isinstance(c, AngleBetween):
            return {c.wall_a, c.wall_b}
        if isinstance(c, (Horizontal, Vertical)):
            return {c.wall}
        if isinstance(c, Distance):
            return ref_walls(c.a) | ref_walls(c.b)
        return set()

    def _constraint_points(self, c: Constraint) -> set[str]:
        if isinstance(c, Coincident):
            return {c.a, c.b}
        if isinstance(c, Distance):
            return ref_points(c.a) | ref_points(c.b)
        return set()

    def delete(self, item_id: str) -> bool:
        if item_id in self.walls:
            del self.walls[item_id]
            for cid in [cid for cid, c in self.constraints.items() if item_id in self._constraint_walls(c)]:
                del self.constraints[cid]
            # corners belong to their wall: a corner whose wall is gone is
            # removed, together with any constraint that referenced it
            alive = {pid for w in self.walls.values() for pid in w.corners}
            for cid in [
                cid
                for cid, c in self.constraints.items()
                if self._constraint_points(c) - alive
            ]:
                del self.constraints[cid]
            self.points = {pid: p for pid, p in self.points.items() if pid in alive}
            return True
        if item_id in self.constraints:
            del self.constraints[item_id]
            return True
        return False

    # -- serialisation -----------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "points": {
                pid: {"id": pid, "name": p.name, "x": round(p.x, 6), "y": round(p.y, 6)}
                for pid, p in self.points.items()
            },
            "walls": [
                {"id": w.id, "name": w.name, "corners": list(w.corners)}
                for w in self.walls.values()
            ],
            "constraints": [_constraint_dict(c) for c in self.constraints.values()],
        }


def _constraint_dict(c: Constraint) -> dict:
    if isinstance(c, Coincident):
        return {"id": c.id, "name": c.name, "type": "coincident", "a": c.a, "b": c.b}
    if isinstance(c, Distance):
        return {
            "id": c.id,
            "name": c.name,
            "type": "distance",
            "a": c.a,
            "b": c.b,
            "length": round(c.length, 6),
            "offset": None if c.offset is None else round(c.offset, 6),
        }
    if isinstance(c, AngleBetween):
        return {
            "id": c.id,
            "name": c.name,
            "type": "angle",
            "wall_a": c.wall_a,
            "wall_b": c.wall_b,
            "degrees": round(c.degrees, 4),
        }
    if isinstance(c, Horizontal):
        return {"id": c.id, "name": c.name, "type": "horizontal", "wall": c.wall}
    return {"id": c.id, "name": c.name, "type": "vertical", "wall": c.wall}
