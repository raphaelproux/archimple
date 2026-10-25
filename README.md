# archimple

A web-based, CAD-flavoured floor-plan sketcher: draw walls, then constrain
them with dimensions, angles and coincident points. The geometry and
constraint assembly live in Python; a Rust extension accelerates the
Levenberg–Marquardt numerical kernel. The browser client is a thin canvas UI
kept in sync over a WebSocket, so any number of browsers can work on the
same plan from one server.

## Run it

```sh
uv sync                      # requires Rust/Cargo to build the extension
uv run archimple            # http://127.0.0.1:8765
uv run archimple --host 0.0.0.0 --port 9000   # serve your LAN
```

Open the printed URL to start a private session. The session code appears in
the footer; share it with collaborators, who can enter it in the footer to join
the same document. Reconnecting browsers return to their previous session.
Sessions are in-memory and disappear when the server restarts.

## Using the editor

Walls are drawn as thin rectangles (you click the axis, the wall extends
± half-thickness around it, default 20 cm). Each wall keeps its own four
corner vertices; snapping a new wall onto an existing corner creates a
removable **coincident constraint** between the two vertices instead of
sharing a point, so deleting the constraint frees the walls again.

- **Select** — drag a single corner (the wall stays rectangular and
  follows via its hidden constraints), drag inside a wall or rectangle to move
  the shape, click a dimension line, angle arc or constraint badge
  to select a constraint; `Delete`/`Backspace` removes the selected wall
  or constraint.
- **Rectangle** — choose **Rectangle** (`R`) and click opposite corners to
  create an axis-aligned rectangle. Each rectangle starts with three editable
  90° angle constraints. Select it and click **Save as symbol** in the toolbar;
  enter a label, then choose **Place** in the Symbols sidebar and click where
  the copy's center should be. Constraints on the symbol are shared by every
  instance; resize or edit a shared constraint on any instance to update them
  all. Select an instance and choose **Make independent rectangle** to detach
  it and keep its constraints local. Use the remove button beside a library
  symbol to remove it while keeping placed rectangles as independent shapes.
- **Wall path** (`P`) — click successive vertices to draw multiple walls with
  corner joins; press Enter to close the polygon or double-click to finish an
  open path. Segments share the toolbar thickness.
- **Cut wall** (`X`) — click inside a wall to split it into two constrained
  segments. Openings are retained and split if they cross the cut.
- **Wall path** (`P`) — click path vertices to make connected wall segments;
  press Enter to close a polygon or double-click to finish an open path. The
  path interior is placed consistently to one side and corners join on the
  outer side. Existing wall corners can be snapped into the path.
- **Cut wall** (`X`) — click inside a wall to split it into two segments with
  a 10 cm gap. Existing openings and endpoint connections are preserved; wall
  axis-length dimensions are removed because the original wall no longer exists.
- **Wall** — click two axis points; snapping to an existing vertex creates
  the coincident join. Every new wall automatically gets a thickness
  dimension between its two long edges, using the value in the toolbar
  **wall** field (`0.2 m`, `20 cm`, `200 mm` all accepted). The live
  length/angle is shown while drawing.
- **Opening** — click two points along a wall axis to create a thin segment
  with its own length. In Select mode, drag an endpoint to resize it or drag
  the segment body to move it along its host wall. Openings follow their wall
  when it moves or rotates and are removed when the host wall is deleted.
- **Dimension** — click two targets: an opening segment or handle, corner,
  wall edge, or wall axis end (they can belong to different walls), then enter
  the distance. Two handles dimension their opening length or the distance
  between openings; the opening segment itself can also be picked to constrain
  its length, and a handle can be dimensioned against a corner or edge. A thickness is
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
remove. Keyboard shortcuts: `S` `W` `O` `D` `A` `C` `H` `V`. Wheel zooms,
middle-drag pans. In select mode, **right-drag rotates the selected wall**
(or the wall under the cursor) around its own center — the cursor angle
from the center sets the rotation; right-drag on empty space pans
instead. New wall corners and dragged corners snap to
the visible grid — 10 cm at normal zoom, coarser when zoomed out. Corner
snapping onto existing vertices always stays on, since that is how joins
are made. `m`/`cm` switches the display unit (values are stored in
metres internally). The **Solve** button re-runs the solver explicitly.
**Save map** downloads a JSON file containing the map and its constraints;
**Load map** replaces the shared document with the contents of a saved JSON
file, and **Clear map** removes all content; both changes are broadcast to all
connected clients.

The status bar shows the cursor position, solver status and free degrees
of freedom; the side panel lists all constraints (click to highlight,
✕ to delete).

## Architecture

```
src/archimple/
  model.py     document model: points, rectangular walls, constraints
  solver.py    Levenberg–Marquardt solver and analytic Jacobian assembly
  _native      Rust/PyO3 normal-equation assembly and damped linear solve
  store.py     session registry and per-session document/client hubs
  server.py    FastAPI: session-scoped /ws WebSocket + static files
  static/      single-page canvas client (vanilla JS, no build step)
```

A wall owns four corner points (start+, start−, end−, end+ around its
axis); the solver adds four hidden rows per wall (parallelogram ×2,
right angle ×1, thickness floor ×1) so walls always remain rectangles.
Dimension constraints can reference a vertex (corner point), an edge
(a wall side), or an opening handle; edge dimensions are signed distances
and a wall's two long edges give its thickness.

## Build and tests

Building the package compiles the Rust extension and requires Rust/Cargo:

```sh
uv sync
uv build
uv run pytest
```
