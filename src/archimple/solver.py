"""Levenberg–Marquardt solver for the sketch's geometric constraints.

User constraints (distances, angles, coincidences, horizontal/vertical)
plus the hidden per-wall constraints that keep every wall rectangular and
its thickness non-negative. Each row carries the analytic partial
derivatives with respect to the point coordinates it touches; rows are
assembled into a dense Jacobian (documents are small) and minimised with
damped Gauss–Newton iterations.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

try:
    from ._native import normal_equations as _native_normal_equations
    from ._native import solve_damped as _native_solve_damped
except ImportError:
    _native_normal_equations = None
    _native_solve_damped = None

from .model import (
    AngleBetween,
    Coincident,
    Distance,
    Document,
    Horizontal,
    Vertical,
)

EPS_THICK = 1e-3  # hidden floor on cross(v, u) ≈ thickness × length, m²


@dataclass
class SolveStatus:
    converged: bool
    max_residual: float
    params: int
    rows: int
    dofs: int
    iterations: int

    def to_dict(self) -> dict:
        return {
            "converged": self.converged,
            "max_residual": self.max_residual,
            "params": self.params,
            "rows": self.rows,
            "dofs": self.dofs,
            "iterations": self.iterations,
        }


Row = tuple[float, list[tuple[str, int, float]]]


def _length_row(pa, pb, a: str, b: str, target: float) -> Row:
    dx, dy = pb[0] - pa[0], pb[1] - pa[1]
    length = math.hypot(dx, dy)
    ux, uy = (1.0, 0.0) if length < 1e-9 else (dx / length, dy / length)
    return length - target, [(a, 0, -ux), (a, 1, -uy), (b, 0, ux), (b, 1, uy)]


def _orientation_row(pa, pb, a: str, b: str, target: float) -> Row:
    dx, dy = pb[0] - pa[0], pb[1] - pa[1]
    length2 = dx * dx + dy * dy
    if length2 < 1e-18:
        return 0.0, []
    angle = math.atan2(dy, dx) - target
    residual = math.atan2(math.sin(angle), math.cos(angle))
    return residual, [
        (a, 0, dy / length2), (a, 1, -dx / length2),
        (b, 0, -dy / length2), (b, 1, dx / length2),
    ]


def _coincident_rows(pa, pb, a: str, b: str) -> list[Row]:
    (ax, ay), (bx, by) = pa, pb
    return [
        (ax - bx, [(a, 0, 1.0), (b, 0, -1.0)]),
        (ay - by, [(a, 1, 1.0), (b, 1, -1.0)]),
    ]


def _position_derivs(pid: str) -> list[tuple[str, int, float, float]]:
    return [(pid, 0, 1.0, 0.0), (pid, 1, 0.0, 1.0)]


def _distance_point_rows(pa, pb, da, db, length: float) -> list[Row]:
    dx, dy = pb[0] - pa[0], pb[1] - pa[1]
    d = math.hypot(dx, dy)
    ux, uy = (1.0, 0.0) if d < 1e-9 else (dx / d, dy / d)
    derivs = [
        (key, comp, -ux * x - uy * y) for key, comp, x, y in da
    ] + [(key, comp, ux * x + uy * y) for key, comp, x, y in db]
    return [(d - length, derivs)]


def _point_edge_rows(
    pp,
    P,
    Q,
    p_derivs: list[tuple[str, int, float, float]],
    P_pid: str,
    Q_pid: str,
    offset: float,
) -> list[Row]:
    """Signed distance from the P–Q edge line to point pp.

    D = (pp - P)·n̂ with n̂ = perp(u)/|u|, u = Q - P.
    """
    wx, wy = pp[0] - P[0], pp[1] - P[1]
    ux, uy = Q[0] - P[0], Q[1] - P[1]
    m2 = ux * ux + uy * uy
    if m2 < 1e-18:
        return []
    m = math.sqrt(m2)
    nx, ny = -uy / m, ux / m
    d = wx * nx + wy * ny
    # w - d·n̂, needed for the direction derivatives
    ex, ey = wx - d * nx, wy - d * ny
    gx, gy = ey / m, -ex / m
    return [(
        d - offset,
        [
            *[(pid, comp, x * nx + y * ny) for pid, comp, x, y in p_derivs],
            (P_pid, 0, -nx - gx), (P_pid, 1, -ny - gy),
            (Q_pid, 0, gx), (Q_pid, 1, gy),
        ],
    )]


def _angle_rows(pa1, pa2, pb1, pb2, ids_a, ids_b, degrees: float) -> list[Row]:
    ax, ay = pa2[0] - pa1[0], pa2[1] - pa1[1]
    bx, by = pb2[0] - pb1[0], pb2[1] - pb1[1]
    cross = ax * by - ay * bx
    dot = ax * bx + ay * by
    s = cross * cross + dot * dot
    if s < 1e-18:
        return []
    theta = math.atan2(cross, dot)
    r = theta - math.radians(degrees)
    r = math.atan2(math.sin(r), math.cos(r))
    inv = 1.0 / s
    dax = (dot * by - cross * bx) * inv
    day = (-dot * bx - cross * by) * inv
    dbx = (-dot * ay - cross * ax) * inv
    dby = (dot * ax - cross * ay) * inv
    (a_s, a_e), (b_s, b_e) = ids_a, ids_b
    return [(
        r,
        [
            (a_e, 0, dax), (a_s, 0, -dax),
            (a_e, 1, day), (a_s, 1, -day),
            (b_e, 0, dbx), (b_s, 0, -dbx),
            (b_e, 1, dby), (b_s, 1, -dby),
        ],
    )]


def _axis_rows(pa, pb, a: str, b: str, comp: int) -> list[Row]:
    # comp 0: vertical (equal x on the wall axis), comp 1: horizontal (equal y)
    return [(pb[comp] - pa[comp], [(a, comp, -1.0), (b, comp, 1.0)])]


def _wall_hidden_rows(w, get) -> list[Row]:
    p0, p1, p2, p3 = w.corners
    c0, c1, c2, c3 = get(p0), get(p1), get(p2), get(p3)
    rows: list[Row] = []
    # parallelogram: c3 - c0 == c2 - c1
    for comp in (0, 1):
        r = (c3[comp] - c0[comp]) - (c2[comp] - c1[comp])
        rows.append((r, [
            (p3, comp, 1.0), (p0, comp, -1.0),
            (p2, comp, -1.0), (p1, comp, 1.0),
        ]))
    # right angle: (c3 - c0)·(c1 - c0) == 0
    ux, uy = c3[0] - c0[0], c3[1] - c0[1]
    vx, vy = c1[0] - c0[0], c1[1] - c0[1]
    f = ux * vx + uy * vy
    rows.append((f, [
        (p3, 0, vx), (p3, 1, vy),
        (p1, 0, ux), (p1, 1, uy),
        (p0, 0, -ux - vx), (p0, 1, -uy - vy),
    ]))
    # thickness floor: cross(c1 - c0, c3 - c0) >= eps  (negative ⇒ flipped)
    g = vx * uy - vy * ux
    if g < EPS_THICK:
        r = EPS_THICK - g
        dvx, dvy = uy, -ux        # dG/dv
        dux, duy = -vy, vx        # dG/du
        rows.append((r, [
            (p1, 0, -dvx), (p1, 1, -dvy),
            (p3, 0, -dux), (p3, 1, -duy),
            (p0, 0, dvx + dux), (p0, 1, dvy + duy),
        ]))
    return rows


def _line_pids(doc: Document, ref: dict) -> tuple[str, str] | None:
    if ref["kind"] == "wall":
        wall = doc.walls.get(ref["wall"])
        return (wall.corners[0], wall.corners[3]) if wall else None
    if ref["kind"] == "segment":
        return ref["start"], ref["end"]
    return None


def _edge_pids(doc: Document, ref: dict) -> tuple[str, str] | None:
    w = doc.walls.get(ref["wall"])
    if w is None or len(w.corners) != 4:
        return None
    i = 0 if ref["side"] > 0 else 1
    return w.corners[i], w.corners[3 if ref["side"] > 0 else 2]


def _ref_position(doc: Document, ref: dict, get, get_station):
    if ref["kind"] == "vertex":
        pid = ref["pid"]
        return get(pid), _position_derivs(pid)
    if ref["kind"] == "edge":
        pids = _edge_pids(doc, ref)
        if pids is None:
            return None
        pid = pids[0]
        return get(pid), _position_derivs(pid)
    if ref["kind"] == "wall-end":
        wall = doc.walls.get(ref["wall"])
        if wall is None or len(wall.corners) != 4:
            return None
        pids = wall.corners[:2] if ref["end"] == "start" else wall.corners[2:]
        derivs = []
        for pid in pids:
            derivs.extend([
                (pid, 0, 0.5, 0.0),
                (pid, 1, 0.0, 0.5),
            ])
        position = tuple(
            sum(get(pid)[comp] for pid in pids) / 2 for comp in (0, 1)
        )
        return position, derivs
    if ref["kind"] == "opening-length":
        opening = doc.openings.get(ref["opening"])
        if opening is None:
            return None
        i = f"@{opening.id}:length"
        return (get_station(opening)[1], 0.0), [(i, 0, 1.0, 0.0)]

    opening = doc.openings.get(ref["opening"])
    wall = doc.walls.get(opening.wall) if opening else None
    if wall is None or len(wall.corners) != 4:
        return None
    c0, c1, c2, c3 = wall.corners
    start0, start1 = get(c0), get(c1)
    end0, end1 = get(c2), get(c3)
    start = ((start0[0] + start1[0]) / 2, (start0[1] + start1[1]) / 2)
    end = ((end0[0] + end1[0]) / 2, (end0[1] + end1[1]) / 2)
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dy)
    if length < 1e-9:
        return None
    opening_start, opening_length = get_station(opening)
    station = (
        opening_start
        if ref["handle"] == "start"
        else opening_start + opening_length
    )
    alpha = station / length
    ux, uy = dx / length, dy / length
    mxx, mxy, myy = uy * uy, -ux * uy, ux * ux
    start_xx, start_xy, start_yy = 1 - alpha * mxx, -alpha * mxy, 1 - alpha * myy
    end_xx, end_xy, end_yy = alpha * mxx, alpha * mxy, alpha * myy
    derivs = [(f"@{opening.id}:start", 0, ux, uy)]
    if ref["handle"] == "end":
        derivs.append((f"@{opening.id}:length", 0, ux, uy))
    for pid in (c0, c1):
        derivs.extend([
            (pid, 0, start_xx / 2, start_xy / 2),
            (pid, 1, start_xy / 2, start_yy / 2),
        ])
    for pid in (c2, c3):
        derivs.extend([
            (pid, 0, end_xx / 2, end_xy / 2),
            (pid, 1, end_xy / 2, end_yy / 2),
        ])
    position = (start[0] + alpha * dx, start[1] + alpha * dy)
    return position, derivs


def solve_document(
    doc: Document,
    pinned: tuple[str, ...] | set[str] = (),
    *,
    max_iter: int = 80,
    preserve_lengths: dict[str, float] | None = None,
    rotating: set[str] | tuple[str, ...] = (),
) -> SolveStatus:
    pinned = set(pinned)
    rotating = set(rotating)
    free = [p for p in doc.points.values() if p.id not in pinned]
    point_index = {p.id: i for i, p in enumerate(free)}
    opening_index = {
        oid: len(free) + i
        for i, oid in enumerate(doc.openings)
    }
    n = 2 * (len(free) + len(opening_index))

    def pt(coords: np.ndarray):
        def get_station(opening):
            i = opening_index[opening.id]
            return float(coords[2 * i]), float(coords[2 * i + 1])

        def get(pid: str) -> tuple[float, float]:
            i = point_index.get(pid)
            if i is None:
                p = doc.points[pid]
                return p.x, p.y
            return float(coords[2 * i]), float(coords[2 * i + 1])

        return get, get_station

    entity_preferences: list[tuple[str, list[tuple[str, str]], list[tuple[str, str]]]] = []
    point_entities: dict[str, str] = {}
    for wall in doc.walls.values():
        if all(pid in doc.points for pid in wall.corners):
            a, b = wall.corners[0], wall.corners[3]
            entity_preferences.append((wall.id, [(a, b)], [(a, b)]))
            for pid in wall.corners:
                point_entities[pid] = wall.id
    for rectangle in doc.rectangles.values():
        if all(pid in doc.points for pid in rectangle.corners):
            c = rectangle.corners
            entity_preferences.append((rectangle.id, [(c[0], c[1]), (c[0], c[3])],
                                       [(c[0], c[1]), (c[0], c[3])]))
            for pid in c:
                point_entities[pid] = rectangle.id
    explicit_rotation: set[str] = set()
    preserve_rotation: set[str] = set()
    explicit_lengths: set[str] = set()
    for constraint in doc.expanded_constraints():
        if isinstance(constraint, AngleBetween):
            if constraint.preserve_orientation:
                preserve_rotation.update(
                    ref["wall"]
                    for ref in (constraint.a, constraint.b)
                    if ref.get("kind") == "wall"
                )
            else:
                for ref in (constraint.a, constraint.b):
                    if ref.get("kind") == "wall":
                        explicit_rotation.add(ref["wall"])
                    elif ref.get("kind") == "segment":
                        pair = {ref["start"], ref["end"]}
                        for entity_id, rotation_axes, _ in entity_preferences:
                            if any(pair == {a, b} for a, b in rotation_axes):
                                explicit_rotation.add(entity_id)
        elif isinstance(constraint, (Horizontal, Vertical)):
            if constraint.target.get("kind") == "wall":
                explicit_rotation.add(constraint.target["wall"])
        elif isinstance(constraint, Distance):
            refs = (constraint.a, constraint.b)
            if all(ref.get("kind") == "vertex" for ref in refs):
                pair = {refs[0]["pid"], refs[1]["pid"]}
                for entity_id, _, length_axes in entity_preferences:
                    if any(pair == {a, b} for a, b in length_axes):
                        explicit_lengths.add(entity_id)
            for ref in refs:
                if ref.get("kind") == "vertex":
                    entity_id = point_entities.get(ref["pid"])
                    if entity_id:
                        explicit_lengths.add(entity_id)
                elif ref.get("kind") == "wall-end":
                    explicit_lengths.add(ref["wall"])
                elif ref.get("kind") in ("opening", "opening-length"):
                    opening = doc.openings.get(ref["opening"])
                    if opening:
                        explicit_lengths.add(opening.wall)
    directly_transformed: set[str] = {
        entity_id
        for entity_id, corners in [
            *((wall.id, wall.corners) for wall in doc.walls.values()),
            *((rectangle.id, rectangle.corners) for rectangle in doc.rectangles.values()),
        ]
        if any(pid in pinned for pid in corners)
    }
    preferences = []
    for entity_id, rotation_axes, length_axes in entity_preferences:
        if entity_id not in directly_transformed and entity_id not in rotating and (
            entity_id in preserve_rotation or entity_id not in explicit_rotation
        ):
            for a, b in rotation_axes:
                pa, pb = doc.points[a], doc.points[b]
                preferences.append(("rotation", a, b, math.atan2(pb.y - pa.y, pb.x - pa.x)))
        if entity_id not in directly_transformed and entity_id not in explicit_lengths:
            for a, b in length_axes:
                pa, pb = doc.points[a], doc.points[b]
                preferences.append(("length", a, b, math.hypot(pb.x - pa.x, pb.y - pa.y)))
    for wall_id, target_length in (preserve_lengths or {}).items():
        wall = doc.walls.get(wall_id)
        if wall is not None:
            preferences.append(("preserve_length", wall.corners[0], wall.corners[3], target_length))

    def evaluate(
        coords: np.ndarray, want_jac: bool
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
        get, get_station = pt(coords)
        rows: list[Row] = []
        # hidden per-wall constraints
        for w in doc.walls.values():
            if all(pid in doc.points for pid in w.corners):
                rows.extend(_wall_hidden_rows(w, get))
        for opening in doc.openings.values():
            i = opening_index[opening.id]
            start = float(coords[2 * i])
            length = float(coords[2 * i + 1])
            wall = doc.walls.get(opening.wall)
            if wall is None:
                continue
            axis_start = tuple(
                (get(wall.corners[0])[comp] + get(wall.corners[1])[comp]) / 2
                for comp in (0, 1)
            )
            axis_end = tuple(
                (get(wall.corners[2])[comp] + get(wall.corners[3])[comp]) / 2
                for comp in (0, 1)
            )
            dx = axis_end[0] - axis_start[0]
            dy = axis_end[1] - axis_start[1]
            wall_length = math.hypot(dx, dy)
            opening_key = f"@{opening.id}"
            if start < 0:
                rows.append((-start, [(f"{opening_key}:start", 0, -1.0)]))
            if length < 0.001:
                rows.append((0.001 - length, [(f"{opening_key}:length", 0, -1.0)]))
            if start + length > wall_length and wall_length > 1e-9:
                ux, uy = dx / wall_length, dy / wall_length
                derivs = [
                    (f"{opening_key}:start", 0, 1.0),
                    (f"{opening_key}:length", 0, 1.0),
                ]
                for pid in wall.corners[:2]:
                    derivs.extend([
                        (pid, 0, ux / 2),
                        (pid, 1, uy / 2),
                    ])
                for pid in wall.corners[2:]:
                    derivs.extend([
                        (pid, 0, -ux / 2),
                        (pid, 1, -uy / 2),
                    ])
                rows.append((start + length - wall_length, derivs))
        # user constraints
        for c in doc.expanded_constraints():
            if isinstance(c, Coincident):
                if c.a in doc.points and c.b in doc.points:
                    rows.extend(_coincident_rows(get(c.a), get(c.b), c.a, c.b))
            elif isinstance(c, Distance):
                ra, rb = c.a, c.b
                if ra["kind"] != "edge" and rb["kind"] != "edge":
                    pos_a = _ref_position(doc, ra, get, get_station)
                    pos_b = _ref_position(doc, rb, get, get_station)
                    if pos_a is not None and pos_b is not None:
                        if ra["kind"] == "opening-length":
                            opening = doc.openings[ra["opening"]]
                            idx = opening_index[opening.id]
                            rows.append((
                                float(coords[2 * idx + 1]) - c.length,
                                [(f"@{opening.id}:length", 0, 1.0)],
                            ))
                        elif rb["kind"] == "opening-length":
                            opening = doc.openings[rb["opening"]]
                            idx = opening_index[opening.id]
                            rows.append((
                                float(coords[2 * idx + 1]) - c.length,
                                [(f"@{opening.id}:length", 0, 1.0)],
                            ))
                        else:
                            rows.extend(_distance_point_rows(
                                pos_a[0], pos_b[0], pos_a[1], pos_b[1], c.length
                            ))
                elif ra["kind"] == "edge":
                    ep = _edge_pids(doc, ra)
                    target = _ref_position(doc, rb, get, get_station)
                    if ep is None or target is None:
                        continue
                    if ep[0] in doc.points and ep[1] in doc.points:
                        off = c.offset if c.offset is not None else 0.0
                        rows.extend(_point_edge_rows(
                            target[0],
                            get(ep[0]),
                            get(ep[1]),
                            target[1],
                            ep[0],
                            ep[1],
                            off,
                        ))
            elif isinstance(c, AngleBetween):
                endpoints_a = _line_pids(doc, c.a)
                endpoints_b = _line_pids(doc, c.b)
                if endpoints_a and endpoints_b:
                    a1, a2 = endpoints_a
                    b1, b2 = endpoints_b
                    rows.extend(_angle_rows(
                        get(a1), get(a2), get(b1), get(b2),
                        (a1, a2), (b1, b2), c.degrees))
            elif isinstance(c, (Horizontal, Vertical)):
                endpoints = _line_pids(doc, c.target)
                if endpoints:
                    a, b = endpoints
                    comp = 1 if isinstance(c, Horizontal) else 0
                    rows.extend(_axis_rows(get(a), get(b), a, b, comp))
        base_count = len(rows)
        for kind, a, b, target in preferences:
            pa, pb = get(a), get(b)
            if kind == "rotation":
                rows.append(_orientation_row(pa, pb, a, b, target))
            else:
                rows.append(_length_row(pa, pb, a, b, target))
        m = len(rows)
        r = np.empty(m)
        weighted_r = np.empty(m)
        J = np.zeros((m, n)) if want_jac else np.empty((m, 0))
        for k, (res, derivs) in enumerate(rows):
            factor = 1.0
            if k >= base_count:
                kind = preferences[k - base_count][0]
                factor = math.sqrt(
                    10000.0 if kind == "rotation"
                    else 10000.0 if kind == "preserve_length"
                    else 0.1
                )
                if kind != "preserve_length":
                    factor *= 0.01
            r[k] = res
            weighted_r[k] = res * factor
            if want_jac:
                for pid, comp, val in derivs:
                    if pid.startswith("@"):
                        opening_id, field = pid[1:].split(":", 1)
                        i = opening_index.get(opening_id)
                        comp = 0 if field == "start" else 1
                    else:
                        i = point_index.get(pid)
                    if i is not None:
                        J[k, 2 * i + comp] += val * factor
        return r, weighted_r, J, base_count

    if n == 0:
        r, _, _, _ = evaluate(np.empty(0), False)
        max_res = float(np.max(np.abs(r))) if r.size else 0.0
        return SolveStatus(max_res < 1e-6, max_res, 0, int(r.size), 0, 0)

    x = np.empty(n)
    for p in free:
        x[2 * point_index[p.id]] = p.x
        x[2 * point_index[p.id] + 1] = p.y
    for oid, opening in doc.openings.items():
        i = opening_index[oid]
        x[2 * i] = opening.start
        x[2 * i + 1] = opening.length

    lam = 1e-3
    iterations = 0
    r, weighted_r, J, base_count = evaluate(x, True)
    cost = float(weighted_r @ weighted_r) if weighted_r.size else 0.0
    for iterations in range(1, max_iter + 1):
        if r.size == 0 or float(np.max(np.abs(weighted_r))) < 1e-9:
            break
        if _native_normal_equations is None:
            g = J.T @ weighted_r
            A = J.T @ J
        else:
            A, g = _native_normal_equations(J, weighted_r)
        improved = False
        for _ in range(12):
            if lam > 1e14:
                break
            scale = np.maximum(np.diag(A), 1e-8)
            H = A + lam * np.diag(scale)
            if _native_solve_damped is None:
                try:
                    dx = np.linalg.solve(H, -g)
                except np.linalg.LinAlgError:
                    dx = np.linalg.lstsq(H, -g, rcond=None)[0]
            else:
                try:
                    dx = _native_solve_damped(H, -g)
                except ValueError:
                    try:
                        dx = np.linalg.solve(H, -g)
                    except np.linalg.LinAlgError:
                        dx = np.linalg.lstsq(H, -g, rcond=None)[0]
            xn = x + dx
            if not np.all(np.isfinite(xn)):
                lam *= 10.0
                continue
            rn, weighted_rn, _, _ = evaluate(xn, False)
            cn = float(weighted_rn @ weighted_rn)
            if cn < cost:
                x = xn
                r, weighted_r, J, base_count = evaluate(x, True)
                cost = float(weighted_r @ weighted_r)
                lam = max(lam / 3.0, 1e-12)
                improved = True
                break
            lam *= 5.0
        if not improved:
            break

    for p in free:
        p.x = float(x[2 * point_index[p.id]])
        p.y = float(x[2 * point_index[p.id] + 1])
    for oid in doc.openings:
        i = opening_index[oid]
        doc.openings[oid].start = float(x[2 * i])
        doc.openings[oid].length = float(x[2 * i + 1])

    max_res = float(np.max(np.abs(r[:base_count]))) if base_count else 0.0
    if J.size:
        try:
            with np.errstate(invalid="ignore"):
                rank = int(np.linalg.matrix_rank(J))
        except ValueError:
            rank = 0
    else:
        rank = 0
    return SolveStatus(
        converged=max_res < 1e-6,
        max_residual=max_res,
        params=n,
        rows=int(r.size),
        dofs=max(n - rank, 0),
        iterations=iterations,
    )
