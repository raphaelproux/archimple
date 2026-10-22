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


def _coincident_rows(pa, pb, a: str, b: str) -> list[Row]:
    (ax, ay), (bx, by) = pa, pb
    return [
        (ax - bx, [(a, 0, 1.0), (b, 0, -1.0)]),
        (ay - by, [(a, 1, 1.0), (b, 1, -1.0)]),
    ]


def _distance_rows(pa, pb, a: str, b: str, length: float) -> list[Row]:
    (ax, ay), (bx, by) = pa, pb
    dx, dy = bx - ax, by - ay
    d = math.hypot(dx, dy)
    if d < 1e-9:
        ux, uy = 1.0, 0.0
    else:
        ux, uy = dx / d, dy / d
    return [(d - length, [(a, 0, -ux), (a, 1, -uy), (b, 0, ux), (b, 1, uy)])]


def _point_edge_rows(
    pp, P, Q, p_pid: str, P_pid: str, Q_pid: str, offset: float
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
            (p_pid, 0, nx), (p_pid, 1, ny),
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


def _edge_pids(doc: Document, ref: dict) -> tuple[str, str] | None:
    w = doc.walls.get(ref["wall"])
    if w is None or len(w.corners) != 4:
        return None
    i = 0 if ref["side"] > 0 else 1
    return w.corners[i], w.corners[3 if ref["side"] > 0 else 2]


def solve_document(
    doc: Document,
    pinned: tuple[str, ...] | set[str] = (),
    *,
    max_iter: int = 80,
) -> SolveStatus:
    pinned = set(pinned)
    free = [p for p in doc.points.values() if p.id not in pinned]
    index = {p.id: i for i, p in enumerate(free)}
    n = 2 * len(free)

    def pt(coords: np.ndarray):
        def get(pid: str) -> tuple[float, float]:
            i = index.get(pid)
            if i is None:
                p = doc.points[pid]
                return p.x, p.y
            return float(coords[2 * i]), float(coords[2 * i + 1])

        return get

    def evaluate(coords: np.ndarray, want_jac: bool) -> tuple[np.ndarray, np.ndarray]:
        get = pt(coords)
        rows: list[Row] = []
        # hidden per-wall constraints
        for w in doc.walls.values():
            if all(pid in doc.points for pid in w.corners):
                rows.extend(_wall_hidden_rows(w, get))
        # user constraints
        for c in doc.constraints.values():
            if isinstance(c, Coincident):
                if c.a in doc.points and c.b in doc.points:
                    rows.extend(_coincident_rows(get(c.a), get(c.b), c.a, c.b))
            elif isinstance(c, Distance):
                ra, rb = c.a, c.b
                if ra["kind"] == "vertex" and rb["kind"] == "vertex":
                    if ra["pid"] in doc.points and rb["pid"] in doc.points:
                        rows.extend(_distance_rows(
                            get(ra["pid"]), get(rb["pid"]), ra["pid"], rb["pid"], c.length))
                elif ra["kind"] == "edge":
                    ep = _edge_pids(doc, ra)
                    if ep is None:
                        continue
                    p_pid = rb["pid"] if rb["kind"] == "vertex" else None
                    if p_pid is None and rb["kind"] == "edge":
                        ep2 = _edge_pids(doc, rb)
                        if ep2 is None:
                            continue
                        p_pid = ep2[0]
                    if p_pid is not None and ep[0] in doc.points and ep[1] in doc.points:
                        off = c.offset if c.offset is not None else 0.0
                        rows.extend(_point_edge_rows(
                            get(p_pid), get(ep[0]), get(ep[1]),
                            p_pid, ep[0], ep[1], off))
            elif isinstance(c, AngleBetween):
                wa = doc.walls.get(c.wall_a)
                wb = doc.walls.get(c.wall_b)
                if wa and wb and all(
                    pid in doc.points for pid in wa.corners + wb.corners
                ):
                    rows.extend(_angle_rows(
                        get(wa.corners[0]), get(wa.corners[3]),
                        get(wb.corners[0]), get(wb.corners[3]),
                        (wa.corners[0], wa.corners[3]),
                        (wb.corners[0], wb.corners[3]),
                        c.degrees))
            elif isinstance(c, (Horizontal, Vertical)):
                w = doc.walls.get(c.wall)
                if w and all(pid in doc.points for pid in (w.corners[0], w.corners[3])):
                    comp = 1 if isinstance(c, Horizontal) else 0
                    rows.extend(_axis_rows(
                        get(w.corners[0]), get(w.corners[3]), w.corners[0], w.corners[3], comp))
        m = len(rows)
        r = np.empty(m)
        J = np.zeros((m, n)) if want_jac else np.empty((m, 0))
        for k, (res, derivs) in enumerate(rows):
            r[k] = res
            if want_jac:
                for pid, comp, val in derivs:
                    i = index.get(pid)
                    if i is not None:
                        J[k, 2 * i + comp] += val
        return r, J

    if n == 0:
        r, _ = evaluate(np.empty(0), False)
        max_res = float(np.max(np.abs(r))) if r.size else 0.0
        return SolveStatus(max_res < 1e-6, max_res, 0, int(r.size), 0, 0)

    x = np.empty(n)
    for p in free:
        x[2 * index[p.id]] = p.x
        x[2 * index[p.id] + 1] = p.y

    lam = 1e-3
    iterations = 0
    r, J = evaluate(x, True)
    cost = float(r @ r) if r.size else 0.0
    for iterations in range(1, max_iter + 1):
        if r.size == 0 or float(np.max(np.abs(r))) < 1e-9:
            break
        g = J.T @ r
        A = J.T @ J
        improved = False
        for _ in range(12):
            if lam > 1e14:
                break
            scale = np.maximum(np.diag(A), 1e-8)
            H = A + lam * np.diag(scale)
            try:
                dx = np.linalg.solve(H, -g)
            except np.linalg.LinAlgError:
                dx = np.linalg.lstsq(H, -g, rcond=None)[0]
            xn = x + dx
            if not np.all(np.isfinite(xn)):
                lam *= 10.0
                continue
            rn, _ = evaluate(xn, False)
            cn = float(rn @ rn)
            if cn < cost:
                x = xn
                r, J = evaluate(x, True)
                cost = float(r @ r)
                lam = max(lam / 3.0, 1e-12)
                improved = True
                break
            lam *= 5.0
        if not improved:
            break

    for p in free:
        p.x = float(x[2 * index[p.id]])
        p.y = float(x[2 * index[p.id] + 1])

    max_res = float(np.max(np.abs(r))) if r.size else 0.0
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
