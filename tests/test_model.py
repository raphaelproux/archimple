import math

import pytest

from archimple.model import Coincident, Distance, Document


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
    assert set(d) == {"points", "walls", "constraints"}
    assert len(d["walls"]) == 1 and len(d["walls"][0]["corners"]) == 4
    cdict = d["constraints"][0]
    assert cdict["type"] == "distance" and cdict["offset"] == pytest.approx(-0.25)
    assert d["points"][w.corners[0]]["id"] == w.corners[0]
