import math

import pytest

from archimple.store import Hub, SessionRegistry


def test_session_registry_creates_isolated_sessions_and_joins_by_code():
    registry = SessionRegistry()
    first_code, first = registry.get_or_create()
    second_code, second = registry.get_or_create()

    assert len(first_code) == len(second_code) == 10
    assert first_code != second_code
    assert first is not second
    assert registry.get_or_create(first_code.lower()) == (first_code, first)
    assert registry.get_or_create(second_code)[1] is second
    first.apply_op({"op": "add_wall", "x1": 0, "y1": 0, "x2": 2, "y2": 0})
    assert len(first.state()["walls"]) == 1
    assert second.state()["walls"] == []
    with pytest.raises(ValueError, match="session code not found"):
        registry.get("NOTACODE00")


def test_load_operation_replaces_map_and_preserves_constraints():
    source = Hub()
    source.apply_op({"op": "add_wall", "x1": 0, "y1": 0, "x2": 3, "y2": 0})
    source.apply_op({"op": "add_rectangle", "x1": 4, "y1": 1, "x2": 6, "y2": 3})
    saved = source.doc.to_dict()
    target = Hub()
    target.apply_op({"op": "add_wall", "x1": 0, "y1": 0, "x2": 1, "y2": 0})

    target.apply_op({"op": "load", "document": saved})

    assert target.doc.to_dict() == saved
    assert target.status["converged"]
    target.apply_op({"op": "add_wall", "x1": 0, "y1": 5, "x2": 2, "y2": 5})
    assert len(target.doc.walls) == 2


def test_loading_empty_document_clears_all_map_content():
    hub = Hub()
    hub.apply_op({"op": "add_wall", "x1": 0, "y1": 0, "x2": 2, "y2": 0})
    hub.apply_op({"op": "add_rectangle", "x1": 3, "y1": 0, "x2": 5, "y2": 2})
    rectangle = next(iter(hub.doc.rectangles.values()))
    hub.apply_op({"op": "save_symbol", "id": rectangle.id, "label": "Desk"})
    wall = next(iter(hub.doc.walls.values()))
    hub.apply_op({"op": "add_opening", "wall": wall.id, "start": 0.5, "end": 1.5})

    hub.apply_op({
        "op": "load",
        "document": {
            "points": {},
            "walls": [],
            "openings": [],
            "rectangles": [],
            "symbols": [],
            "constraints": [],
        },
    })

    assert hub.doc.points == {}
    assert hub.doc.walls == {}
    assert hub.doc.openings == {}
    assert hub.doc.rectangles == {}
    assert hub.doc.symbols == {}
    assert hub.doc.constraints == {}
    assert hub.state()["points"] == {}
    assert hub.status["converged"]


def test_failed_load_does_not_replace_current_document():
    hub = Hub()
    hub.apply_op({"op": "add_wall", "x1": 0, "y1": 0, "x2": 2, "y2": 0})
    before = hub.doc.to_dict()

    with pytest.raises(ValueError):
        hub.apply_op({"op": "load", "document": {}})

    assert hub.doc.to_dict() == before


def test_pinned_wall_corner_drag_preserves_axis_length_during_drag_and_release():
    hub = Hub()
    hub.apply_op({"op": "add_wall", "x1": 0, "y1": 0, "x2": 3, "y2": 0})
    wall = next(iter(hub.doc.walls.values()))
    start_id, end_id = wall.corners[0], wall.corners[3]
    initial_length = math.hypot(
        hub.doc.points[end_id].x - hub.doc.points[start_id].x,
        hub.doc.points[end_id].y - hub.doc.points[start_id].y,
    )
    preserve_lengths = {wall.id: initial_length}

    for position in ((3.1, 0.2), (3.4, 0.3), (3.8, 0.5), (4.2, 0.8), (4.5, 1.0)):
        hub.apply_op({
            "op": "drag",
            "points": {end_id: position},
            "preserve_lengths": preserve_lengths,
        })
        start = hub.doc.points[start_id]
        end = hub.doc.points[end_id]
        assert math.hypot(end.x - start.x, end.y - start.y) == pytest.approx(initial_length, abs=1e-5)

    hub.apply_op({"op": "drag_end", "preserve_lengths": preserve_lengths})

    start = hub.doc.points[start_id]
    end = hub.doc.points[end_id]
    assert math.hypot(end.x - start.x, end.y - start.y) == pytest.approx(initial_length, abs=1e-5)
    thickness = math.hypot(
        hub.doc.points[wall.corners[1]].x - start.x,
        hub.doc.points[wall.corners[1]].y - start.y,
    )
    assert thickness == pytest.approx(0.2, abs=1e-6)


def test_constraint_addition_rejects_when_solver_rows_exceed_parameters():
    hub = Hub()
    hub.apply_op({"op": "add_wall", "x1": 0, "y1": 0, "x2": 3, "y2": 0})
    hub.apply_op({"op": "add_wall", "x1": 4, "y1": 0, "x2": 7, "y2": 0})
    first, second = hub.doc.walls.values()
    hub.apply_op({"op": "add_constraint", "constraint": {
        "type": "coincident", "a": first.corners[3], "b": second.corners[0],
    }})
    hub.apply_op({"op": "add_constraint", "constraint": {
        "type": "coincident", "a": first.corners[2], "b": second.corners[1],
    }})
    before = hub.doc.to_dict()
    status = hub.status.copy()

    with pytest.raises(ValueError, match="overconstrain"):
        hub.apply_op({"op": "add_constraint", "constraint": {
            "type": "coincident", "a": first.corners[0], "b": second.corners[3],
        }})

    assert hub.doc.to_dict() == before
    assert hub.status == status


def test_constraint_addition_allows_rows_up_to_parameter_count():
    hub = Hub()
    hub.apply_op({"op": "add_wall", "x1": 0, "y1": 0, "x2": 3, "y2": 0})
    hub.apply_op({"op": "add_wall", "x1": 4, "y1": 0, "x2": 7, "y2": 0})
    first, second = hub.doc.walls.values()

    hub.apply_op({"op": "add_constraint", "constraint": {
        "type": "coincident", "a": first.corners[3], "b": second.corners[0],
    }})
    hub.apply_op({"op": "add_constraint", "constraint": {
        "type": "coincident", "a": first.corners[2], "b": second.corners[1],
    }})

    assert hub.status["rows"] == hub.status["params"]


def test_rotation_drag_drops_stale_path_orientation_preference():
    hub = Hub()
    hub.apply_op({"op": "add_wall_path", "vertices": [[0, 0], [2, 0], [2, 2]]})
    wall = next(iter(hub.doc.walls.values()))
    hub.apply_op({"op": "add_constraint", "constraint": {
        "type": "horizontal", "wall": wall.id,
    }})
    positions = {}
    for pid in wall.corners:
        point = hub.doc.points[pid]
        positions[pid] = [-point.y, point.x]

    hub.apply_op({
        "op": "drag",
        "points": positions,
        "rotation": True,
        "rotating": [wall.id],
    })

    assert hub.status["converged"]
    start = hub.doc.points[wall.corners[0]]
    end = hub.doc.points[wall.corners[3]]
    assert start.y == pytest.approx(end.y, abs=1e-6)


def test_dragging_a_symbol_corner_point_resizes_sibling_instances():
    hub = Hub()
    hub.apply_op({"op": "add_rectangle", "x1": 0, "y1": 0, "x2": 2, "y2": 1})
    source = next(iter(hub.doc.rectangles.values()))
    hub.apply_op({"op": "save_symbol", "id": source.id, "label": "Desk"})
    symbol = next(iter(hub.doc.symbols.values()))
    hub.apply_op({"op": "add_rectangle", "x1": 5, "y1": 5, "x2": 7, "y2": 6, "symbol": symbol.id})
    sibling = next(r for r in hub.doc.rectangles.values() if r.id != source.id)

    corner = source.corners[2]
    hub.apply_op({"op": "drag", "points": {corner: [2.5, 1.4]}})
    hub.apply_op({"op": "drag_end"})

    p = [hub.doc.points[pid] for pid in sibling.corners]
    width = ((p[1].x - p[0].x) ** 2 + (p[1].y - p[0].y) ** 2) ** 0.5
    height = ((p[3].x - p[0].x) ** 2 + (p[3].y - p[0].y) ** 2) ** 0.5
    assert abs(width - symbol.width) < 1e-4
    assert abs(height - symbol.height) < 1e-4
    assert symbol.width > 2.1 and symbol.height > 1.1


def test_rectangle_operations_are_dispatched_by_hub():
    hub = Hub()
    hub.apply_op({"op": "add_rectangle", "x1": 0, "y1": 0, "x2": 2, "y2": 1})
    rectangle = next(iter(hub.doc.rectangles.values()))
    assert len(hub.doc.rectangles) == 1
    assert hub.status["converged"]

    hub.apply_op({
        "op": "update_rectangle",
        "id": rectangle.id,
        "x1": 0,
        "y1": 0,
        "x2": 3,
        "y2": 2,
    })
    assert [(hub.doc.points[pid].x, hub.doc.points[pid].y) for pid in rectangle.corners] == [
        (0, 0), (3, 0), (3, 2), (0, 2)
    ]

    hub.apply_op({"op": "save_symbol", "id": rectangle.id, "label": "Desk"})
    assert len(hub.doc.symbols) == 1
    symbol = next(iter(hub.doc.symbols.values()))
    assert symbol.label == "Desk"

    hub.apply_op({
        "op": "add_rectangle",
        "x1": 5,
        "y1": 5,
        "x2": 7,
        "y2": 6,
        "symbol": symbol.id,
    })
    instance = max(hub.doc.rectangles.values(), key=lambda item: item.id)
    assert len(hub.doc.expanded_constraints()) == 6
    hub.apply_op({"op": "detach_rectangle", "id": instance.id})
    assert instance.symbol is None
    assert len(hub.doc.constraints) == 3
    assert len(symbol.constraints) == 3


def test_remove_symbol_operation_keeps_instances_independent():
    hub = Hub()
    hub.apply_op({"op": "add_rectangle", "x1": 0, "y1": 0, "x2": 2, "y2": 1})
    rectangle = next(iter(hub.doc.rectangles.values()))
    hub.apply_op({"op": "save_symbol", "id": rectangle.id, "label": "Desk"})
    symbol = next(iter(hub.doc.symbols.values()))
    hub.apply_op({"op": "add_rectangle", "x1": 5, "y1": 5, "x2": 7, "y2": 6, "symbol": symbol.id})

    hub.apply_op({"op": "remove_symbol", "id": symbol.id})

    assert hub.doc.symbols == {}
    assert len(hub.doc.rectangles) == 2
    assert all(rectangle.symbol is None for rectangle in hub.doc.rectangles.values())
    assert len(hub.doc.constraints) == 6
    assert hub.state()["symbols"] == []
    assert hub.status["converged"]
