import math

import pytest

from archimple.model import AngleBetween, Coincident, Distance, Document, Horizontal, Vertical
from archimple.solver import solve_document


def test_document_round_trip_preserves_map_constraints_and_future_ids():
    doc = Document()
    wall = doc.add_wall((0, 0), (3, 0))
    rectangle = doc.add_rectangle(4, 1, 6, 3)
    symbol = doc.save_symbol(rectangle.id, "Desk")
    doc.add_rectangle(8, 1, 10, 3, symbol=symbol.id)
    serialized = doc.to_dict()

    restored = Document.from_dict(serialized)

    assert restored.to_dict() == serialized
    assert restored.add_wall((0, 4), (2, 4)).id != wall.id
    assert restored.add_rectangle(12, 1, 14, 3).id not in {item["id"] for item in serialized["rectangles"]}
    assert restored.to_dict()["symbols"] == serialized["symbols"]


def test_document_from_dict_rejects_invalid_data():
    with pytest.raises(ValueError, match="missing required"):
        Document.from_dict({})


def test_add_rectangle_creates_standard_editable_right_angle_constraints():
    doc = Document()
    rectangle = doc.add_rectangle(4, 3, 1, 0)
    assert len(rectangle.corners) == 4
    assert [
        (doc.points[pid].x, doc.points[pid].y) for pid in rectangle.corners
    ] == [(1, 0), (4, 0), (4, 3), (1, 3)]
    angles = [c for c in doc.constraints.values() if isinstance(c, AngleBetween)]
    assert len(angles) == 3
    assert all(abs(angle.degrees) == 90 for angle in angles)
    assert all(doc.to_dict()["constraints"][i]["type"] == "angle" for i in range(3))
    constraint, created = doc.add_constraint({
        "type": "angle",
        "a": angles[0].a,
        "b": angles[0].b,
        "degrees": 75,
    })
    assert not created and constraint is angles[0]
    assert constraint.degrees == 75
    assert doc.delete(constraint.id)
    assert len(doc.constraints) == 2
    assert doc.delete(rectangle.id)
    assert len(doc.points) == 0 and len(doc.constraints) == 0


def test_horizontal_and_vertical_constraints_accept_rectangle_sides():
    doc = Document()
    rectangle = doc.add_rectangle(0, 0, 3, 2)
    horizontal, created = doc.add_constraint({
        "type": "horizontal",
        "target": {"kind": "segment", "start": rectangle.corners[0], "end": rectangle.corners[1]},
    })
    assert created and isinstance(horizontal, Horizontal)
    vertical, created = doc.add_constraint({
        "type": "vertical",
        "target": {"kind": "segment", "start": rectangle.corners[1], "end": rectangle.corners[2]},
    })
    assert created and isinstance(vertical, Vertical)
    for pid in rectangle.corners:
        point = doc.points[pid]
        x, y = point.x, point.y
        point.x = x * math.cos(0.2) - y * math.sin(0.2)
        point.y = x * math.sin(0.2) + y * math.cos(0.2)
    assert solve_document(doc).converged
    p0, p1, p2 = (doc.points[pid] for pid in rectangle.corners[:3])
    assert p0.y == pytest.approx(p1.y, abs=1e-6)
    assert p1.x == pytest.approx(p2.x, abs=1e-6)


def test_symbol_instances_share_template_constraints_but_keep_independent_positions():
    doc = Document()
    rectangle = doc.add_rectangle(0, 0, 2, 1)
    symbol = doc.save_symbol(rectangle.id, "Desk")
    instance = doc.add_rectangle(5, 5, 7, 6, symbol=symbol.id)
    assert symbol.label == "Desk"
    assert (symbol.width, symbol.height) == pytest.approx((2, 1))
    assert len(symbol.constraints) == 3
    assert len(doc.constraints) == 0
    serialized_symbol = doc.to_dict()["symbols"][0]
    assert len(serialized_symbol["constraints"]) == 3
    assert all("start_corner" in constraint["a"] for constraint in serialized_symbol["constraints"])

    angle = next(iter(symbol.constraints.values()))
    expanded = doc.expanded_constraints()
    assert sum(c.id == angle.id for c in expanded) == 2
    assert solve_document(doc).converged

    first_before_resize = [doc.points[pid] for pid in rectangle.corners]
    first_center_before_resize = (
        (first_before_resize[0].x + first_before_resize[2].x) / 2,
        (first_before_resize[0].y + first_before_resize[2].y) / 2,
    )
    doc.update_rectangle(instance.id, 5, 5, 8, 8)
    assert (symbol.width, symbol.height) == pytest.approx((3, 3))
    first = [doc.points[pid] for pid in rectangle.corners]
    second = [doc.points[pid] for pid in instance.corners]
    assert (first[1].x - first[0].x, first[3].y - first[0].y) == pytest.approx((3, 3))
    assert (second[1].x - second[0].x, second[3].y - second[0].y) == pytest.approx((3, 3))
    assert ((first[0].x + first[2].x) / 2, (first[0].y + first[2].y) / 2) == pytest.approx(first_center_before_resize)
    assert ((second[0].x + second[2].x) / 2, (second[0].y + second[2].y) / 2) == pytest.approx((6.5, 6.5))
    first_center_before_move = (
        (first[0].x + first[2].x) / 2,
        (first[0].y + first[2].y) / 2,
    )
    doc.update_rectangle(instance.id, 6, 7, 9, 10)
    first = [doc.points[pid] for pid in rectangle.corners]
    second = [doc.points[pid] for pid in instance.corners]
    assert ((first[0].x + first[2].x) / 2, (first[0].y + first[2].y) / 2) == pytest.approx(first_center_before_move)
    assert ((second[0].x + second[2].x) / 2, (second[0].y + second[2].y) / 2) == pytest.approx((7.5, 8.5))
    assert (first[1].x - first[0].x, first[3].y - first[0].y) == pytest.approx((3, 3))
    assert len(doc.symbols) == 1


def test_shared_constraint_delete_removes_template_for_every_instance():
    doc = Document()
    rectangle = doc.add_rectangle(0, 0, 2, 1)
    symbol = doc.save_symbol(rectangle.id, "Desk")
    doc.add_rectangle(5, 5, 7, 6, symbol=symbol.id)
    shared_id = next(iter(symbol.constraints))
    assert sum(c.id == shared_id for c in doc.expanded_constraints()) == 2
    assert doc.delete(shared_id)
    assert shared_id not in symbol.constraints
    assert not any(c.id == shared_id for c in doc.expanded_constraints())


def test_remove_symbol_keeps_instances_and_materializes_constraints():
    doc = Document()
    first = doc.add_rectangle(0, 0, 2, 1)
    symbol = doc.save_symbol(first.id, "Desk")
    second = doc.add_rectangle(5, 5, 7, 6, symbol=symbol.id)
    first_point_ids = set(first.corners)
    second_point_ids = set(second.corners)
    assert len(symbol.constraints) == 3

    assert doc.remove_symbol(symbol.id)

    assert symbol.id not in doc.symbols
    assert doc.rectangles[first.id] is first
    assert doc.rectangles[second.id] is second
    assert first.symbol is None and second.symbol is None
    assert first_point_ids | second_point_ids <= set(doc.points)
    assert len(doc.constraints) == 6
    assert len(doc.expanded_constraints()) == 6
    assert doc.to_dict()["symbols"] == []
    assert not doc.remove_symbol(symbol.id)


def test_constraints_added_to_symbol_instance_are_promoted_and_shared():
    doc = Document()
    original = doc.add_rectangle(0, 0, 2, 1)
    symbol = doc.save_symbol(original.id, "Desk")
    instance = doc.add_rectangle(5, 5, 7, 6, symbol=symbol.id)
    a = instance.corners[1]
    constraint, created = doc.add_constraint({
        "type": "angle",
        "a": {"kind": "segment", "start": a, "end": instance.corners[0]},
        "b": {"kind": "segment", "start": a, "end": instance.corners[2]},
        "degrees": 80,
    })
    assert created
    assert constraint.id not in doc.constraints
    assert constraint.id in symbol.constraints
    expanded = [c for c in doc.expanded_constraints() if c.id == constraint.id]
    assert len(expanded) == 2
    assert all(c.degrees == pytest.approx(80) for c in expanded)


def test_symbol_corner_updates_propagate_live_from_each_instance_without_jumping():
    doc = Document()
    source = doc.add_rectangle(0, 0, 2, 1)
    symbol = doc.save_symbol(source.id, "Desk")
    secondary = doc.add_rectangle(5, 5, 7, 6, symbol=symbol.id)

    source_updates = [
        [(0, 0), (2.2, 0), (2.2, 1.2), (0, 1.2)],
        [(0, 0), (2.4, 0), (2.4, 1.4), (0, 1.4)],
    ]
    for corners in source_updates:
        doc.update_rectangle_corners(source.id, corners)
        shared_size = pytest.approx((corners[1][0] - corners[0][0], corners[3][1] - corners[0][1]))
        sibling = [doc.points[pid] for pid in secondary.corners]
        assert (math.hypot(sibling[1].x - sibling[0].x, sibling[1].y - sibling[0].y),
                math.hypot(sibling[3].x - sibling[0].x, sibling[3].y - sibling[0].y)) == shared_size
        assert ((sibling[0].x + sibling[2].x) / 2, (sibling[0].y + sibling[2].y) / 2) == pytest.approx((6, 5.5))
    assert doc.points[source.corners[0]].x == pytest.approx(0)
    assert doc.points[source.corners[0]].y == pytest.approx(0)

    secondary_updates = [
        [(5, 5), (7.4, 5), (7.4, 6.4), (5, 6.4)],
        [(5, 5), (2.6 + 5, 5), (2.6 + 5, 1.6 + 5), (5, 1.6 + 5)],
    ]
    for corners in secondary_updates:
        doc.update_rectangle_corners(secondary.id, corners)
        shared_size = pytest.approx((corners[1][0] - corners[0][0], corners[3][1] - corners[0][1]))
        original = [doc.points[pid] for pid in source.corners]
        assert (math.hypot(original[1].x - original[0].x, original[1].y - original[0].y),
                math.hypot(original[3].x - original[0].x, original[3].y - original[0].y)) == shared_size
        assert ((original[0].x + original[2].x) / 2, (original[0].y + original[2].y) / 2) == pytest.approx((1.2, 0.7))
    assert symbol.width == pytest.approx(2.6)
    assert symbol.height == pytest.approx(1.6)


def test_symbol_corner_updates_preserve_rotation_and_resize_siblings_immediately():
    doc = Document()
    source = doc.add_rectangle(0, 0, 2, 1)
    symbol = doc.save_symbol(source.id, "Desk")
    sibling = doc.add_rectangle(5, 5, 7, 6, symbol=symbol.id)

    angle = math.radians(30)
    for rectangle, center in ((source, (1, 0.5)), (sibling, (6, 5.5))):
        for pid in rectangle.corners:
            point = doc.points[pid]
            x, y = point.x - center[0], point.y - center[1]
            point.x = center[0] + x * math.cos(angle) - y * math.sin(angle)
            point.y = center[1] + x * math.sin(angle) + y * math.cos(angle)

    before_center = (
        (doc.points[sibling.corners[0]].x + doc.points[sibling.corners[2]].x) / 2,
        (doc.points[sibling.corners[0]].y + doc.points[sibling.corners[2]].y) / 2,
    )
    rotated = [doc.points[pid] for pid in source.corners]
    center = ((rotated[0].x + rotated[2].x) / 2, (rotated[0].y + rotated[2].y) / 2)
    u = (rotated[1].x - rotated[0].x, rotated[1].y - rotated[0].y)
    v = (rotated[3].x - rotated[0].x, rotated[3].y - rotated[0].y)
    new_width, new_height = 3, 2
    new_origin = (
        center[0] - (u[0] / 2 + v[0]) * 1.5,
        center[1] - (u[1] / 2 + v[1]) * 1.5,
    )
    doc.update_rectangle_corners(source.id, [
        new_origin,
        (new_origin[0] + u[0] / 2 * 3, new_origin[1] + u[1] / 2 * 3),
        (new_origin[0] + u[0] / 2 * 3 + v[0] * 2, new_origin[1] + u[1] / 2 * 3 + v[1] * 2),
        (new_origin[0] + v[0] * 2, new_origin[1] + v[1] * 2),
    ])

    resized = [doc.points[pid] for pid in sibling.corners]
    width = math.hypot(resized[1].x - resized[0].x, resized[1].y - resized[0].y)
    height = math.hypot(resized[3].x - resized[0].x, resized[3].y - resized[0].y)
    center_after = ((resized[0].x + resized[2].x) / 2, (resized[0].y + resized[2].y) / 2)
    assert (width, height) == pytest.approx((new_width, new_height))
    assert center_after == pytest.approx(before_center)
    assert math.degrees(math.atan2(resized[1].y - resized[0].y, resized[1].x - resized[0].x)) == pytest.approx(30)
    assert (symbol.width, symbol.height) == pytest.approx((new_width, new_height))


def test_detaching_symbol_instance_preserves_its_constraints_independently():
    doc = Document()
    first = doc.add_rectangle(0, 0, 2, 1)
    symbol = doc.save_symbol(first.id, "Desk")
    second = doc.add_rectangle(5, 5, 7, 6, symbol=symbol.id)
    doc.detach_rectangle(second.id)
    assert second.symbol is None
    assert len(symbol.constraints) == 3
    assert len(doc.constraints) == 3
    assert all(
        isinstance(constraint, AngleBetween)
        and constraint.a["kind"] == constraint.b["kind"] == "segment"
        and constraint.a["start"] in second.corners
        and constraint.b["start"] in second.corners
        for constraint in doc.constraints.values()
    )
    shared_angle = next(constraint for constraint in symbol.constraints.values() if isinstance(constraint, AngleBetween))
    detached_angle = next(
        constraint for constraint in doc.constraints.values()
        if isinstance(constraint, AngleBetween)
    )
    doc.update_constraint(detached_angle.id, 80)
    assert shared_angle.degrees == pytest.approx(90)
    assert detached_angle.degrees == pytest.approx(80)
    assert solve_document(doc).converged


def test_rectangular_room_joins_each_external_corner_to_next_internal_corner():
    doc = Document()
    walls = doc.add_wall_path(
        [(0, 0), (4, 0), (4, 3), (0, 3)], closed=True
    )
    joins = [c for c in doc.constraints.values() if isinstance(c, Coincident)]
    assert len(walls) == 4
    assert len(joins) == 4
    assert solve_document(doc).converged


def test_wall_path_supports_clockwise_and_counterclockwise_polygons():
    for points in (
        [(0, 0), (3, 0), (3, 2), (0, 2)],
        [(0, 0), (0, 2), (3, 2), (3, 0)],
    ):
        doc = Document()
        walls = doc.add_wall_path(points, closed=True)
        assert len(walls) == 4
        angles = [c for c in doc.constraints.values() if isinstance(c, AngleBetween)]
        assert len(angles) == 3
        assert all(angle.preserve_orientation for angle in angles)
        assert solve_document(doc).converged


def test_wall_path_builds_open_and_closed_polygons_and_rejects_zero_edges():
    doc = Document()
    open_walls = doc.add_wall_path([(0, 0), (2, 0), (2, 2)])
    assert len(open_walls) == 2
    open_angles = [
        c for c in doc.constraints.values() if isinstance(c, AngleBetween)
    ]
    assert len(open_angles) == 1
    assert open_angles[0].preserve_orientation
    serialized_open_angle = next(
        c for c in doc.to_dict()["constraints"] if c["type"] == "angle"
    )
    assert serialized_open_angle["preserve_orientation"]
    restored = Document.from_dict(doc.to_dict())
    restored_open_angle = next(
        c for c in restored.constraints.values() if isinstance(c, AngleBetween)
    )
    assert restored_open_angle.preserve_orientation
    closed_walls = doc.add_wall_path([(4, 0), (6, 0), (6, 2), (4, 2)], closed=True)
    assert len(closed_walls) == 4
    closed_angles = [
        c for c in doc.constraints.values() if isinstance(c, AngleBetween)
    ]
    assert len(closed_angles) == 4
    with pytest.raises(ValueError):
        doc.add_wall_path([(0, 0), (1, 0), (1, 0)])


def test_cut_wall_removes_axis_length_dimension_and_leaves_gap():
    doc = Document()
    wall = doc.add_wall((0, 0), (4, 0))
    opening = doc.add_opening(wall.id, 2.5, 3.5)
    length_dimension, _ = doc.add_constraint({
        "type": "distance",
        "a": {"kind": "wall-end", "wall": wall.id, "end": "start"},
        "b": {"kind": "wall-end", "wall": wall.id, "end": "end"},
        "length": 4,
    })

    first, second = doc.cut_wall(wall.id, 2)

    assert first.id == wall.id
    assert opening.wall == second.id and opening.start == pytest.approx(0.45)
    assert doc._wall_length(first.id) == pytest.approx(1.95)
    assert doc._wall_length(second.id) == pytest.approx(1.95)
    first_axis = doc._axis_endpoints(first)
    second_axis = doc._axis_endpoints(second)
    assert math.dist(first_axis[2:], second_axis[:2]) == pytest.approx(0.1)
    assert length_dimension.id not in doc.constraints
    thicknesses = [
        c for c in doc.constraints.values()
        if isinstance(c, Distance)
        and c.a.get("kind") == "edge"
        and c.b.get("kind") == "edge"
        and {c.a["wall"], c.b["wall"]} <= {first.id, second.id}
    ]
    assert len(thicknesses) == 2
    assert {c.a["wall"] for c in thicknesses} == {first.id, second.id}
    assert all(c.a["wall"] == c.b["wall"] for c in thicknesses)
    assert all(c.length == pytest.approx(0.2) for c in thicknesses)
    assert not any(
        isinstance(c, Distance)
        and c.a.get("kind") == c.b.get("kind") == "edge"
        and c.a["wall"] != c.b["wall"]
        and {c.a["wall"], c.b["wall"]} == {first.id, second.id}
        for c in doc.constraints.values()
    )
    assert not any(isinstance(c, AngleBetween) for c in doc.constraints.values())
    assert solve_document(doc).converged


def test_cut_wall_splits_opening_around_gap():
    doc = Document()
    wall = doc.add_wall((0, 0), (4, 0))
    opening = doc.add_opening(wall.id, 1.5, 2.5)

    first, second = doc.cut_wall(wall.id, 2)

    assert len(doc.openings) == 2
    assert opening.wall == first.id
    assert opening.start == pytest.approx(1.5)
    assert opening.length == pytest.approx(0.45)
    other = next(item for item in doc.openings.values() if item.id != opening.id)
    assert other.wall == second.id
    assert other.start == pytest.approx(0)
    assert other.length == pytest.approx(0.45)
    assert solve_document(doc).converged


def test_add_wall_creates_four_corners():
    doc = Document()
    w = doc.add_wall((0, 0), (3, 0))
    assert len(w.corners) == 4
    assert len(doc.points) == 4
    p0, p1 = (doc.points[pid] for pid in w.corners[:2])
    assert (p0.x, p0.y) == pytest.approx((0, 0.1))
    assert (p1.x, p1.y) == pytest.approx((0, -0.1))


def test_add_wall_joins_create_coincident():
    doc = Document()
    w1 = doc.add_wall((0, 0), (3, 0))
    target = w1.corners[3]
    w2 = doc.add_wall((3, 0), (3, 2), joins=[{"corner": 0, "pid": target}])
    coinc = [c for c in doc.constraints.values() if isinstance(c, Coincident)]
    assert len(coinc) == 1
    assert {coinc[0].a, coinc[0].b} == {w2.corners[0], target}
    # plus the auto thickness dimensions of both walls
    assert len(doc.constraints) == 3
    assert len(doc.points) == 8


def test_delete_wall_prunes_points_and_constraints():
    doc = Document()
    w1 = doc.add_wall((0, 0), (3, 0))
    w2 = doc.add_wall((3, 0), (3, 2), joins=[{"corner": 0, "pid": w1.corners[3]}])
    assert doc.delete(w2.id)
    # only w1's auto thickness dimension survives
    assert len(doc.constraints) == 1
    assert len(doc.points) == 4  # w1's corners survive
    assert doc.delete(w1.id)
    assert len(doc.points) == 0 and len(doc.walls) == 0 and len(doc.constraints) == 0


def test_opening_is_hosted_by_wall_and_deleted_with_it():
    doc = Document()
    wall = doc.add_wall((0, 0), (4, 0))
    opening = doc.add_opening(wall.id, 1, 2.5)
    assert (opening.start, opening.length) == pytest.approx((1, 1.5))
    data = doc.to_dict()
    assert data["openings"] == [{
        "id": opening.id,
        "name": opening.name,
        "wall": wall.id,
        "start": 1,
        "length": 1.5,
    }]
    assert doc.delete(opening.id)
    assert not doc.openings
    opening = doc.add_opening(wall.id, 1, 2.5)
    doc.add_constraint({
        "type": "distance",
        "a": {"kind": "opening", "opening": opening.id, "handle": "start"},
        "b": {"kind": "vertex", "pid": wall.corners[0]},
        "length": 1,
    })
    assert doc.delete(wall.id)
    assert opening.id not in doc.openings
    assert len(doc.constraints) == 0


def test_opening_rejects_invalid_wall_or_endpoints():
    doc = Document()
    wall = doc.add_wall((0, 0), (3, 0))
    with pytest.raises(ValueError):
        doc.add_opening("missing", 0, 1)
    for start, end in [(-0.1, 1), (1, 1), (2, 1), (0, 3.1)]:
        with pytest.raises(ValueError):
            doc.add_opening(wall.id, start, end)
    opening = doc.add_opening(wall.id, 0.5, 1.5)
    with pytest.raises(ValueError):
        doc.update_opening(opening.id, 0, 4)


def test_distance_constraint_can_reference_opening_handles():
    doc = Document()
    wall = doc.add_wall((0, 0), (4, 0))
    opening = doc.add_opening(wall.id, 1, 2)
    start = {"kind": "opening", "opening": opening.id, "handle": "start"}
    end = {"kind": "opening", "opening": opening.id, "handle": "end"}
    c, created = doc.add_constraint({
        "type": "distance", "a": start, "b": end, "length": opening.length,
    })
    assert created and isinstance(c, Distance) and c.offset is None
    assert {c.a["handle"], c.b["handle"]} == {"start", "end"}
    duplicate, created = doc.add_constraint({
        "type": "distance", "a": end, "b": start, "length": 1.5,
    })
    assert not created and duplicate is c and c.length == 1.5
    assert doc.delete(opening.id)
    assert c.id not in doc.constraints


def test_editing_opening_length_dimension_updates_opening_length():
    doc = Document()
    wall = doc.add_wall((0, 0), (4, 0))
    opening = doc.add_opening(wall.id, 1, 2)
    start = {"kind": "opening", "opening": opening.id, "handle": "start"}
    end = {"kind": "opening", "opening": opening.id, "handle": "end"}
    constraint, _ = doc.add_constraint({
        "type": "distance", "a": start, "b": end, "length": 1,
    })
    doc.update_constraint(constraint.id, 1.5)
    assert opening.start == pytest.approx(1)
    assert opening.length == pytest.approx(1.5)
    length_ref = {"kind": "opening-length", "opening": opening.id}
    constraint2, _ = doc.add_constraint({
        "type": "distance",
        "a": length_ref,
        "b": {"kind": "vertex", "pid": wall.corners[0]},
        "length": 1.5,
    })
    doc.update_constraint(constraint2.id, 2)
    assert opening.length == pytest.approx(2)


def test_distance_constraint_accepts_wall_end_target():
    doc = Document()
    wall = doc.add_wall((0, 0), (4, 0))
    opening = doc.add_opening(wall.id, 1, 2)
    wall_end = {"kind": "wall-end", "wall": wall.id, "end": "end"}
    opening_end = {"kind": "opening", "opening": opening.id, "handle": "end"}
    constraint, created = doc.add_constraint({
        "type": "distance", "a": opening_end, "b": wall_end, "length": 2,
    })
    assert created and isinstance(constraint, Distance)
    assert constraint.offset is None
    assert {constraint.a["kind"], constraint.b["kind"]} == {"opening", "wall-end"}
    assert doc.to_dict()["constraints"][-1]["a"]["kind"] in {"opening", "wall-end"}
    assert doc.delete(wall.id)
    assert constraint.id not in doc.constraints


def test_distance_constraint_accepts_opening_handle_and_wall_edge():
    doc = Document()
    wall = doc.add_wall((0, 0), (4, 0))
    opening = doc.add_opening(wall.id, 1, 2)
    ref = {"kind": "opening", "opening": opening.id, "handle": "start"}
    c, created = doc.add_constraint({
        "type": "distance",
        "a": {"kind": "edge", "wall": wall.id, "side": 1},
        "b": ref,
        "length": 0.1,
    })
    assert created and c.a["kind"] == "edge" and c.b == ref
    assert c.offset == pytest.approx(-0.1)


def test_opening_handle_constraint_reference_validation():
    doc = Document()
    with pytest.raises(ValueError):
        doc.add_constraint({
            "type": "distance",
            "a": {"kind": "opening", "opening": "missing", "handle": "start"},
            "b": {"kind": "vertex", "pid": "missing"},
            "length": 1,
        })
    wall = doc.add_wall((0, 0), (3, 0))
    opening = doc.add_opening(wall.id, 0.5, 1.5)
    with pytest.raises(ValueError):
        doc.add_constraint({
            "type": "distance",
            "a": {"kind": "opening", "opening": opening.id, "handle": "middle"},
            "b": {"kind": "vertex", "pid": wall.corners[0]},
            "length": 1,
        })


def test_distance_vertex_vertex_dedupe():
    doc = Document()
    w = doc.add_wall((0, 0), (3, 0))
    a = {"kind": "vertex", "pid": w.corners[0]}
    b = {"kind": "vertex", "pid": w.corners[3]}
    c1, created1 = doc.add_constraint({"type": "distance", "a": a, "b": b, "length": 5})
    c2, created2 = doc.add_constraint({"type": "distance", "a": b, "b": a, "length": 7})
    assert created1 and not created2
    assert c1 is c2 and c1.length == 7 and c1.offset is None


def test_auto_thickness_dimension_sign():
    """The auto-created dimension measures signed distance from edge+ to
    the far face, so its offset is -t for a normally oriented wall."""
    doc = Document()
    w = doc.add_wall((0, 0), (3, 0))  # thickness 0.2, n̂ = (0,1)
    c = next(iter(doc.constraints.values()))
    assert isinstance(c, Distance)
    assert c.length == 0.2
    assert c.offset == pytest.approx(-0.2)
    assert c.a["side"] == 1 and c.b["side"] == -1


def test_distance_vertex_edge_offset():
    doc = Document()
    w = doc.add_wall((0, 0), (3, 0))
    c, _ = doc.add_constraint({
        "type": "distance",
        "a": {"kind": "vertex", "pid": w.corners[0]},
        "b": {"kind": "edge", "wall": w.id, "side": -1},
        "length": 0.4,
    })
    # normalized to (edge-, vertex c0); D = (c0 - c1)·n̂ = +0.2 -> offset +0.4
    assert c.a["kind"] == "edge"
    assert c.offset == pytest.approx(0.4)


def test_distance_edge_edge_dedupe_keeps_sign():
    doc = Document()
    w = doc.add_wall((0, 0), (3, 0))
    e1 = {"kind": "edge", "wall": w.id, "side": 1}
    e2 = {"kind": "edge", "wall": w.id, "side": -1}
    # the first add lands on the auto-created thickness dimension
    c1, created1 = doc.add_constraint({"type": "distance", "a": e1, "b": e2, "length": 0.3})
    c2, created2 = doc.add_constraint({"type": "distance", "a": e2, "b": e1, "length": 0.5})
    assert not created1 and not created2
    assert c1 is c2
    assert c1.length == 0.5 and c1.offset == pytest.approx(-0.5)
    assert len(doc.constraints) == 1


def test_invalid_refs_rejected():
    doc = Document()
    w = doc.add_wall((0, 0), (3, 0))
    with pytest.raises(ValueError):
        doc.add_constraint({"type": "distance", "a": {"kind": "vertex", "pid": "nope"},
                            "b": {"kind": "vertex", "pid": w.corners[0]}, "length": 1})
    with pytest.raises(ValueError):
        doc.add_constraint({"type": "distance", "a": {"kind": "edge", "wall": "nope", "side": 1},
                            "b": {"kind": "vertex", "pid": w.corners[0]}, "length": 1})
    with pytest.raises(ValueError):
        doc.add_constraint({"type": "distance", "a": {"kind": "edge", "wall": w.id, "side": 2},
                            "b": {"kind": "vertex", "pid": w.corners[0]}, "length": 1})
    with pytest.raises(ValueError):
        doc.add_constraint({
            "type": "distance",
            "a": {"kind": "edge", "wall": w.id, "side": 1},
            "b": {"kind": "edge", "wall": w.id, "side": 1},
            "length": 1,
        })
    with pytest.raises(ValueError):
        doc.add_constraint({"type": "distance", "a": {"kind": "vertex", "pid": w.corners[0]},
                            "b": {"kind": "vertex", "pid": w.corners[0]}, "length": 1})


def test_non_parallel_edges_rejected():
    doc = Document()
    w1 = doc.add_wall((0, 0), (3, 0))
    w2 = doc.add_wall((1, 0), (1, 3))
    with pytest.raises(ValueError):
        doc.add_constraint({
            "type": "distance",
            "a": {"kind": "edge", "wall": w1.id, "side": 1},
            "b": {"kind": "edge", "wall": w2.id, "side": 1},
            "length": 1,
        })


def test_angle_normalizes_and_dedupes():
    doc = Document()
    w1 = doc.add_wall((0, 0), (3, 0))
    w2 = doc.add_wall((0, 0), (0, 3))
    c1, _ = doc.add_constraint({"type": "angle", "wall_a": w1.id, "wall_b": w2.id, "degrees": 90})
    c2, created = doc.add_constraint({"type": "angle", "wall_a": w2.id, "wall_b": w1.id, "degrees": 450})
    assert not created
    assert c2 is c1 and c1.degrees == 90


def test_angle_closest_orientation():
    """Angles are entered as positive values; the stored target picks the
    orientation nearest the current wall arrangement."""
    doc = Document()
    w1 = doc.add_wall((0, 0), (3, 0))  # axis +x
    ang = math.radians(-93)
    w2 = doc.add_wall((5, 5), (5 + 3 * math.cos(ang), 5 + 3 * math.sin(ang)))
    c, _ = doc.add_constraint({"type": "angle", "wall_a": w1.id, "wall_b": w2.id, "degrees": 90})
    assert c.degrees == pytest.approx(-90)
    # re-adding updates the magnitude but keeps the chosen orientation
    c2, created = doc.add_constraint({"type": "angle", "wall_a": w2.id, "wall_b": w1.id, "degrees": 120})
    assert not created and c2 is c
    assert c.degrees == pytest.approx(-120)
    # positive-current walls get a positive target
    doc2 = Document()
    a = doc2.add_wall((0, 0), (3, 0))
    b = doc2.add_wall((0, 0), (0, 3))
    c3, _ = doc2.add_constraint({"type": "angle", "wall_a": a.id, "wall_b": b.id, "degrees": 270})
    assert c3.degrees == pytest.approx(90)
    c4, _ = doc2.add_constraint({"type": "angle", "wall_a": b.id, "wall_b": a.id, "degrees": -90})
    assert c4.degrees == pytest.approx(90)  # dedupe keeps the existing (+) orientation


def test_add_wall_creates_thickness_dimension():
    doc = Document()
    w = doc.add_wall((0, 0), (3, 0), thickness=0.25)
    dists = [c for c in doc.constraints.values() if isinstance(c, Distance)]
    assert len(dists) == 1
    assert dists[0].length == 0.25
    assert dists[0].offset == pytest.approx(-0.25)
    e1, e2 = dists[0].a, dists[0].b
    assert e1["kind"] == "edge" and e1["wall"] == w.id


def test_to_dict_shape():
    doc = Document()
    w = doc.add_wall((0, 0), (3, 0))
    doc.add_constraint({
        "type": "distance",
        "a": {"kind": "edge", "wall": w.id, "side": 1},
        "b": {"kind": "edge", "wall": w.id, "side": -1},
        "length": 0.25,
    })
    d = doc.to_dict()
    assert set(d) == {"points", "walls", "openings", "rectangles", "symbols", "constraints"}
    assert len(d["walls"]) == 1 and len(d["walls"][0]["corners"]) == 4
    cdict = d["constraints"][0]
    assert cdict["type"] == "distance" and cdict["offset"] == pytest.approx(-0.25)
    assert d["points"][w.corners[0]]["id"] == w.corners[0]
