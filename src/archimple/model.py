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
import re
from collections.abc import Sequence
from copy import deepcopy
from dataclasses import dataclass, field

DEFAULT_THICKNESS = 0.2  # metres
WALL_CUT_GAP = 0.1  # metres


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
class Opening:
    id: str
    name: str
    wall: str
    start: float
    length: float


@dataclass
class Rectangle:
    id: str
    name: str
    corners: list[str]
    symbol: str | None = None


@dataclass
class Symbol:
    id: str
    label: str
    width: float
    height: float
    constraints: dict[str, Constraint] = field(default_factory=dict)


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
    a: dict
    b: dict
    degrees: float


@dataclass
class Horizontal:
    id: str
    name: str
    target: dict


@dataclass
class Vertical:
    id: str
    name: str
    target: dict


Constraint = Coincident | Distance | AngleBetween | Horizontal | Vertical


def _ref_key(ref: dict) -> str:
    return json.dumps(ref, sort_keys=True)


def ref_walls(ref: dict, openings: dict[str, Opening] | None = None) -> set[str]:
    if ref["kind"] in ("edge", "wall-end"):
        return {ref["wall"]}
    if (
        ref["kind"] in ("opening", "opening-length")
        and openings
        and ref["opening"] in openings
    ):
        return {openings[ref["opening"]].wall}
    return set()


def ref_points(ref: dict) -> set[str]:
    return {ref["pid"]} if ref["kind"] == "vertex" else set()


def ref_openings(ref: dict) -> set[str]:
    return (
        {ref["opening"]}
        if ref["kind"] in ("opening", "opening-length")
        else set()
    )


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
    openings: dict[str, Opening] = field(default_factory=dict)
    rectangles: dict[str, Rectangle] = field(default_factory=dict)
    symbols: dict[str, Symbol] = field(default_factory=dict)
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

    def add_rectangle(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        symbol: str | None = None,
    ) -> Rectangle:
        x1, y1, x2, y2 = map(float, (x1, y1, x2, y2))
        left, right = sorted((x1, x2))
        bottom, top = sorted((y1, y2))
        if right - left < 1e-3 or top - bottom < 1e-3:
            raise ValueError("a rectangle needs positive width and height")
        if symbol is not None and symbol not in self.symbols:
            raise ValueError("rectangle references an unknown symbol")
        corners = [
            self.add_point(left, bottom).id,
            self.add_point(right, bottom).id,
            self.add_point(right, top).id,
            self.add_point(left, top).id,
        ]
        rid, name = self._next("r")
        rectangle = Rectangle(rid, name, corners, symbol)
        self.rectangles[rid] = rectangle
        if symbol is None:
            for corner in range(3):
                center = corners[corner]
                self.add_constraint({
                    "type": "angle",
                    "a": {"kind": "segment", "start": center, "end": corners[(corner - 1) % 4]},
                    "b": {"kind": "segment", "start": center, "end": corners[(corner + 1) % 4]},
                    "degrees": 90,
                })
        return rectangle

    def save_symbol(self, rectangle_id: str, label: str) -> Symbol:
        rectangle = self.rectangles[rectangle_id]
        label = str(label).strip()
        if not label:
            raise ValueError("symbol label cannot be empty")
        c = [self.points[pid] for pid in rectangle.corners]
        width = abs(c[1].x - c[0].x)
        height = abs(c[3].y - c[0].y)
        if rectangle.symbol and rectangle.symbol in self.symbols:
            symbol = self.symbols[rectangle.symbol]
            symbol.label = label
            return symbol
        sid, _ = self._next("s")
        symbol = Symbol(sid, label, width, height)
        for cid, constraint in list(self.constraints.items()):
            point_ids = self._constraint_points(constraint)
            if point_ids and point_ids <= set(rectangle.corners):
                symbol.constraints[cid] = self._localize_symbol_constraint(constraint, rectangle)
                del self.constraints[cid]
        self.symbols[sid] = symbol
        rectangle.symbol = sid
        return symbol

    def _localize_symbol_constraint(self, constraint: Constraint, rectangle: Rectangle) -> Constraint:
        corner_by_pid = {pid: index for index, pid in enumerate(rectangle.corners)}
        localized = deepcopy(constraint)
        if isinstance(localized, Distance):
            for ref in (localized.a, localized.b):
                if ref.get("kind") == "vertex":
                    ref["corner"] = corner_by_pid[ref.pop("pid")]
                elif ref.get("kind") == "opening-length":
                    raise ValueError("symbol constraints cannot reference openings")
                else:
                    raise ValueError("symbol constraints must reference rectangle corners")
        elif isinstance(localized, Coincident):
            if localized.a not in corner_by_pid or localized.b not in corner_by_pid:
                raise ValueError("symbol constraints must reference rectangle corners")
            localized.a = corner_by_pid[localized.a]
            localized.b = corner_by_pid[localized.b]
        elif isinstance(localized, AngleBetween):
            for ref in (localized.a, localized.b):
                if ref.get("kind") == "segment":
                    ref["start_corner"] = corner_by_pid[ref.pop("start")]
                    ref["end_corner"] = corner_by_pid[ref.pop("end")]
                else:
                    raise ValueError("symbol constraints must reference rectangle sides")
        elif isinstance(localized, (Horizontal, Vertical)):
            ref = localized.target
            if ref.get("kind") == "segment":
                ref["start_corner"] = corner_by_pid[ref.pop("start")]
                ref["end_corner"] = corner_by_pid[ref.pop("end")]
            else:
                raise ValueError("symbol constraints must reference rectangle sides")
        return localized

    def _expand_symbol_constraint(self, constraint: Constraint, rectangle: Rectangle) -> Constraint:
        expanded = deepcopy(constraint)
        if isinstance(expanded, Coincident):
            expanded.a = rectangle.corners[expanded.a]
            expanded.b = rectangle.corners[expanded.b]
        elif isinstance(expanded, Distance):
            for ref in (expanded.a, expanded.b):
                if "corner" in ref:
                    ref["pid"] = rectangle.corners[ref.pop("corner")]
        elif isinstance(expanded, AngleBetween):
            for ref in (expanded.a, expanded.b):
                if "start_corner" in ref:
                    ref["start"] = rectangle.corners[ref.pop("start_corner")]
                    ref["end"] = rectangle.corners[ref.pop("end_corner")]
        elif isinstance(expanded, (Horizontal, Vertical)):
            ref = expanded.target
            if "start_corner" in ref:
                ref["start"] = rectangle.corners[ref.pop("start_corner")]
                ref["end"] = rectangle.corners[ref.pop("end_corner")]
        return expanded

    def expanded_constraints(self) -> list[Constraint]:
        result = list(self.constraints.values())
        for rectangle in self.rectangles.values():
            symbol = self.symbols.get(rectangle.symbol) if rectangle.symbol else None
            if symbol:
                result.extend(
                    self._expand_symbol_constraint(constraint, rectangle)
                    for constraint in symbol.constraints.values()
                )
        return result

    def detach_rectangle(self, rectangle_id: str) -> None:
        rectangle = self.rectangles[rectangle_id]
        if not rectangle.symbol:
            return
        symbol = self.symbols[rectangle.symbol]
        for constraint in symbol.constraints.values():
            expanded = self._expand_symbol_constraint(constraint, rectangle)
            prefix = (
                "a" if isinstance(expanded, AngleBetween)
                else "h" if isinstance(expanded, Horizontal)
                else "v" if isinstance(expanded, Vertical)
                else "d" if isinstance(expanded, Distance)
                else "c"
            )
            cid, name = self._next(prefix)
            expanded.id = cid
            expanded.name = name
            self.constraints[cid] = expanded
        rectangle.symbol = None

    def remove_symbol(self, symbol_id: str) -> bool:
        symbol = self.symbols.get(symbol_id)
        if symbol is None:
            return False
        for rectangle in list(self.rectangles.values()):
            if rectangle.symbol == symbol_id:
                self.detach_rectangle(rectangle.id)
        del self.symbols[symbol_id]
        return True

    def update_rectangle(
        self, rectangle_id: str, x1: float, y1: float, x2: float, y2: float
    ) -> None:
        x1, y1, x2, y2 = map(float, (x1, y1, x2, y2))
        left, right = sorted((x1, x2))
        bottom, top = sorted((y1, y2))
        self.update_rectangle_corners(rectangle_id, [
            (left, bottom), (right, bottom), (right, top), (left, top),
        ])

    def update_rectangle_corners(self, rectangle_id: str, coords: Sequence[Sequence[float]]) -> None:
        rectangle = self.rectangles[rectangle_id]
        if len(coords) != 4:
            raise ValueError("a rectangle needs four corners")
        positions = [(float(point[0]), float(point[1])) for point in coords]
        p0, p1, p2, p3 = positions
        width = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        height = math.hypot(p3[0] - p0[0], p3[1] - p0[1])
        if width < 1e-3 or height < 1e-3:
            raise ValueError("a rectangle needs positive width and height")
        symbol = self.symbols.get(rectangle.symbol) if rectangle.symbol else None
        for pid, (x, y) in zip(rectangle.corners, positions):
            self.move_point(pid, x, y)
        if not symbol or (math.isclose(width, symbol.width, abs_tol=1e-6)
                          and math.isclose(height, symbol.height, abs_tol=1e-6)):
            return
        symbol.width, symbol.height = width, height
        for instance in self.rectangles.values():
            if instance.id == rectangle_id or instance.symbol != symbol.id:
                continue
            old = [self.points[pid] for pid in instance.corners]
            old_width = math.hypot(old[1].x - old[0].x, old[1].y - old[0].y)
            old_height = math.hypot(old[3].x - old[0].x, old[3].y - old[0].y)
            if old_width < 1e-9 or old_height < 1e-9:
                continue
            center = ((old[0].x + old[2].x) / 2, (old[0].y + old[2].y) / 2)
            iu = ((old[1].x - old[0].x) / old_width, (old[1].y - old[0].y) / old_width)
            iv = ((old[3].x - old[0].x) / old_height, (old[3].y - old[0].y) / old_height)
            dot = iu[0] * iv[0] + iu[1] * iv[1]
            if abs(dot) > 1e-5:
                continue
            origin = (center[0] - (width * iu[0] + height * iv[0]) / 2,
                      center[1] - (width * iu[1] + height * iv[1]) / 2)
            sibling = [
                origin,
                (origin[0] + width * iu[0], origin[1] + width * iu[1]),
                (origin[0] + width * iu[0] + height * iv[0], origin[1] + width * iu[1] + height * iv[1]),
                (origin[0] + height * iv[0], origin[1] + height * iv[1]),
            ]
            for pid, (x, y) in zip(instance.corners, sibling):
                self.move_point(pid, x, y)

    def add_opening(self, wall_id: str, start: float, end: float) -> Opening:
        if wall_id not in self.walls:
            raise ValueError("opening references an unknown wall")
        start, end = float(start), float(end)
        wall = self.walls[wall_id]
        ax, ay, bx, by = self._axis_endpoints(wall)
        length = math.hypot(bx - ax, by - ay)
        if not (0 <= start < end <= length):
            raise ValueError(
                "opening endpoints must lie within the wall and have positive length"
            )
        oid, name = self._next("o")
        opening = Opening(oid, name, wall_id, start, end - start)
        self.openings[oid] = opening
        return opening

    def update_opening(self, opening_id: str, start: float, end: float) -> None:
        opening = self.openings[opening_id]
        start, end = float(start), float(end)
        wall = self.walls[opening.wall]
        ax, ay, bx, by = self._axis_endpoints(wall)
        length = math.hypot(bx - ax, by - ay)
        if not (0 <= start < end <= length):
            raise ValueError(
                "opening endpoints must lie within the wall and have positive length"
            )
        opening.start, opening.length = start, end - start

    def add_wall_path(
        self,
        vertices: Sequence[Sequence[float]],
        thickness: float = DEFAULT_THICKNESS,
        closed: bool = False,
        joins: Sequence[str | None] | None = None,
    ) -> list[Wall]:
        points = [(float(point[0]), float(point[1])) for point in vertices]
        if closed and len(points) > 1 and math.dist(points[0], points[-1]) < 1e-6:
            points.pop()
        if len(points) < (3 if closed else 2):
            raise ValueError("wall path has too few distinct vertices")
        if any(
            math.dist(points[i], points[i + 1]) < 1e-6
            for i in range(len(points) - 1)
        ):
            raise ValueError("wall path contains a zero-length segment")
        if closed and math.dist(points[-1], points[0]) < 1e-6:
            raise ValueError("wall path contains a zero-length closing segment")
        if thickness <= 0:
            raise ValueError("thickness must be positive")
        walls = []
        segments = list(zip(points, points[1:]))
        if closed:
            segments.append((points[-1], points[0]))
        if any(
            abs(
                (points[(i + 1) % len(points)][0] - points[i][0])
                * (points[(i + 2) % len(points)][1] - points[(i + 1) % len(points)][1])
                - (points[(i + 1) % len(points)][1] - points[i][1])
                * (points[(i + 2) % len(points)][0] - points[(i + 1) % len(points)][0])
            ) < 1e-9
            for i in range(len(points) if closed else len(points) - 2)
        ):
            raise ValueError("wall path has a zero interior angle")
        signed_area = sum(
            points[i][0] * points[(i + 1) % len(points)][1]
            - points[(i + 1) % len(points)][0] * points[i][1]
            for i in range(len(points))
        ) if closed else 0.0
        ccw = signed_area >= 0 if closed else True
        if joins is None:
            joins = [None] * len(points)
        if len(joins) != len(points):
            raise ValueError("wall path joins must match its vertices")
        if not closed:
            ccw = True
        directions = []
        normals = []
        for start, end in segments:
            dx, dy = end[0] - start[0], end[1] - start[1]
            length = math.hypot(dx, dy)
            direction = (dx / length, dy / length)
            directions.append(direction)
            normals.append((-direction[1], direction[0]))
        side = 1 if ccw else -1
        axes = []
        for index, (start, end) in enumerate(segments):
            prev_index = (index - 1) % len(segments)
            if index == 0 and not closed:
                offset = normals[index]
            else:
                prev_n = normals[prev_index]
                next_n = normals[index]
                nsum = (prev_n[0] + next_n[0], prev_n[1] + next_n[1])
                dot = nsum[0] * next_n[0] + nsum[1] * next_n[1]
                offset = (nsum[0] / (dot or 1.0), nsum[1] / (dot or 1.0))
            start_axis = (
                start[0] + side * offset[0] * thickness / 2,
                start[1] + side * offset[1] * thickness / 2,
            )
            next_index = (index + 1) % len(segments)
            if next_index == 0 and not closed:
                end_offset = normals[index]
            else:
                next_n = normals[next_index]
                nsum = (
                    normals[index][0] + next_n[0],
                    normals[index][1] + next_n[1],
                )
                dot = nsum[0] * normals[index][0] + nsum[1] * normals[index][1]
                end_offset = (
                    nsum[0] / (dot or 1.0),
                    nsum[1] / (dot or 1.0),
                )
            end_axis = (
                end[0] + side * end_offset[0] * thickness / 2,
                end[1] + side * end_offset[1] * thickness / 2,
            )
            axes.append((start_axis, end_axis))
        for index, ((start_axis, end_axis), (start, end)) in enumerate(
            zip(axes, segments)
        ):
            wall = self.add_wall(start_axis, end_axis, thickness)
            if joins[index] in self.points:
                start_corner = 0 if ccw else 1
                self.add_constraint({
                    "type": "coincident",
                    "a": wall.corners[start_corner],
                    "b": joins[index],
                })
            end_index = (index + 1) % len(points)
            if joins[end_index] in self.points:
                end_corner = 3 if ccw else 2
                self.add_constraint({
                    "type": "coincident",
                    "a": wall.corners[end_corner],
                    "b": joins[end_index],
                })
            walls.append(wall)
        join_count = len(walls) if closed else len(walls) - 1
        for index in range(join_count):
            previous = walls[index]
            following = walls[(index + 1) % len(walls)]
            prev_corner, next_corner = (2, 0) if ccw else (3, 1)
            self.add_constraint({
                "type": "coincident",
                "a": previous.corners[prev_corner],
                "b": following.corners[next_corner],
            })
        if closed and len(walls) > 1:
            for index in range(len(walls) - 1):
                first = (
                    points[(index + 1) % len(points)][0] - points[index][0],
                    points[(index + 1) % len(points)][1] - points[index][1],
                )
                second = (
                    points[(index + 2) % len(points)][0] - points[(index + 1) % len(points)][0],
                    points[(index + 2) % len(points)][1] - points[(index + 1) % len(points)][1],
                )
                angle = math.degrees(math.atan2(
                    first[0] * second[1] - first[1] * second[0],
                    first[0] * second[0] + first[1] * second[1],
                ))
                self.add_constraint({
                    "type": "angle",
                    "a": {"kind": "wall", "wall": walls[index].id},
                    "b": {"kind": "wall", "wall": walls[(index + 1) % len(walls)].id},
                    "degrees": angle,
                })
        return walls

    def add_rectangular_room(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        thickness: float = DEFAULT_THICKNESS,
    ) -> list[Wall]:
        x1, y1, x2, y2 = map(float, (x1, y1, x2, y2))
        left, right = sorted((x1, x2))
        bottom, top = sorted((y1, y2))
        if right - left < 1e-3 or top - bottom < 1e-3:
            raise ValueError("a room needs positive width and height")
        return self.add_wall_path(
            [(left, bottom), (right, bottom), (right, top), (left, top)],
            thickness=thickness,
            closed=True,
        )

    def cut_wall(self, wall_id: str, station: float) -> tuple[Wall, Wall]:
        wall = self.walls[wall_id]
        start_x, start_y, end_x, end_y = self._axis_endpoints(wall)
        length = math.hypot(end_x - start_x, end_y - start_y)
        station = float(station)
        if not 1e-3 < station < length - 1e-3:
            raise ValueError("cut position must be inside the wall")
        ux, uy = (end_x - start_x) / length, (end_y - start_y) / length
        gap = min(WALL_CUT_GAP, station - 1e-3, length - station - 1e-3)
        first_end_station = station - gap / 2
        second_start_station = station + gap / 2
        first_end = (
            start_x + ux * first_end_station,
            start_y + uy * first_end_station,
        )
        second_start = (
            start_x + ux * second_start_station,
            start_y + uy * second_start_station,
        )
        thickness = math.hypot(
            self.points[wall.corners[1]].x - self.points[wall.corners[0]].x,
            self.points[wall.corners[1]].y - self.points[wall.corners[0]].y,
        )
        old_id = wall.id
        old_name = wall.name
        old_corners = list(wall.corners)
        old_openings = [
            opening for opening in self.openings.values() if opening.wall == old_id
        ]
        old_constraints = [
            c for c in self.constraints.values() if old_id in self._constraint_walls(c)
        ]
        cut_length_constraints = {
            c.id for c in old_constraints
            if isinstance(c, Distance)
            and c.a.get("kind") == c.b.get("kind") == "wall-end"
            and c.a.get("wall") == c.b.get("wall") == old_id
            and c.a.get("end") != c.b.get("end")
        }
        for constraint in old_constraints:
            self.constraints.pop(constraint.id, None)
        old_constraints = [
            c for c in old_constraints if c.id not in cut_length_constraints
        ]
        del self.walls[old_id]
        first = self.add_wall((start_x, start_y), first_end, thickness)
        second = self.add_wall(second_start, (end_x, end_y), thickness)
        for segment in (first, second):
            segment_thickness = next(
                constraint for constraint in self.constraints.values()
                if isinstance(constraint, Distance)
                and constraint.a.get("kind") == "edge"
                and constraint.a.get("wall") == segment.id
                and constraint.b.get("kind") == "edge"
                and constraint.b.get("wall") == segment.id
            )
            self.constraints.pop(segment_thickness.id)
        self.walls.pop(first.id)
        self.walls.pop(second.id)
        first.id, first.name = old_id, old_name
        self.walls[first.id] = first
        second.id, second.name = self._next("w")
        self.walls[second.id] = second
        for segment in (first, second):
            self.add_constraint({
                "type": "distance",
                "a": {"kind": "edge", "wall": segment.id, "side": 1},
                "b": {"kind": "edge", "wall": segment.id, "side": -1},
                "length": thickness,
            })
        second_generated_id = second.id
        start_corner_map = {
            old_corners[0]: first.corners[0],
            old_corners[1]: first.corners[1],
        }
        end_corner_map = {
            old_corners[2]: second.corners[2],
            old_corners[3]: second.corners[3],
        }
        for constraint in old_constraints:
            if not self._constraint_openings(constraint) <= self.openings.keys():
                continue
            if (
                isinstance(constraint, Distance)
                and constraint.a.get("kind") == "edge"
                and constraint.b.get("kind") == "edge"
                and constraint.a.get("wall") == old_id
                and constraint.b.get("wall") == old_id
            ):
                continue
            if isinstance(constraint, Coincident):
                constraint.a = start_corner_map.get(
                    constraint.a, end_corner_map.get(constraint.a, constraint.a)
                )
                constraint.b = start_corner_map.get(
                    constraint.b, end_corner_map.get(constraint.b, constraint.b)
                )
                self.constraints[constraint.id] = constraint
            elif isinstance(constraint, Distance):
                for ref in (constraint.a, constraint.b):
                    if ref.get("kind") == "vertex":
                        ref["pid"] = start_corner_map.get(
                            ref["pid"], end_corner_map.get(ref["pid"], ref["pid"])
                        )
                    elif ref.get("kind") == "wall-end" and ref.get("wall") == old_id:
                        ref["wall"] = (
                            first.id if ref["end"] == "start" else second_generated_id
                        )
                    elif ref.get("kind") == "edge" and ref.get("wall") == old_id:
                        ref["wall"] = first.id if ref["side"] > 0 else second.id
                self.constraints[constraint.id] = constraint
            elif isinstance(constraint, AngleBetween):
                for ref in (constraint.a, constraint.b):
                    if ref.get("kind") == "wall" and ref.get("wall") == old_id:
                        ref["wall"] = first.id
                    elif ref.get("kind") == "segment":
                        for field, mapping in (("start", start_corner_map), ("end", end_corner_map)):
                            if ref[field] in mapping:
                                ref[field] = mapping[ref[field]]
                self.constraints[constraint.id] = constraint
            elif isinstance(constraint, (Horizontal, Vertical)):
                if constraint.target.get("kind") == "wall" and constraint.target.get("wall") == old_id:
                    constraint.target["wall"] = first.id
                self.constraints[constraint.id] = constraint
        for opening in old_openings:
            opening_end = opening.start + opening.length
            left_end = min(opening_end, first_end_station)
            right_start = max(opening.start, second_start_station)
            left_piece_length = max(0.0, left_end - opening.start)
            right_piece_length = max(0.0, opening_end - right_start)
            if left_piece_length and right_piece_length:
                opening.length = left_piece_length
                opening.wall = first.id
                second_id, second_name = self._next("o")
                self.openings[second_id] = Opening(
                    second_id,
                    second_name,
                    second_generated_id,
                    right_start - second_start_station,
                    right_piece_length,
                )
            elif left_piece_length:
                opening.length = left_piece_length
                opening.wall = first.id
            elif right_piece_length:
                opening.wall = second_generated_id
                opening.start = right_start - second_start_station
                opening.length = right_piece_length
            else:
                self.delete(opening.id)
        return first, second

    def _wall_length(self, wall_id: str) -> float:
        ax, ay, bx, by = self._axis_endpoints(self.walls[wall_id])
        return math.hypot(bx - ax, by - ay)

    def _axis_endpoints(self, wall: Wall) -> tuple[float, float, float, float]:
        c0, c1, c2, c3 = (self.points[pid] for pid in wall.corners)
        return (
            (c0.x + c1.x) / 2,
            (c0.y + c1.y) / 2,
            (c2.x + c3.x) / 2,
            (c2.y + c3.y) / 2,
        )

    def move_point(self, pid: str, x: float, y: float) -> None:
        pt = self.points[pid]  # KeyError -> client error message
        pt.x = float(x)
        pt.y = float(y)

    # -- constraint references --------------------------------------------

    def _validate_ref(self, ref: object) -> None:
        if not isinstance(ref, dict) or ref.get("kind") not in (
            "vertex", "edge", "opening", "opening-length", "wall-end"
        ):
            raise ValueError("invalid constraint reference")
        if ref["kind"] == "vertex":
            if ref.get("pid") not in self.points:
                raise ValueError("reference to an unknown point")
        elif ref["kind"] == "edge":
            if ref.get("wall") not in self.walls:
                raise ValueError("reference to an unknown wall")
            if ref.get("side") not in (1, -1):
                raise ValueError("invalid edge side")
        elif ref["kind"] == "wall-end":
            if (
                ref.get("wall") not in self.walls
                or ref.get("end") not in ("start", "end")
            ):
                raise ValueError("invalid wall endpoint reference")
        elif ref["kind"] == "opening":
            if (
                ref.get("opening") not in self.openings
                or ref.get("handle") not in ("start", "end")
            ):
                raise ValueError("invalid opening handle reference")
        elif ref.get("opening") not in self.openings:
            raise ValueError("invalid opening length reference")

    def _edge_frame(self, ref: dict) -> tuple[Point, Point]:
        """First and second corner of an edge ref, as (P, Q) points."""
        w = self.walls[ref["wall"]]
        i = 0 if ref["side"] > 0 else 1
        return self.points[w.corners[i]], self.points[w.corners[3 if ref["side"] > 0 else 2]]

    def _opening_handle_pos(self, ref: dict) -> tuple[float, float]:
        opening = self.openings[ref["opening"]]
        wall = self.walls[opening.wall]
        ax, ay, bx, by = self._axis_endpoints(wall)
        dx, dy = bx - ax, by - ay
        wall_length = math.hypot(dx, dy)
        station = (
            opening.start
            if ref["handle"] == "start"
            else opening.start + opening.length
        )
        if wall_length < 1e-9:
            return ax, ay
        return ax + station * dx / wall_length, ay + station * dy / wall_length

    def _ref_pos(self, ref: dict) -> tuple[float, float]:
        if ref["kind"] == "vertex":
            point = self.points[ref["pid"]]
            return point.x, point.y
        if ref["kind"] == "wall-end":
            ax, ay, bx, by = self._axis_endpoints(self.walls[ref["wall"]])
            return (ax, ay) if ref["end"] == "start" else (bx, by)
        if ref["kind"] == "opening":
            return self._opening_handle_pos(ref)
        if ref["kind"] == "opening-length":
            opening = self.openings[ref["opening"]]
            return opening.length, 0.0
        point, _ = self._edge_frame(ref)
        return point.x, point.y

    def _signed_edge_distance(self, ea: dict, eb: dict) -> float:
        """Signed distance from edge ea's line to the target of eb."""
        p, q = self._edge_frame(ea)
        dx, dy = q.x - p.x, q.y - p.y
        m = math.hypot(dx, dy)
        if m < 1e-9:
            return 0.0
        nx, ny = -dy / m, dx / m
        tx, ty = self._ref_pos(eb)
        return (tx - p.x) * nx + (ty - p.y) * ny

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

    def _validate_line_ref(self, ref: object) -> None:
        if not isinstance(ref, dict) or ref.get("kind") not in ("wall", "segment"):
            raise ValueError("invalid angle line reference")
        if ref["kind"] == "wall":
            if ref.get("wall") not in self.walls:
                raise ValueError("reference to an unknown wall")
        else:
            if ref.get("start") not in self.points or ref.get("end") not in self.points:
                raise ValueError("reference to an unknown point")
            if ref["start"] == ref["end"]:
                raise ValueError("a line needs two different points")

    def _normalize_line_ref(self, ref: dict) -> dict:
        if ref["kind"] == "segment":
            start, end = sorted((ref["start"], ref["end"]))
            return {"kind": "segment", "start": start, "end": end}
        return {"kind": "wall", "wall": ref["wall"]}

    def _line_endpoints(self, ref: dict) -> tuple[Point, Point]:
        if ref["kind"] == "wall":
            wall = self.walls[ref["wall"]]
            return self.points[wall.corners[0]], self.points[wall.corners[3]]
        return self.points[ref["start"]], self.points[ref["end"]]

    def _signed_line_angle(self, a: dict, b: dict) -> float:
        p1, q1 = self._line_endpoints(a)
        p2, q2 = self._line_endpoints(b)
        ax, ay = q1.x - p1.x, q1.y - p1.y
        bx, by = q2.x - p2.x, q2.y - p2.y
        return math.atan2(ax * by - ay * bx, ax * bx + ay * by)

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
            point_kinds = ("vertex", "opening", "opening-length", "wall-end")
            if ra["kind"] in point_kinds and rb["kind"] in point_kinds:
                if (
                    ra["kind"] == rb["kind"] == "opening-length"
                    and ra["opening"] == rb["opening"]
                ):
                    raise ValueError(
                        "cannot dimension an opening length against itself"
                    )
                if _ref_key(ra) == _ref_key(rb):
                    raise ValueError("cannot dimension a target against itself")
                refs = sorted((ra, rb), key=_ref_key)
                keys = tuple(_ref_key(ref) for ref in refs)
                for c in self.constraints.values():
                    if isinstance(c, Distance) and c.offset is None:
                        if tuple(_ref_key(ref) for ref in (c.a, c.b)) == keys:
                            if (
                                c.a["kind"] == "opening-length"
                                or c.b["kind"] == "opening-length"
                            ):
                                ref = c.a if c.a["kind"] == "opening-length" else c.b
                                opening = self.openings[ref["opening"]]
                                if value > self._wall_length(opening.wall):
                                    raise ValueError(
                                        "opening length cannot exceed its host wall"
                                    )
                                opening.length = value
                            elif self._opening_length_ref_pair(c.a, c.b):
                                opening = self.openings[c.a["opening"]]
                                if opening.start + value > self._wall_length(opening.wall):
                                    raise ValueError(
                                        "opening length cannot exceed its host wall"
                                    )
                                opening.length = value
                            c.length = value
                            return c, False
                cid, name = self._next("d")
                c = Distance(cid, name, refs[0], refs[1], value, None)
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
            if "a" in data and "b" in data:
                ra, rb = data["a"], data["b"]
            else:
                ra, rb = {"kind": "wall", "wall": data["wall_a"]}, {"kind": "wall", "wall": data["wall_b"]}
            self._validate_line_ref(ra)
            self._validate_line_ref(rb)
            ra, rb = self._normalize_line_ref(ra), self._normalize_line_ref(rb)
            if _ref_key(ra) == _ref_key(rb):
                raise ValueError("pick two different sides")
            value = _fold_angle(data["degrees"])
            keys = sorted((_ref_key(ra), _ref_key(rb)))
            for c in self.constraints.values():
                if isinstance(c, AngleBetween) and sorted((_ref_key(c.a), _ref_key(c.b))) == keys:
                    sign = -1.0 if c.degrees < 0 else 1.0
                    c.degrees = sign * value
                    return c, False
            ra, rb = sorted((ra, rb), key=_ref_key)
            theta = self._signed_line_angle(ra, rb)
            value = -value if theta < 0 else value
            cid, name = self._next("a")
            c = AngleBetween(cid, name, ra, rb, value)
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
            target = data.get("target", {"kind": "wall", "wall": data.get("wall")})
            self._validate_line_ref(target)
            target = self._normalize_line_ref(target)
            cls = Horizontal if ctype == "horizontal" else Vertical
            for c in self.constraints.values():
                if isinstance(c, cls) and _ref_key(c.target) == _ref_key(target):
                    return c, False
            cid, name = self._next("h" if ctype == "horizontal" else "v")
            c = cls(cid, name, target)
        else:
            raise ValueError(f"unknown constraint type {ctype!r}")
        self.constraints[c.id] = c
        c = self._promote_symbol_constraint(c)
        return c, True

    def _promote_symbol_constraint(self, constraint: Constraint) -> Constraint:
        point_ids = self._constraint_points(constraint)
        if not point_ids:
            return constraint
        for rectangle in self.rectangles.values():
            corner_ids = set(rectangle.corners)
            if not point_ids <= corner_ids or not rectangle.symbol:
                continue
            if not self._is_local_symbol_constraint(constraint, corner_ids):
                continue
            symbol = self.symbols.get(rectangle.symbol)
            if symbol is None:
                continue
            local = self._localize_symbol_constraint(constraint, rectangle)
            for existing in symbol.constraints.values():
                if type(existing) is type(local) and self._symbol_constraint_key(existing) == self._symbol_constraint_key(local):
                    del self.constraints[constraint.id]
                    if isinstance(local, (Distance, AngleBetween)):
                        value = local.length if isinstance(local, Distance) else local.degrees
                        self._update_constraint_value(existing, value)
                    return existing
            symbol.constraints[constraint.id] = local
            del self.constraints[constraint.id]
            return local
        return constraint

    def _is_local_symbol_constraint(self, constraint: Constraint, corner_ids: set[str]) -> bool:
        if isinstance(constraint, Coincident):
            return {constraint.a, constraint.b} <= corner_ids
        if isinstance(constraint, Distance):
            return all(
                ref.get("kind") == "vertex" and ref.get("pid") in corner_ids
                for ref in (constraint.a, constraint.b)
            )
        if isinstance(constraint, AngleBetween):
            return all(
                ref.get("kind") == "segment"
                and {ref.get("start"), ref.get("end")} <= corner_ids
                for ref in (constraint.a, constraint.b)
            )
        if isinstance(constraint, (Horizontal, Vertical)):
            ref = constraint.target
            return ref.get("kind") == "segment" and {ref.get("start"), ref.get("end")} <= corner_ids
        return False

    def _symbol_constraint_key(self, constraint: Constraint) -> str:
        local = deepcopy(constraint)
        data = _constraint_dict(local)
        data.pop("id", None)
        data.pop("name", None)
        data.pop("degrees", None)
        data.pop("length", None)
        return json.dumps(data, sort_keys=True)

    def _opening_length_ref_pair(self, a: dict, b: dict) -> bool:
        return (
            a.get("kind") == b.get("kind") == "opening"
            and a.get("opening") == b.get("opening")
            and {a.get("handle"), b.get("handle")} == {"start", "end"}
        )

    def update_constraint(self, cid: str, value: float) -> None:
        for symbol in self.symbols.values():
            if cid in symbol.constraints:
                self._update_constraint_value(symbol.constraints[cid], value)
                return
        c = self.constraints[cid]  # KeyError -> client error message
        self._update_constraint_value(c, value)

    def _update_constraint_value(self, c: Constraint, value: float) -> None:
        if isinstance(c, Distance):
            if value <= 0:
                raise ValueError("distance must be positive")
            if c.a["kind"] == "opening-length" or c.b["kind"] == "opening-length":
                ref = c.a if c.a["kind"] == "opening-length" else c.b
                opening = self.openings[ref["opening"]]
                if value > self._wall_length(opening.wall):
                    raise ValueError(
                        "opening length cannot exceed its host wall"
                    )
                opening.length = value
            elif self._opening_length_ref_pair(c.a, c.b):
                opening = self.openings[c.a["opening"]]
                end = opening.start + value
                ax, ay, bx, by = self._axis_endpoints(self.walls[opening.wall])
                if end > math.hypot(bx - ax, by - ay):
                    raise ValueError("opening length cannot exceed its host wall")
                opening.length = value
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
        if isinstance(c, Distance):
            return ref_walls(c.a, self.openings) | ref_walls(c.b, self.openings)
        refs = (c.a, c.b) if isinstance(c, AngleBetween) else (c.target,) if isinstance(c, (Horizontal, Vertical)) else ()
        return {ref["wall"] for ref in refs if ref.get("kind") == "wall"}

    def _constraint_points(self, c: Constraint) -> set[str]:
        if isinstance(c, Coincident):
            return {c.a, c.b}
        if isinstance(c, Distance):
            return ref_points(c.a) | ref_points(c.b)
        refs = (c.a, c.b) if isinstance(c, AngleBetween) else (c.target,) if isinstance(c, (Horizontal, Vertical)) else ()
        return {
            pid
            for ref in refs
            if ref.get("kind") == "segment"
            for pid in (ref["start"], ref["end"])
        }

    def _constraint_openings(self, c: Constraint) -> set[str]:
        if isinstance(c, Distance):
            return ref_openings(c.a) | ref_openings(c.b)
        return set()

    def delete(self, item_id: str) -> bool:
        if item_id in self.rectangles:
            rectangle = self.rectangles.pop(item_id)
            if rectangle.symbol:
                symbol = self.symbols.get(rectangle.symbol)
                if symbol and any(instance.symbol == symbol.id for instance in self.rectangles.values()):
                    removed_points = set(rectangle.corners)
                    for cid, constraint in list(self.constraints.items()):
                        if self._constraint_points(constraint) & removed_points:
                            del self.constraints[cid]
                    for pid in removed_points:
                        self.points.pop(pid, None)
                    return True
            removed_points = set(rectangle.corners)
            for cid, constraint in list(self.constraints.items()):
                if self._constraint_points(constraint) & removed_points:
                    del self.constraints[cid]
            for pid in removed_points:
                self.points.pop(pid, None)
            return True
        if item_id in self.openings:
            del self.openings[item_id]
            for cid, constraint in list(self.constraints.items()):
                if item_id in self._constraint_openings(constraint):
                    del self.constraints[cid]
            return True
        if item_id in self.walls:
            del self.walls[item_id]
            removed_openings = {
                oid for oid, opening in self.openings.items() if opening.wall == item_id
            }
            self.openings = {
                oid: opening
                for oid, opening in self.openings.items()
                if opening.wall != item_id
            }
            for cid in [
                cid
                for cid, c in self.constraints.items()
                if item_id in self._constraint_walls(c)
                or removed_openings & self._constraint_openings(c)
            ]:
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
        for symbol in self.symbols.values():
            if item_id in symbol.constraints:
                del symbol.constraints[item_id]
                return True
        return False

    # -- serialisation -----------------------------------------------------

    @classmethod
    def from_dict(cls, data: dict) -> Document:
        if not isinstance(data, dict):
            raise ValueError("map file must contain a JSON object")
        required = {"points", "walls", "openings", "rectangles", "symbols", "constraints"}
        if not required.issubset(data):
            raise ValueError("map file is missing required document data")
        if not isinstance(data["points"], dict) or any(
            not isinstance(data[key], list)
            for key in ("walls", "openings", "rectangles", "symbols", "constraints")
        ):
            raise ValueError("invalid map file data")

        doc = cls()
        try:
            for pid, point in data["points"].items():
                if not isinstance(point, dict) or point.get("id") != pid:
                    raise ValueError("invalid point data")
                x, y = float(point["x"]), float(point["y"])
                if not math.isfinite(x) or not math.isfinite(y):
                    raise ValueError("point coordinates must be finite")
                if pid in doc.points:
                    raise ValueError("duplicate point id")
                doc.points[pid] = Point(pid, str(point["name"]), x, y)

            for item in data["walls"]:
                wall = Wall(str(item["id"]), str(item["name"]), list(item["corners"]))
                if wall.id in doc.walls:
                    raise ValueError("duplicate wall id")
                if len(wall.corners) != 4 or any(pid not in doc.points for pid in wall.corners):
                    raise ValueError("invalid wall corners")
                doc.walls[wall.id] = wall

            for item in data["openings"]:
                opening = Opening(
                    str(item["id"]), str(item["name"]), str(item["wall"]),
                    float(item["start"]), float(item["length"]),
                )
                if opening.id in doc.openings:
                    raise ValueError("duplicate opening id")
                if opening.wall not in doc.walls or not all(
                    math.isfinite(value) for value in (opening.start, opening.length)
                ) or opening.length <= 0:
                    raise ValueError("invalid opening data")
                doc.openings[opening.id] = opening

            for item in data["rectangles"]:
                rectangle = Rectangle(
                    str(item["id"]), str(item["name"]), list(item["corners"]), item.get("symbol")
                )
                if rectangle.id in doc.rectangles:
                    raise ValueError("duplicate rectangle id")
                if len(rectangle.corners) != 4 or any(pid not in doc.points for pid in rectangle.corners):
                    raise ValueError("invalid rectangle corners")
                doc.rectangles[rectangle.id] = rectangle

            for item in data["symbols"]:
                symbol = Symbol(
                    str(item["id"]), str(item["label"]), float(item["width"]),
                    float(item["height"]),
                )
                if not all(math.isfinite(value) and value > 0 for value in (symbol.width, symbol.height)):
                    raise ValueError("symbol dimensions must be positive and finite")
                if symbol.id in doc.symbols:
                    raise ValueError("duplicate symbol id")
                for raw in item["constraints"]:
                    constraint = _constraint_from_dict(raw, symbol=True)
                    if constraint.id in symbol.constraints:
                        raise ValueError("duplicate symbol constraint id")
                    symbol.constraints[constraint.id] = constraint
                if len(symbol.constraints) != len(item["constraints"]):
                    raise ValueError("duplicate symbol constraint id")
                doc.symbols[symbol.id] = symbol

            for item in data["constraints"]:
                constraint = _constraint_from_dict(item)
                if constraint.id in doc.constraints:
                    raise ValueError("duplicate constraint id")
                doc.constraints[constraint.id] = constraint

            constraint_ids = set(doc.constraints)
            for symbol in doc.symbols.values():
                if constraint_ids.intersection(symbol.constraints):
                    raise ValueError("constraint ids must be unique")
                constraint_ids.update(symbol.constraints)
            if any(rectangle.symbol is not None and rectangle.symbol not in doc.symbols
                   for rectangle in doc.rectangles.values()):
                raise ValueError("rectangle references an unknown symbol")
            if len(doc.points) != len(data["points"]):
                raise ValueError("invalid point data")
            for wall in doc.walls.values():
                if len(set(wall.corners)) != 4:
                    raise ValueError("wall corners must be distinct")
            for rectangle in doc.rectangles.values():
                if len(set(rectangle.corners)) != 4:
                    raise ValueError("rectangle corners must be distinct")
            for constraint in doc.expanded_constraints():
                if isinstance(constraint, Coincident):
                    if constraint.a not in doc.points or constraint.b not in doc.points:
                        raise ValueError("constraint references an unknown point")
                elif isinstance(constraint, Distance):
                    doc._validate_ref(constraint.a)
                    doc._validate_ref(constraint.b)
                elif isinstance(constraint, AngleBetween):
                    doc._validate_line_ref(constraint.a)
                    doc._validate_line_ref(constraint.b)
                else:
                    doc._validate_line_ref(constraint.target)
            doc._counters = {}
            for item_id in (
                [*doc.points, *doc.walls, *doc.openings, *doc.rectangles, *doc.symbols,
                 *doc.constraints, *(cid for symbol in doc.symbols.values() for cid in symbol.constraints)]
            ):
                match = re.fullmatch(r"([a-z]+)_(\d+)", item_id)
                if match:
                    prefix, number = match.groups()
                    doc._counters[prefix] = max(doc._counters.get(prefix, 0), int(number))
        except (AttributeError, IndexError, KeyError, TypeError, OverflowError) as exc:
            raise ValueError("invalid map file data") from exc
        return doc

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
            "openings": [
                {
                    "id": opening.id,
                    "name": opening.name,
                    "wall": opening.wall,
                    "start": round(opening.start, 6),
                    "length": round(opening.length, 6),
                }
                for opening in self.openings.values()
            ],
            "rectangles": [
                {
                    "id": rectangle.id,
                    "name": rectangle.name,
                    "corners": list(rectangle.corners),
                    "symbol": rectangle.symbol,
                }
                for rectangle in self.rectangles.values()
            ],
            "symbols": [
                {
                    "id": symbol.id,
                    "label": symbol.label,
                    "width": round(symbol.width, 6),
                    "height": round(symbol.height, 6),
                    "constraints": [_constraint_dict(c) for c in symbol.constraints.values()],
                }
                for symbol in self.symbols.values()
            ],
            "constraints": [_constraint_dict(c) for c in self.constraints.values()],
        }


def _constraint_from_dict(data: dict, symbol: bool = False) -> Constraint:
    if not isinstance(data, dict):
        raise ValueError("invalid constraint data")
    cid, name, ctype = str(data["id"]), str(data["name"]), data["type"]
    if not isinstance(ctype, str):
        raise ValueError("invalid constraint type")

    if ctype == "coincident":
        constraint = Coincident(cid, name, data["a"], data["b"])
        if symbol and any(not isinstance(point, int) or not 0 <= point < 4 for point in (constraint.a, constraint.b)):
            raise ValueError("invalid symbol corner reference")
    elif ctype == "distance":
        a, b = data["a"], data["b"]
        if not isinstance(a, dict) or not isinstance(b, dict):
            raise ValueError("invalid distance references")
        if symbol and any(ref.get("kind") != "vertex" or not isinstance(ref.get("corner"), int)
                          or not 0 <= ref["corner"] < 4 for ref in (a, b)):
            raise ValueError("invalid symbol distance references")
        length = float(data["length"])
        offset = None if data.get("offset") is None else float(data["offset"])
        if not math.isfinite(length) or length <= 0 or (offset is not None and not math.isfinite(offset)):
            raise ValueError("invalid distance values")
        constraint = Distance(cid, name, deepcopy(a), deepcopy(b), length, offset)
    elif ctype == "angle":
        a, b = data["a"], data["b"]
        if not isinstance(a, dict) or not isinstance(b, dict):
            raise ValueError("invalid angle references")
        if symbol and any(ref.get("kind") != "segment" or not isinstance(ref.get("start_corner"), int)
                          or not isinstance(ref.get("end_corner"), int)
                          or not 0 <= ref["start_corner"] < 4 or not 0 <= ref["end_corner"] < 4
                          for ref in (a, b)):
            raise ValueError("invalid symbol angle references")
        degrees = float(data["degrees"])
        if not math.isfinite(degrees) or degrees < -180 or degrees > 180:
            raise ValueError("invalid angle value")
        constraint = AngleBetween(cid, name, deepcopy(a), deepcopy(b), degrees)
    elif ctype in ("horizontal", "vertical"):
        target = data["target"]
        if not isinstance(target, dict):
            raise ValueError("invalid constraint target")
        if symbol and (target.get("kind") != "segment"
                       or not isinstance(target.get("start_corner"), int)
                       or not isinstance(target.get("end_corner"), int)
                       or not 0 <= target["start_corner"] < 4
                       or not 0 <= target["end_corner"] < 4):
            raise ValueError("invalid symbol line reference")
        constraint = (Horizontal if ctype == "horizontal" else Vertical)(cid, name, deepcopy(target))
    else:
        raise ValueError(f"unknown constraint type {ctype!r}")
    return constraint


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
            "a": c.a,
            "b": c.b,
            "degrees": round(c.degrees, 4),
        }
    if isinstance(c, Horizontal):
        return {"id": c.id, "name": c.name, "type": "horizontal", "target": c.target}
    return {"id": c.id, "name": c.name, "type": "vertical", "target": c.target}
