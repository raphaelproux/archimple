# archimple

A web-based, CAD-flavoured floor-plan sketcher: draw walls, then constrain
them with dimensions, angles and coincident points. The geometry and the
constraint solver live in Python; the browser client is a thin canvas UI
kept in sync over a WebSocket, so any number of browsers can work on the
same plan from one server.

## Run it

```sh
uv sync
uv run archimple            # http://127.0.0.1:8765
uv run archimple --host 0.0.0.0 --port 9000   # serve your LAN
```

Open the printed URL in one or more browser tabs/windows — every client
shares the same document and sees each other's edits live.

## Using the editor

Walls are drawn as thin rectangles (you click the axis, the wall extends
± half-thickness around it, default 20 cm). Each wall keeps its own four
corner vertices; snapping a new wall onto an existing corner creates a
removable **coincident constraint** between the two vertices instead of
sharing a point, so deleting the constraint frees the walls again.

- **Select** — drag a single corner (the wall stays rectangular and
  follows via its hidden constraints), drag inside a wall to move the
  whole rectangle, click a dimension line, angle arc or constraint badge
  to select a constraint; `Delete`/`Backspace` removes the selected wall
  or constraint.
- **Wall** — click two axis points; snapping to an existing vertex creates
  the coincident join. Every new wall automatically gets a thickness
  dimension between its two long edges, using the value in the toolbar
  **wall** field (`0.2 m`, `20 cm`, `200 mm` all accepted). The live
  length/angle is shown while drawing.
- **Dimension** — click two targets: a corner **or a wall edge** (they
  can belong to different walls), then enter the distance. A thickness is
  just a dimension between a wall's two long edges; edge pairs must be
  nearly parallel. Values accept the current unit plus `m`/`cm`/`mm`
  suffixes.
- **Angle** — click two walls, then enter the angle between their axes.
  Angles are always positive (0–180°); a value is applied to the nearest
  matching orientation, so walls sitting at a signed −93° given "90°"
  rotate 3° to −90° instead of swinging the long way round.
- **Coincident** — click two corners of (any) two walls.
- **Horizontal / Vertical** — constrain a wall's axis.

The **Constraints** checkbox in the header shows/hides all constraint
annotations on the drawing: dimension lines, angle arcs, coincidence
rings and a small selectable badge (↔ ∠ ≡ ─ │) for every constraint —
click a badge or its graphics to select, `Delete` or the panel ✕ to
remove. Keyboard shortcuts: `S` `W` `D` `A` `C` `H` `V`. Wheel zooms,
middle-drag pans. In select mode, **right-drag rotates the selected wall**
(or the wall under the cursor) around its own center — the cursor angle
from the center sets the rotation; right-drag on empty space pans
instead. New wall corners and dragged corners snap to
the visible grid — 10 cm at normal zoom, coarser when zoomed out. Corner
snapping onto existing vertices always stays on, since that is how joins
are made. `m`/`cm` switches the display unit (values are stored in
metres internally). The **Solve** button re-runs the solver explicitly.

The status bar shows the cursor position, solver status and free degrees
of freedom; the side panel lists all constraints (click to highlight,
✕ to delete).

## Architecture

```
src/archimple/
  model.py     document model: points, rectangular walls, constraints
  solver.py    Levenberg–Marquardt solver with analytic Jacobians; hidden
               per-wall constraints keep walls rectangular and thickness
               non-negative
  store.py     shared document + client registry, applies client ops
  server.py    FastAPI: /ws WebSocket + static files
  static/      single-page canvas client (vanilla JS, no build step)
```

A wall owns four corner points (start+, start−, end−, end+ around its
axis); the solver adds four hidden rows per wall (parallelogram ×2,
right angle ×1, thickness floor ×1) so walls always remain rectangles.
Dimension constraints can reference a vertex (corner point) or an edge
(a wall side); edge dimensions are signed distances and a wall's
two long edges give its thickness.

## Tests

```sh
uv run pytest
```
