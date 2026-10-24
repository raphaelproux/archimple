import math

import pytest

from archimple.model import AngleBetween, Coincident, Distance, Document
from archimple.solver import solve_document


def make_wall(doc, start, end, t=0.2, joins=()):
    return doc.add_wall(start, end, thickness=t, joins=joins)


def test_empty_document_converges():
    st = solve_document(Document())
    assert st.converged and st.rows == 0


def test_wall_stays_rectangular_after_perturbation():
    doc = Document()
    w = make_wall(doc, (0, 0), (3, 0))
    pts = [doc.points[pid] for pid in w.corners]
    pts[1].y += 0.03
    pts[2].x += 0.05
    st = solve_document(doc)
    assert st.converged
    c0, c1, c2, c3 = ((p.x, p.y) for p in pts)
    ux, uy = c3[0] - c0[0], c3[1] - c0[1]
    vx, vy = c1[0] - c0[0], c1[1] - c0[1]
    # right angle and parallelogram restored
    assert abs(ux * vx + uy * vy) < 1e-6
    assert abs((c3[0] - c0[0]) - (c2[0] - c1[0])) < 1e-6
    assert abs((c3[1] - c0[1]) - (c2[1] - c1[1])) < 1e-6


def test_thickness_dimension_between_edges():
    doc = Document()
    w = make_wall(doc, (0, 0), (3, 0), t=0.2)
    doc.add_constraint({
        "type": "distance",
        "a": {"kind": "edge", "wall": w.id, "side": 1},
        "b": {"kind": "edge", "wall": w.id, "side": -1},
        "length": 0.5,
    })
    st = solve_document(doc)
    assert st.converged
    c0 = doc.points[w.corners[0]]
    c1 = doc.points[w.corners[1]]
    assert math.hypot(c1.x - c0.x, c1.y - c0.y) == pytest.approx(0.5, abs=1e-6)


def test_vertex_edge_dimension_sets_thickness():
    doc = Document()
    w = make_wall(doc, (0, 0), (3, 0), t=0.2)
    # drop the auto thickness dimension first - it would conflict
    auto = [c for c in doc.constraints.values() if isinstance(c, Distance)]
    doc.delete(auto[0].id)
    doc.add_constraint({
        "type": "distance",
        "a": {"kind": "vertex", "pid": w.corners[0]},
        "b": {"kind": "edge", "wall": w.id, "side": -1},
        "length": 0.4,
    })
    st = solve_document(doc)
    assert st.converged
    c0 = doc.points[w.corners[0]]
    c1 = doc.points[w.corners[1]]
    assert math.hypot(c1.x - c0.x, c1.y - c0.y) == pytest.approx(0.4, abs=1e-6)


def test_opening_length_dimension_pulls_handles_to_target_length():
    doc = Document()
    wall = make_wall(doc, (0, 0), (4, 0))
    opening = doc.add_opening(wall.id, 1, 2)
    doc.add_constraint({
        "type": "distance",
        "a": {"kind": "opening", "opening": opening.id, "handle": "start"},
        "b": {"kind": "opening", "opening": opening.id, "handle": "end"},
        "length": 1.5,
    })
    status = solve_document(doc)
    assert status.converged
    assert opening.length == pytest.approx(1.5, abs=1e-6)


def test_vertex_opening_handle_dimension_moves_handle_along_host_axis():
    doc = Document()
    host = make_wall(doc, (0, 0), (4, 0))
    target = make_wall(doc, (0.6, 0.5), (1.6, 0.5))
    opening = doc.add_opening(host.id, 0.8, 1.8)
    target_pid = target.corners[0]
    doc.add_constraint({
        "type": "distance",
        "a": {"kind": "opening", "opening": opening.id, "handle": "start"},
        "b": {"kind": "vertex", "pid": target_pid},
        "length": 0.6,
    })
    status = solve_document(doc, pinned=set(host.corners + target.corners))
    assert status.converged
    assert opening.start == pytest.approx(0.6, abs=5e-5)


def test_opening_handle_to_edge_dimension_moves_handle_along_host_axis():
    doc = Document()
    host = make_wall(doc, (0, 0), (4, 0))
    target = make_wall(doc, (2, -1), (2, 1))
    opening = doc.add_opening(host.id, 0.5, 1.5)
    doc.add_constraint({
        "type": "distance",
        "a": {"kind": "edge", "wall": target.id, "side": 1},
        "b": {"kind": "opening", "opening": opening.id, "handle": "start"},
        "length": 1.0,
    })
    status = solve_document(doc, pinned=set(host.corners + target.corners))
    assert status.converged
    assert opening.start == pytest.approx(0.9, abs=1e-5)


def test_rectangle_right_angle_constraints_remain_editable():
    doc = Document()
    rectangle = doc.add_rectangle(0, 0, 4, 3)
    angles = [c for c in doc.constraints.values() if isinstance(c, AngleBetween)]
    assert solve_document(doc).converged
    doc.delete(angles[1].id)
    angles.remove(angles[1])
    doc.update_constraint(angles[0].id, 80)
    assert angles[0].degrees == pytest.approx(80)
    assert len(angles) == 2
    doc.move_point(rectangle.corners[1], 4, 1)
    status = solve_document(doc)
    assert status.converged
    p0, p1, p3 = (doc.points[rectangle.corners[i]] for i in (0, 1, 3))
    first = (p1.x - p0.x, p1.y - p0.y)
    second = (p3.x - p0.x, p3.y - p0.y)
    angle = math.degrees(math.atan2(
        first[0] * second[1] - first[1] * second[0],
        first[0] * second[0] + first[1] * second[1],
    ))
    assert angle == pytest.approx(80, abs=1e-3)


def test_distance_between_opening_handle_and_wall_axis_end():
    doc = Document()
    wall = make_wall(doc, (0, 0), (4, 0))
    opening = doc.add_opening(wall.id, 1, 2)
    doc.add_constraint({
        "type": "distance",
        "a": {"kind": "opening", "opening": opening.id, "handle": "start"},
        "b": {"kind": "wall-end", "wall": wall.id, "end": "start"},
        "length": 1,
    })
    doc.add_constraint({
        "type": "distance",
        "a": {"kind": "opening", "opening": opening.id, "handle": "end"},
        "b": {"kind": "wall-end", "wall": wall.id, "end": "end"},
        "length": 1.5,
    })
    status = solve_document(doc, pinned=set(wall.corners))
    assert status.converged
    assert opening.length == pytest.approx(1.5, abs=1e-6)


def test_opening_length_reference_sets_opening_length():
    doc = Document()
    host = make_wall(doc, (0, 0), (4, 0))
    target = make_wall(doc, (1, 0.5), (2, 0.5))
    opening = doc.add_opening(host.id, 0.5, 1.5)
    doc.add_constraint({
        "type": "distance",
        "a": {"kind": "opening-length", "opening": opening.id},
        "b": {"kind": "vertex", "pid": target.corners[0]},
        "length": 1.5,
    })
    status = solve_document(doc, pinned=set(host.corners + target.corners))
    assert status.converged
    assert opening.length == pytest.approx(1.5, abs=1e-5)


def test_coincident_between_corners_pulls_together():
    doc = Document()
    w1 = make_wall(doc, (0, 0), (3, 0))
    w2 = make_wall(doc, (5, 0), (5, 3))
    a, b = doc.points[w1.corners[3]], doc.points[w2.corners[1]]
    doc.add_constraint({"type": "coincident", "a": a.id, "b": b.id})
    st = solve_document(doc)
    assert st.converged
    assert abs(a.x - b.x) < 1e-6 and abs(a.y - b.y) < 1e-6


def test_pinned_corner_stays():
    doc = Document()
    w = make_wall(doc, (0, 0), (3, 0))
    p = doc.points[w.corners[0]]
    doc.move_point(p.id, 0.5, 0.5)
    st = solve_document(doc, pinned={p.id})
    assert st.converged
    assert abs(p.x - 0.5) < 1e-6 and abs(p.y - 0.5) < 1e-6


def test_thickness_floor_flips_negative_wall():
    doc = Document()
    w = make_wall(doc, (0, 0), (3, 0))
    pids = w.corners
    # place corners so that c1 lies on the +n side (negative thickness)
    positions = [(0, 0.1), (0, 0.3), (3, 0.3), (3, 0.1)]
    for pid, (x, y) in zip(pids, positions):
        doc.move_point(pid, x, y)
    st = solve_document(doc)
    assert st.converged
    c0, c1 = doc.points[pids[0]], doc.points[pids[1]]
    c3 = doc.points[pids[3]]
    g = (c1.x - c0.x) * (c3.y - c0.y) - (c1.y - c0.y) * (c3.x - c0.x)
    assert g > 0  # thickness positive again


def test_angle_between_wall_axes():
    doc = Document()
    w1 = make_wall(doc, (0, 0), (3, 0))
    w2 = make_wall(doc, (5, 5), (7, 9))
    doc.add_constraint({"type": "angle", "wall_a": w1.id, "wall_b": w2.id, "degrees": 90})
    st = solve_document(doc)
    assert st.converged
    a0, a3 = doc.points[w1.corners[0]], doc.points[w1.corners[3]]
    b0, b3 = doc.points[w2.corners[0]], doc.points[w2.corners[3]]
    v1 = (a3.x - a0.x, a3.y - a0.y)
    v2 = (b3.x - b0.x, b3.y - b0.y)
    ang = math.degrees(math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]))
    assert abs(((ang - 90 + 180) % 360) - 180) < 1e-4


def test_horizontal_constrains_axis():
    doc = Document()
    w = doc.add_wall((0, 0), (3, 0.05))
    doc.add_constraint({"type": "horizontal", "wall": w.id})
    st = solve_document(doc)
    assert st.converged
    c0, c3 = doc.points[w.corners[0]], doc.points[w.corners[3]]
    assert abs(c3.y - c0.y) < 1e-6


def test_angle_closest_orientation_solves_short_way():
    doc = Document()
    w1 = make_wall(doc, (0, 0), (3, 0))
    ang = math.radians(-93)
    w2 = make_wall(doc, (5, 5), (5 + 3 * math.cos(ang), 5 + 3 * math.sin(ang)))
    c = doc.add_constraint({"type": "angle", "wall_a": w1.id, "wall_b": w2.id, "degrees": 90})[0]
    assert c.degrees == pytest.approx(-90)
    st = solve_document(doc)
    assert st.converged
    a0, a3 = doc.points[w1.corners[0]], doc.points[w1.corners[3]]
    b0, b3 = doc.points[w2.corners[0]], doc.points[w2.corners[3]]
    v1 = (a3.x - a0.x, a3.y - a0.y)
    v2 = (b3.x - b0.x, b3.y - b0.y)
    theta = math.degrees(math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]))
    assert abs(theta + 90) < 1e-3  # rotated 3°, not 183°


def test_joined_two_wall_room_solves():
    """A minimal room: four walls joined corner-to-corner via coincidents."""
    doc = Document()
    w1 = make_wall(doc, (0, 0), (4, 0))
    w2 = make_wall(doc, (4, 0), (4, 3), joins=[{"corner": 0, "pid": w1.corners[3]}])
    w3 = make_wall(doc, (4, 3), (0, 3), joins=[{"corner": 0, "pid": w2.corners[3]}])
    w4 = make_wall(doc, (0, 3), (0, 0), joins=[
        {"corner": 0, "pid": w3.corners[3]},
        {"corner": 3, "pid": w1.corners[0]},
    ])
    doc.add_constraint({"type": "distance", "a": {"kind": "vertex", "pid": w1.corners[0]},
                        "b": {"kind": "vertex", "pid": w1.corners[3]}, "length": 4})
    doc.add_constraint({"type": "distance", "a": {"kind": "vertex", "pid": w2.corners[0]},
                        "b": {"kind": "vertex", "pid": w2.corners[3]}, "length": 3})
    st = solve_document(doc)
    assert st.converged
    # the joined corners really coincide
    a, b = doc.points[w1.corners[3]], doc.points[w2.corners[0]]
    assert abs(a.x - b.x) < 1e-6 and abs(a.y - b.y) < 1e-6
