# AGENTS.md — working on archimple

A web-based, CAD-flavoured floor-plan sketcher: users place walls as
rectangles and constrain them with dimensions, angles, and coincident
points. The geometry model and constraint solver live in Python (the
server is the single source of truth); the browser client is a thin
canvas UI kept in sync over a WebSocket. Multiple browsers can work on
one shared document simultaneously.

Read this file before making changes — it documents conventions,
non-obvious design decisions, and several hard-won gotchas.

## Layout

```
archimple/
├── pyproject.toml          uv project; deps: fastapi, uvicorn[standard], numpy; dev: pytest, selenium
├── README.md               user-facing docs (keep in sync with behaviour)
├── AGENTS.md               this file
├── src/archimple/
│   ├── __init__.py         console entry point (argparse + uvicorn.run)
│   ├── __main__.py         `python -m archimple`
│   ├── model.py            document model: points, walls, constraints
│   ├── solver.py           Levenberg–Marquardt constraint solver
│   ├── store.py            in-memory Hub: shared document + client registry
│   ├── server.py           FastAPI app: /ws WebSocket + static mount
│   └── static/
│       ├── index.html      page shell (header toolbar, canvas, panel, dialog)
│       ├── style.css       dark theme; NOTE: #dialog[hidden] rule is required
│       └── app.js          the entire client (~1300 lines, vanilla JS, no build step)
└── tests/
    ├── test_model.py       document model behaviour
    └── test_solver.py      solver behaviour
```

## Running

```sh
uv sync                       # create .venv
uv run archimple              # http://127.0.0.1:8765 (argparse: --host, --port)
uv run archimple --host 0.0.0.0 --port 9000   # LAN
uv run pytest                 # unit tests
```

The server keeps everything in memory; there is no persistence. A fresh
process starts with an empty document. Restarting the server reloads
`app.js`/`index.html` — actually static files are served fresh on each
page load, so client changes only need a browser hard-refresh, not a
server restart (the server may keep running).

## Core conventions (read carefully)

- **Units**: all geometry is stored and exchanged in **metres** (floats).
  cm/mm exist only in the UI layer (display formatting and input parsing
  in the client).
- **Coordinate system**: world y is **up**. Screen mapping in the client:
  `screen_x = world_x * view.scale + view.ox`, `screen_y = view.oy − world_y * view.scale`.
  `view.scale` is px per metre (default 100), `view.ox/oy` are CSS pixels;
  the world origin starts at the canvas centre. y-up means `atan2(dy, dx)`
  in world space is the mathematical angle, while canvas drawing angles
  are negated.
- **Rounding**: `Document.to_dict()` rounds coordinates to 6 decimals.
  Don't write assertions tighter than ~1e-6 against serialized state,
  and beware that broadcast values (6dp) can differ from local-echo
  values in the last digits.
- **Point identity**: every point carries its own `id` in the serialized
  payload (`{"id": pid, "name", "x", "y"}`) — the client reads `p.id`
  from point objects. (A past bug had the id only as dict key; that
  silently broke dragging. Don't remove it.)
- **Angles**: user-facing angle values are always **positive in [0, 180]**
  (`_fold_angle` maps −90→90, 270→90, 450→90). Internally a constraint
  stores a **signed** target in (−180, 180] whose sign is chosen at
  creation to be nearest the current arrangement; edits keep the stored
  sign and change only magnitude. UI always displays `abs`.

## Data model (`model.py`)

- `Point(id, name, x, y)` — points are wall corners; nothing else creates
  points.
- `Wall(id, name, corners: [c0..c3])` — **a wall is a rectangle** defined
  by four corner points laid around its axis:
  `c0 = start+` , `c1 = start−`, `c2 = end−`, `c3 = end+`, where `±` is
  along `n̂ = perp(unit(axis))` (left normal), offset `h = thickness/2`.
  The axis is the line c0..c3 midpoints: start = (c0+c1)/2, end = (c2+c3)/2.
- `Constraint` variants:
  - `Coincident(id, name, a, b)` — two **point ids**.
  - `Distance(id, name, a, b, length, offset)` — `a`/`b` are **refs**:
    `{"kind": "vertex", "pid": ...}` or `{"kind": "edge", "wall": ..., "side": ±1}`.
    `length` is the positive magnitude shown to users; `offset` is the
    signed target distance and is `None` only for vertex-vertex
    dimensions. Convention: if any edge ref exists, the constraint is
    stored with the edge **first** (`a` = edge, `b` = vertex or second
    edge), and the signed distance is measured from ref a's edge line to
    ref b's target. Edge refs use `side = +1` (the c0→c3 long edge) or
    `side = −1` (c1→c2). For a normally oriented wall the thickness
    dimension measures −t (negative offset); non-negativity of thickness
    is enforced by a hidden solver row, not by sign gymnastics.
  - `AngleBetween(id, name, wall_a, wall_b, degrees)` — signed target as
    described above; axes are the c0→c3 directions.
  - `Horizontal` / `Vertical(id, name, wall)` — constrains the wall axis.
- **Auto thickness dimension**: `Document.add_wall(...)` always creates a
  Distance between the wall's two long edges with the requested
  thickness. It is a normal, deletable/editable constraint; re-adding a
  distance on the same edge pair **updates** it (dedupe) rather than
  duplicating.
- **Joins**: `add_wall(start, end, thickness, joins)` where each join is
  `{"corner": 0..3, "pid": existing_point_id}`. Joins create Coincident
  constraints between the new wall's corner and the existing vertex —
  walls never share points. Deleting a coincident frees both walls.
- **Deletion semantics**: deleting a wall removes its 4 corners, plus any
  constraint referencing those points or that wall (angle/h/v refs,
  edge refs). Points belong to walls; constraints referencing dead
  points are dropped.
- Dedupe rules in `add_constraint`: same vertex-vertex pair → update
  length; same edge-pair (sorted ref keys) → update length keeping the
  existing `offset` sign; same wall pair angle → update degrees keeping
  sign; same coincident pair → no-op; one h/v per wall.

## Solver (`solver.py`)

- Levenberg–Marquardt (damped Gauss–Newton) over the flat vector of all
  **free** point coordinates. Pinned points (during drag) are excluded
  from the parameter vector but still referenced by residuals.
- **Analytic Jacobians** for every row (numeric differentiation would be
  too slow for interactive drag). Rows are `(residual, [(pid, comp, ∂r/∂·), ...])`
  with comp 0=x, 1=y, assembled into a dense J (documents are small).
- **Hidden per-wall rows** (generated in `evaluate`, not user-visible,
  not listed in the panel): 2 parallelogram rows (`c3−c0 == c2−c1`),
  1 right-angle row (`(c3−c0)·(c1−c0) = 0`), and a thickness floor
  `cross(c1−c0, c3−c0) ≥ EPS_THICK` (1e-3) that flips back walls whose
  corners end up mirrored (negative thickness). These are what keep
  walls rectangular — never "fix" rectangle-ness in the renderer.
- Convergence: `max|r| < 1e-6` ⇒ converged; status also reports params,
  rows, remaining DOF (`n − rank(J)`), iterations. Status is serialized
  into every state broadcast under `"status"`.
- Drag solves use `max_iter=25` and pin the dragged points; release
  (`drag_end`) runs a full unpinned solve. A fully converged drag solve
  leaves the released positions stable (the hidden constraints are
  satisfied by then); this was verified — don't "fix" spring-back by
  pinning on release.

## Server (`store.py`, `server.py`)

- `Hub` holds the single `Document`, a client set, an `asyncio.Lock`, and
  the last `status`. `apply_op` mutates the document then `_solve`s.
- FastAPI serves `static/` at `/` (mounted last, so `/ws` wins) and
  exposes the single `/ws` endpoint. On connect a client immediately
  receives the full current state. After each applied op the server
  **broadcasts the full state to every client including the sender**.
- Invalid ops raise KeyError/ValueError/TypeError, which are caught and
  sent back as `{"op": "error", "message": ...}` without breaking the
  connection. Unknown ops raise ValueError.
- Concurrency: ops are applied sequentially under the lock; last write
  wins. Solves are fast (<10 ms for realistic sketches).
- On client disconnect Starlette may raise `WebSocketDisconnected`
  (a `RuntimeError`) — the handler catches it explicitly; keep that
  catch when touching the endpoint.

### WebSocket protocol

Client → server ops (JSON objects):
- `{"op":"add_wall", x1,y1,x2,y2, thickness, joins:[{corner,pid},...]}` —
  the client has already adjusted the axis for joins (see client section);
  the server just creates 4 corner points + wall + auto dimension + joins.
- `{"op":"drag", points:{pid:[x,y], ...}}` — move points then solve with
  them pinned (`max_iter=25`).
- `{"op":"drag_end"}` — full unpinned solve.
- `{"op":"add_constraint", constraint:{...}}` — see model section for the
  shape per type (refs for distance).
- `{"op":"update_constraint", id, value}` — distance magnitude (keeps
  offset sign) or angle magnitude (keeps orientation sign).
- `{"op":"delete", id}` — wall or constraint id.
- `{"op":"solve"}` — explicit full solve.

Server → client: full state on connect and after every op:
`{points: {pid: {id,name,x,y}}, walls: [{id,name,corners:[4 pids]}],
constraints: [...], status: {converged,max_residual,params,rows,dofs,iterations}}`,
or `{"op":"error", message}`.

**Testing gotcha — message accounting**: every op produces exactly one
state broadcast per connected client. A *newly opened* WebSocket first
receives the initial state, THEN any broadcasts triggered by its own
subsequent ops. Tests that open a second connection to send an op must
`recv()` (and discard) the initial state first, or they'll assert against
a stale message. This has bitten three separate tests.

## Client (`static/app.js`)

Single classic script (not a module) — top-level `let` bindings are
script-scoped, **not** on `window`. A test seam is exposed at the bottom:

```js
window.__archimple = { get state, get drag, get rotate, get selection,
                       get tool, get showC, view }
```

Keep it; automated tests rely on it. If the seam is `undefined` in a
browser, the whole script failed to parse/run — see gotchas.

State/behaviour summary:

- `state` is the last server broadcast (authoritative geometry). Local
  echo during gestures mutates `state.points` directly for immediate
  feedback; broadcasts then confirm/replace.
- Rendering order: grid → coincident/angle annotations (if `showC`) →
  walls (thin rectangle outline + corner squares, 20 cm visual wall
  thickness scaling with zoom) → distance dimensions + constraint badges
  (if `showC`) → tool preview → hover highlight. All drawing goes through
  `toScreen`/`toWorld`; devicePixelRatio is handled with `setTransform`.
- Grid: `gridSteps()` returns `[minor, major]` — `[0.1,1]` at scale ≥ 40,
  `[1,5]` at ≥ 8, `[5,25]` below. `gridSteps()[0]` is also the **snap
  step** (grid snapping is always on; there is no UI toggle any more).
- Snapping rules (`snapWorld(w, exclude)`): nearest corner within
  12 px/scale wins first (regardless of anything); otherwise grid snap.
  The `exclude` set exists to prevent self-destruction while dragging:
  when dragging a corner, pass `coincidentSet(pid)` **plus all corners of
  the dragged wall** — otherwise the dragged corner snaps onto its own
  wall's neighbours (only ~20 px apart), degenerating the rectangle.
- Tools: select / wall / dim / angle / coincident / horizontal / vertical,
  keyboard `S W D A C H V`, `Esc` cancels pending + selection,
  `Delete`/`Backspace` deletes selection. Header: wall-thickness text
  field (parses `0.2 m`/`20 cm`/`200 mm`; default `0.2 m`; sent with every
  `add_wall`), Constraints show/hide checkbox, m/cm unit toggle, Solve.
- Wall drawing: click 1 then click 2 (axis endpoints). At click 2 the
  client performs **join adjustment**: for each snapped endpoint, it finds
  the owner wall, computes σ_T (corner side ±), checks collinearity
  (`|dot(d̂, â_owner)| > 0.9` → continuation), picks the matching new
  corner σ_new, then **iterates** `pt = T − σ_new·h·n̂(other−pt)` ~6 times
  so the chosen corner lands *exactly* on the target vertex. This
  fixed-point iteration matters: a single-step shift changes the axis
  direction (when only one end snaps) and leaves a visible ~h error that
  the solver then "fixes" by nudging the joined wall. Don't simplify it
  back to a one-step shift.
- Gestures (pointer events on the canvas; `setPointerCapture` is wrapped
  in try/catch — synthetic/test events have bogus pointer ids):
  - **Left drag (select tool)**: corner pick (12 px) → point drag (pinned
    corner, snap exclusions above); else wall body → translate all 4
    corners (delta snapped to grid); else constraint pick (select only).
  - **Middle drag: always pan.**
  - **Right drag**: rotates the selected wall (or the wall under the
    cursor, auto-selecting it) **around the wall's own centre**; cursor
    angle from centre minus reference angle drives it. Reference: if the
    press is >0.02 m from the centre, the press angle; if the press is on
    the centre, the wall's own axis direction (end-follows-cursor /
    compass-needle semantics — the press-on-pivot case is degenerate for
    `atan2(0,0)` and must not fall back to 0 arbitrarily). With no wall
    involved, right-drag pans. On release: force-send final positions +
    `drag_end`.
  - Drag/rotate ops are throttled to ~33 ms (`sendDrag`); the final send
    at pointerup is forced. Do not remove the throttle; do not remove the
    forced final send either (the throttle would otherwise lose the last
    move).
- Dimension tool: two picks of a **target** — corner (vertex ref) or wall
  edge (edge ref; hover within 7 px of an edge). Edge-edge requires
  near-parallel (±5°, enforced again server-side); value dialog prefills
  the current unsigned distance. Angle tool: pick two walls, dialog
  prefills the **positive** current angle. Coincident: two corners.
- Dialog: `#dialog` with `hidden` attribute — **the CSS must keep
  `#dialog[hidden] { display: none; }`** because `#dialog` sets
  `display:flex`, which would otherwise override `[hidden]` and leave the
  dialog permanently visible (this exact bug occurred once).
- Badges: every constraint gets a small glyph badge (↔ ∠ ≡ ─ │) at its
  anchor; both badges and graphics are click-selectable via
  `pickConstraint` (gated on `showC`).

## Testing

1. **pytest** (`uv run pytest`): model + solver unit tests. Use the
   existing helpers (`make_wall`). Tolerances: geometry assertions ≥1e-6;
   angle checks ~1e-3. When adding model features, remember every wall
   now auto-creates a thickness dimension — constraint-count assertions
   must account for it.
2. **WebSocket smoke**: python script using `websockets` (bundled via
   `uvicorn[standard]`) against `uvicorn.Server` in a thread
   (`server.should_exit = True` to stop). Follow the message-accounting
   rule above. Mind the `~/.cache` read-only problem: set
   `UV_CACHE_DIR=/tmp/uv-cache` for any `uv` invocation in the sandbox.
3. **Browser tests** (the real proof for interaction bugs): system
   Firefox + Selenium (`uv add --dev selenium` already done). Driver
   quirks in this environment:
   - `XDG_CACHE_HOME=/tmp/xdg-cache` must be set (home is read-only) and
     Selenium Manager needs network to github.com/raw.githubusercontent.com
     to (re)fetch geckodriver — request `allow_all_hosts` for the call.
   - `/tmp` is wiped between terminal calls: write the test script and
     run it in the **same** command.
   - Selenium 4.51 Python `ActionChains` has no `pointer_down`; dispatch
     synthetic `PointerEvent`s via `execute_script` instead (button/
     buttons fields matter: `buttons: 2` for right-drag). The app's
     try/catch on `setPointerCapture` makes synthetic events work.
   - Synthetic coordinates can disagree with the app's `view.ox/oy` by
     ~0.2 px (view offsets are captured at first resize). Angle/pivot
     assertions should tolerate ~0.01 m. For pure translation checks
     (pan), exactness holds.
   - Prefer asserting on **server state via a websocket observer** rather
     than canvas pixels; use the `window.__archimple` seam for client
     internals.
   - Collected JS errors via an injected `window.onerror` collector
     *before* interacting; but note a parse error kills the script before
     any collector — symptom: `window.__archimple is undefined`.

## Gotchas / lessons learned (do not regress)

- **A JS syntax error kills the entire script** (not just the handler):
  the symptom is the test seam missing and *everything* (drawing, tools)
  dead, with no window error. The `ty` diagnostics tool does catch JS
  syntax errors — run it after editing `app.js`.
- **Don't reuse variable/function names across kinds** in app.js: a
  `let wallThickness` and a `function wallThickness(w)` coexisted once →
  redeclaration SyntaxError → whole client dead. The diagnostics tool
  catches this too.
- **Every left click runs `pickConstraint`** — a missing helper there
  (`distToSegScreen` went missing once) silently breaks deselection and
  any empty-space click, because the exception aborts the handler before
  `selection = null`. Keep the try/catch + error-collector pattern in
  tests when hunting such bugs.
- **`Math.round(-0.5) === -0`/`-4` in JS** (rounds toward +∞ on .5) —
  don't assert exact `-0.5`-style expectations from snapped values.
- The `id`-in-point-payload rule, the join fixed-point iteration, the
  drag-snap exclusions, and the `#dialog[hidden]` CSS rule are all fixes
  for real reported bugs — see the sections above for the reasoning.

## Sandbox notes (this development environment)

- Outbound network is blocked by default; `uv sync`/`uv add` need
  pypi.org + files.pythonhosted.org approval; Selenium Manager needs
  github access (see above). Prefer `allow_hosts` over `allow_all_hosts`
  when the host list is known.
- Writes are limited to the project dir and /tmp; **/tmp is cleared
  between terminal calls** — never rely on files created in a previous
  call. `~/.cache` is read-only (hence the env-var dance).
- `uv` needs `UV_CACHE_DIR=/tmp/uv-cache` for every invocation.
- The diagnostics tool (per-file errors) is the fastest syntax/typing
  check; use it after every edit instead of eyeballing.

## Known limitations (fine to mention to the user, don't "fix" silently)

- No persistence; document dies with the server process.
- Single shared document for all clients (last-write-wins).
- T-junctions (corner meeting the *middle* of another wall's face) are
  not supported — only vertex-vertex coincidence.
- Angle arcs/rays are drawn along wall axes even when the intersection
  point lies far off the segments (CAD-style infinite-line semantics).
- Wall thickness min ~1e-3/length via the hidden floor; a user dimension
  demanding t=0 will simply fail to converge.
