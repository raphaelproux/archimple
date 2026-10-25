"use strict";

/* ---------- DOM ---------- */
const canvas = document.getElementById("board");
const wrap = document.getElementById("canvas-wrap");
const ctx = canvas.getContext("2d");
const hintEl = document.getElementById("hint");
const coordsEl = document.getElementById("coords");
const solverEl = document.getElementById("solver");
const connEl = document.getElementById("conn");
const listEl = document.getElementById("constraint-list");
const symbolListEl = document.getElementById("symbol-list");
const statusEl = document.getElementById("status");
const dialogEl = document.getElementById("dialog");
const dialogLabel = document.getElementById("dialog-label");
const dialogInput = document.getElementById("dialog-input");
const symbolModal = document.getElementById("symbol-modal");
const symbolLabelInput = document.getElementById("symbol-label");
const symbolSaveButton = document.getElementById("symbol-save");
const symbolCancelButton = document.getElementById("symbol-cancel");
const saveSymbolButton = document.getElementById("save-symbol-btn");

/* ---------- state ---------- */
let state = { points: {}, walls: [], openings: [], rectangles: [], symbols: [], constraints: [], status: null };
let wallsById = {};
let constraintsById = {};
let wallThickness = 0.2;  // default wall thickness from the toolbar field, metres
const thickInput = document.getElementById("wall-thickness");
const view = { scale: 100, ox: 0, oy: 0 }; // screen = world*scale + o, y-up
let viewInitialized = false;
let tool = "select";
let units = "m";
let showC = true;
let pending = [];   // collected clicks for multi-step tools
let measurements = [];
let nextMeasurementId = 1;
let pendingMeasurementsRestore = null;
let hover = null;   // {kind, id, side?}
let selection = null; // {kind, id}
let drag = null;
let rectangleGesture = null;
let symbolPlacement = null;
let rotate = null;
let pan = null;
let symbolResizePreview = null;
let mouse = { wx: 0, wy: 0, sx: 0, sy: 0, inside: false, shiftKey: false };
let dpr = window.devicePixelRatio || 1;

/* ---------- websocket ---------- */
let ws = null;
let lastDragSend = 0;
let hintTimer = null;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { connEl.textContent = "connected"; connEl.className = ""; };
  ws.onclose = () => {
    connEl.textContent = "disconnected — retrying";
    connEl.className = "off";
    setTimeout(connect, 1000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.points) {
      state = msg;
      if (pendingMeasurementsRestore) {
        measurements = pendingMeasurementsRestore;
        nextMeasurementId = measurements.reduce((next, item) => Math.max(next, Number(item.id) + 1 || next), 1);
        pendingMeasurementsRestore = null;
        selection = null;
        pending = [];
      }
      if (symbolResizePreview) {
        const symbol = state.symbols.find(item => item.id === symbolResizePreview.symbolId);
        if (symbolResizePreview.released && symbol
            && Math.abs(symbol.width - symbolResizePreview.width) < 1e-5
            && Math.abs(symbol.height - symbolResizePreview.height) < 1e-5) {
          symbolResizePreview = null;
        } else {
          const source = state.rectangles.find(item => item.id === symbolResizePreview.sourceId);
          if (source) source.corners = symbolResizePreview.sourceCorners.map((point, index) => {
            const pid = source.corners[index];
            const serverPoint = state.points[pid];
            if (serverPoint && Math.hypot(serverPoint.x - point.x, serverPoint.y - point.y) < 1e-5) {
              return pid;
            }
            state.points[pid] = { ...serverPoint, x: point.x, y: point.y };
            return pid;
          });
          const instances = new Map();
          for (const rectangle of state.rectangles) {
            if (rectangle.symbol !== symbolResizePreview.symbolId) continue;
            const preview = symbolResizePreview.instances.get(rectangle.id);
            if (!preview) continue;
            const points = preview.map((point, index) => {
              const pid = rectangle.corners[index];
              state.points[pid] = { ...state.points[pid], id: pid, x: point.x, y: point.y };
              return { x: point.x, y: point.y };
            });
            instances.set(rectangle.id, points);
          }
          symbolResizePreview.instances = instances;
        }
      }
      for (const symbol of state.symbols || []) {
        for (const constraint of symbol.constraints || []) {
          constraint.shared_symbol = symbol.id;
        }
      }
      indexState();
      if (pendingSymbolSave) {
        const rectangle = state.rectangles.find(item => item.id === pendingSymbolSave.id);
        const symbol = state.symbols.find(item => item.id === rectangle?.symbol);
        if (symbol?.label === pendingSymbolSave.label) pendingSymbolSave = null;
      }
      syncPanel();
      draw();
    } else if (msg.op === "error") {
      pendingSymbolSave = null;
      pendingMeasurementsRestore = null;
      flash(msg.message);
    }
  };
}

function send(op) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(op));
}

function indexState() {
  wallsById = {};
  for (const w of state.walls) wallsById[w.id] = w;
  constraintsById = {};
  for (const c of state.constraints) constraintsById[c.id] = c;
}

/* ---------- units ---------- */
function fmtLen(m) {
  if (units === "cm") return `${Math.round(m * 100)} cm`;
  return `${m.toFixed(2)} m`;
}

function parseLen(text) {
  const t = String(text).trim().toLowerCase().replace(",", ".");
  const m = /^([\d.]+)\s*(m|cm|mm)?$/.exec(t);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (m[2] === "cm") v /= 100;
  else if (m[2] === "mm") v /= 1000;
  else if (!m[2] && units === "cm") v /= 100;
  return v > 0 ? v : null;
}

function parseAngle(text) {
  const t = String(text).trim().replace(",", ".").replace(/°\s*$/, "");
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

function fmtDeg(d) {
  return `${Math.round(d * 10) / 10}°`;
}

/* ---------- wall geometry ---------- */
function pt(pid) {
  return state.points[pid];
}

function hasCorners(w) {
  return w.corners && w.corners.every(pid => state.points[pid]);
}

function corners(w) {
  return w.corners.map(pid => state.points[pid]);
}

function wallAxis(w) {
  const c = corners(w);
  return {
    ax: (c[0].x + c[1].x) / 2, ay: (c[0].y + c[1].y) / 2,
    bx: (c[2].x + c[3].x) / 2, by: (c[2].y + c[3].y) / 2,
  };
}

function axisDir(w) {
  const a = wallAxis(w);
  return { x: a.bx - a.ax, y: a.by - a.ay };
}

function rectanglePoints(rectangle) {
  if (rectangle.corners.every(corner => typeof corner === "string")) {
    return rectangle.corners.map(pid => state.points[pid]).filter(Boolean);
  }
  return rectangle.corners;
}

function rectBounds(rectangle) {
  const points = rectanglePoints(rectangle);
  return {
    x1: Math.min(...points.map(p => p.x)),
    y1: Math.min(...points.map(p => p.y)),
    x2: Math.max(...points.map(p => p.x)),
    y2: Math.max(...points.map(p => p.y)),
  };
}

function openingEnds(opening) {
  const wall = wallsById[opening.wall];
  if (!wall || !hasCorners(wall)) return null;
  const axis = wallAxis(wall);
  const dx = axis.bx - axis.ax, dy = axis.by - axis.ay;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return null;
  const ux = dx / length, uy = dy / length;
  return [
    { x: axis.ax + ux * opening.start, y: axis.ay + uy * opening.start },
    {
      x: axis.ax + ux * (opening.start + opening.length),
      y: axis.ay + uy * (opening.start + opening.length),
    },
  ];
}

function projectOpening(w, wall) {
  const axis = wallAxis(wall);
  const dx = axis.bx - axis.ax, dy = axis.by - axis.ay;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return null;
  const ux = dx / length, uy = dy / length;
  return Math.max(0, Math.min(length, (w.x - axis.ax) * ux + (w.y - axis.ay) * uy));
}

function pickWallPathCorner(w) {
  let best = null, bestDistance = 10 / view.scale;
  for (const wall of state.walls || []) {
    if (!hasCorners(wall)) continue;
    for (const pid of wall.corners) {
      const p = state.points[pid];
      const distance = Math.hypot(p.x - w.x, p.y - w.y);
      if (distance < bestDistance) {
        best = p;
        bestDistance = distance;
      }
    }
  }
  return best;
}

function pickRectangle(w) {
  for (const rectangle of state.rectangles || []) {
    const points = rectangleRenderPoints(rectangle);
    const screen = toScreen(w.x, w.y);
    if (points.some((point, index) => {
      const next = points[(index + 1) % points.length];
      return distToSegScreen(screen.x, screen.y, toScreen(point.x, point.y), toScreen(next.x, next.y)) <= 8;
    })) return rectangle;
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j];
      if ((a.y > w.y) !== (b.y > w.y)
          && w.x < (b.x - a.x) * (w.y - a.y) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    if (inside) return rectangle;
  }
  return null;
}

function pickRectangleCorner(rectangle, w) {
  const points = rectangleRenderPoints(rectangle);
  let nearest = null, distance = 12;
  points.forEach((point, index) => {
    const d = Math.hypot((point.x - w.x) * view.scale, (point.y - w.y) * view.scale);
    if (d < distance) { nearest = index; distance = d; }
  });
  return nearest;
}

function pickOpening(w) {
  let best = null, bestD = 8;
  for (const opening of state.openings || []) {
    const ends = openingEnds(opening);
    if (!ends) continue;
    const a = toScreen(ends[0].x, ends[0].y), b = toScreen(ends[1].x, ends[1].y);
    const d = distToSegScreen(w.x * view.scale + view.ox, view.oy - w.y * view.scale, a, b);
    if (d < bestD) { best = opening; bestD = d; }
  }
  return best;
}

function edgePts(w, side) {
  const c = corners(w);
  return side > 0 ? [c[0], c[3]] : [c[1], c[2]];
}

function edgeUnit(w, side) {
  const [P, Q] = edgePts(w, side);
  const dx = Q.x - P.x, dy = Q.y - P.y;
  const L = Math.hypot(dx, dy);
  return L > 1e-9 ? { x: dx / L, y: dy / L } : null;
}

function signedDistPointEdge(p, wall, side) {
  const [P] = edgePts(wall, side);
  const u = edgeUnit(wall, side);
  if (!u) return 0;
  return (p.x - P.x) * (-u.y) + (p.y - P.y) * u.x;
}

function signedDistEdgeEdge(w1, s1, w2, s2) {
  const [P1] = edgePts(w1, s1);
  const [P2] = edgePts(w2, s2);
  const u1 = edgeUnit(w1, s1);
  if (!u1) return 0;
  return (P2.x - P1.x) * (-u1.y) + (P2.y - P1.y) * u1.x;
}

function pointInWall(wall, p, margin) {
  const c = corners(wall);
  const dx = c[3].x - c[0].x, dy = c[3].y - c[0].y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return false;
  const ux = dx / L, uy = dy / L;
  const nx = -uy, ny = ux;
  const rx = p.x - c[0].x, ry = p.y - c[0].y;
  const lx = rx * ux + ry * uy;
  const ly = rx * nx + ry * ny;
  const t = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y);
  return lx >= -margin && lx <= L + margin && ly >= -t - margin && ly <= margin;
}

function distToSegWorld(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function pickConstraintLine(w) {
  const target = toScreen(w.x, w.y);
  let best = null, bestDistance = 7;
  for (const wall of state.walls || []) {
    if (!hasCorners(wall)) continue;
    const axis = wallAxis(wall);
    const points = [
      { x: axis.ax, y: axis.ay }, { x: axis.bx, y: axis.by },
    ];
    const distance = distToSegScreen(target.x, target.y, toScreen(points[0].x, points[0].y), toScreen(points[1].x, points[1].y));
    if (distance < bestDistance) {
      best = { kind: "wall", wall: wall.id };
      bestDistance = distance;
    }
  }
  for (const rectangle of state.rectangles || []) {
    const points = rectanglePoints(rectangle);
    for (let i = 0; i < 4; i++) {
      const a = points[i], b = points[(i + 1) % 4];
      const distance = distToSegScreen(target.x, target.y, toScreen(a.x, a.y), toScreen(b.x, b.y));
      if (distance < bestDistance) {
        best = { kind: "segment", start: rectangle.corners[i], end: rectangle.corners[(i + 1) % 4] };
        bestDistance = distance;
      }
    }
  }
  return best;
}


function findWallByCorner(pid) {
  for (const w of state.walls) if (hasCorners(w) && w.corners.includes(pid)) return w;
  return null;
}

/* ---------- picking ---------- */
function pickPoint(w) {
  let best = null, bestD = 12 / view.scale;
  for (const p of Object.values(state.points)) {
    const d = Math.hypot(p.x - w.x, p.y - w.y);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function pickWall(w) {
  const m = 6 / view.scale;
  for (const wall of state.walls) {
    if (!hasCorners(wall)) continue;
    if (pointInWall(wall, w, m)) return wall;
  }
  return null;
}

function pickTarget(w) {
  const sx = w.x * view.scale + view.ox, sy = view.oy - w.y * view.scale;
  for (const wall of state.walls) {
    if (!hasCorners(wall)) continue;
    const axis = wallAxis(wall);
    for (const [index, end] of [
      { x: axis.ax, y: axis.ay },
      { x: axis.bx, y: axis.by },
    ].entries()) {
      const screen = toScreen(end.x, end.y);
      if (Math.hypot(sx - screen.x, sy - screen.y) < 9) {
        return {
          kind: "wall-end",
          wall: wall.id,
          end: index === 0 ? "start" : "end",
        };
      }
    }
  }
  for (const opening of state.openings || []) {
    const ends = openingEnds(opening);
    if (!ends) continue;
    for (const [index, end] of ends.entries()) {
      const screen = toScreen(end.x, end.y);
      if (Math.hypot(sx - screen.x, sy - screen.y) < 10) {
        return {
          kind: "opening",
          opening: opening.id,
          handle: index === 0 ? "start" : "end",
        };
      }
    }
    const a = toScreen(ends[0].x, ends[0].y), b = toScreen(ends[1].x, ends[1].y);
    if (distToSegScreen(sx, sy, a, b) < 8) {
      const firstDistance = Math.hypot(sx - a.x, sy - a.y);
      const secondDistance = Math.hypot(sx - b.x, sy - b.y);
      return {
        kind: "opening",
        opening: opening.id,
        handle: firstDistance < secondDistance ? "start" : "end",
      };
    }
  }
  const p = pickPoint(w);
  if (p) return { kind: "vertex", pid: p.id };
  for (const wall of state.walls) {
    if (!hasCorners(wall)) continue;
    for (const side of [1, -1]) {
      const [P, Q] = edgePts(wall, side);
      if (distToSegWorld(w, P, Q) < 7 / view.scale) {
        return { kind: "edge", wall: wall.id, side };
      }
    }
  }
  return null;
}

function targetPos(t) {
  if (t.kind === "wall-end") {
    const wall = wallsById[t.wall];
    if (!wall || !hasCorners(wall)) return null;
    const axis = wallAxis(wall);
    return t.end === "start"
      ? { x: axis.ax, y: axis.ay }
      : { x: axis.bx, y: axis.by };
  }
  if (t.kind === "vertex") {
    const p = pt(t.pid);
    return p ? { x: p.x, y: p.y } : null;
  }
  if (t.kind === "opening") {
    const opening = (state.openings || []).find(item => item.id === t.opening);
    const ends = opening && openingEnds(opening);
    return ends ? ends[t.handle === "start" ? 0 : 1] : null;
  }
  const w = wallsById[t.wall];
  if (!w || !hasCorners(w)) return null;
  const [P, Q] = edgePts(w, t.side);
  return { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 };
}

function refOf(t) {
  if (t.kind === "wall-end") return { kind: "wall-end", wall: t.wall, end: t.end };
  if (t.kind === "vertex") return { kind: "vertex", pid: t.pid };
  if (t.kind === "opening") return { kind: "opening", opening: t.opening, handle: t.handle };
  if (t.kind === "opening-length") {
    return { kind: "opening-length", opening: t.opening };
  }
  return { kind: "edge", wall: t.wall, side: t.side };
}

/* measure segment for a distance constraint: [from, to] world points */
function openingLengthRefs(c) {
  const refs = [c.a, c.b];
  const openingRefs = refs.filter(ref => ref.kind === "opening");
  if (openingRefs.length === 2
      && openingRefs[0].opening === openingRefs[1].opening
      && openingRefs[0].handle !== openingRefs[1].handle) {
    return { opening: openingRefs[0].opening };
  }
  const lengthRef = refs.find(ref => ref.kind === "opening-length");
  return lengthRef ? { opening: lengthRef.opening } : null;
}

function distMeasureWorld(c) {
  const ra = c.a, rb = c.b;
  const lengthRef = openingLengthRefs(c);
  if (lengthRef) {
    const opening = (state.openings || []).find(item => item.id === lengthRef.opening);
    const ends = opening && openingEnds(opening);
    if (!ends) return null;
    const wall = wallsById[opening.wall];
    const axis = wall && hasCorners(wall) ? wallAxis(wall) : null;
    if (!axis) return null;
    const dx = axis.bx - axis.ax, dy = axis.by - axis.ay;
    const size = Math.hypot(dx, dy) || 1;
    const ux = dx / size, uy = dy / size;
    const nx = uy, ny = -ux;
    const offset = 0.16;
    const side = (
      (c.a.kind === "opening" && c.a.handle === "start")
      || (c.b.kind === "opening" && c.b.handle === "start")
    ) ? -1 : 1;
    return ends.map(end => ({
      x: end.x + nx * offset * side,
      y: end.y + ny * offset * side,
    }));
  }
  if (
    (ra.kind === "opening" && rb.kind === "wall-end")
    || (rb.kind === "opening" && ra.kind === "wall-end")
  ) {
    const openingRef = ra.kind === "opening" ? ra : rb;
    const wallEndRef = ra.kind === "wall-end" ? ra : rb;
    const opening = (state.openings || []).find(item => item.id === openingRef.opening);
    const ends = opening && openingEnds(opening);
    const wall = wallsById[wallEndRef.wall];
    if (!ends || !wall || !hasCorners(wall)) return null;
    const axis = wallAxis(wall);
    const end = wallEndRef.end === "start"
      ? { x: axis.ax, y: axis.ay }
      : { x: axis.bx, y: axis.by };
    return [ends[openingRef.handle === "start" ? 0 : 1], end];
  }
  if (
    ra.kind === "wall-end" && rb.kind === "wall-end"
    && ra.wall === rb.wall && ra.end !== rb.end
  ) {
    const wall = wallsById[ra.wall];
    if (!wall || !hasCorners(wall)) return null;
    const axis = wallAxis(wall);
    return [{ x: axis.ax, y: axis.ay }, { x: axis.bx, y: axis.by }];
  }
  if (ra.kind !== "edge" && rb.kind !== "edge") {
    const p1 = targetPos(ra), p2 = targetPos(rb);
    if (!p1 || !p2) return null;
    return [p1, p2];
  }
  const eRef = ra.kind === "edge" ? ra : rb;
  const pRef = ra.kind === "edge" ? rb : ra;
  const w = wallsById[eRef.wall];
  if (!w || !hasCorners(w)) return null;
  const u = edgeUnit(w, eRef.side);
  if (!u) return null;
  const [P] = edgePts(w, eRef.side);
  const p = targetPos(pRef);
  if (!p) return null;
  const nx = -u.y, ny = u.x;
  const D = (p.x - P.x) * nx + (p.y - P.y) * ny;
  return [p, { x: p.x - D * nx, y: p.y - D * ny }];
}

function lineRefKey(ref) {
  return ref.kind === "wall" ? `wall:${ref.wall}` : `segment:${[ref.start, ref.end].sort().join(":")}`;
}

function linePoints(ref) {
  if (ref?.kind === "wall") {
    const wall = wallsById[ref.wall];
    if (!wall || !hasCorners(wall)) return null;
    const axis = wallAxis(wall);
    return [{ x: axis.ax, y: axis.ay }, { x: axis.bx, y: axis.by }];
  }
  if (ref?.kind === "segment") {
    const start = pt(ref.start), end = pt(ref.end);
    return start && end ? [start, end] : null;
  }
  return null;
}

function angleGeometry(c) {
  const [a1, a2] = linePoints(c.a) || [];
  const [b1, b2] = linePoints(c.b) || [];
  if (!a1 || !a2 || !b1 || !b2) return null;
  const aa = { ax: a1.x, ay: a1.y, bx: a2.x, by: a2.y };
  const ab = { ax: b1.x, ay: b1.y, bx: b2.x, by: b2.y };
  const d1x = aa.bx - aa.ax, d1y = aa.by - aa.ay;
  const d2x = ab.bx - ab.ax, d2y = ab.by - ab.ay;
  const cross = d1x * d2y - d1y * d2x;
  let anchor;
  if (Math.abs(cross) < 1e-9) {
    anchor = { x: (aa.ax + ab.ax) / 2, y: (aa.ay + ab.ay) / 2 };
  } else {
    const t = ((ab.ax - aa.ax) * d2y - (ab.ay - aa.ay) * d2x) / cross;
    anchor = { x: aa.ax + t * d1x, y: aa.ay + t * d1y };
  }
  const u1 = { x: d1x, y: d1y }, u2 = { x: d2x, y: d2y };
  const t1 = Math.atan2(u1.y, u1.x), t2 = Math.atan2(u2.y, u2.x);
  let delta = t2 - t1;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  const anchorS = toScreen(anchor.x, anchor.y);
  const mid = t1 + delta / 2;
  const label = { x: anchorS.x + Math.cos(mid) * 48, y: anchorS.y - Math.sin(mid) * 48 };
  return { anchor: anchorS, label, t1, delta, parallel: Math.abs(cross) < 1e-9 };
}

function distanceLabelPoint(c, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  if (openingLengthRefs(c)) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  return {
    x: (a.x + b.x) / 2 - dy / length * 14,
    y: (a.y + b.y) / 2 + dx / length * 14,
  };
}

function badgeLeftOfLabel(point, text) {
  ctx.font = "12px ui-monospace, monospace";
  const halfWidth = ctx.measureText(text).width / 2 + 5;
  return { x: point.x - halfWidth - 12, y: point.y };
}

function distanceBadgePoint(c, a, b) {
  return badgeLeftOfLabel(distanceLabelPoint(c, a, b), fmtLen(c.length));
}

function constraintAnchor(c) {
  if (c.type === "distance") {
    const seg = distMeasureWorld(c);
    if (!seg) return null;
    const s1 = toScreen(seg[0].x, seg[0].y), s2 = toScreen(seg[1].x, seg[1].y);
    const dx = s2.x - s1.x, dy = s2.y - s1.y;
    const length = Math.hypot(dx, dy) || 1;
    return distanceBadgePoint(c, s1, s2);
  }
  if (c.type === "angle") {
    const g = angleGeometry(c);
    return g ? badgeLeftOfLabel(g.label, fmtDeg(Math.abs(c.degrees))) : null;
  }
  if (c.type === "coincident") {
    const p = pt(c.a);
    return p ? toScreen(p.x, p.y) : null;
  }
  const points = linePoints(c.target);
  if (!points) return null;
  return toScreen((points[0].x + points[1].x) / 2, (points[0].y + points[1].y) / 2);
}

function distToSegScreen(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - a.x - t * dx, py - a.y - t * dy);
}

function pickConstraint(w) {
  if (!showC) return null;
  const sx = w.x * view.scale + view.ox, sy = view.oy - w.y * view.scale;
  let best = null, bestD = 12;
  for (const c of allVisibleConstraints()) {
    let d = Infinity;
    if (c.type === "distance") {
      const seg = distMeasureWorld(c);
      if (seg) {
        const s1 = toScreen(seg[0].x, seg[0].y), s2 = toScreen(seg[1].x, seg[1].y);
        d = distToSegScreen(sx, sy, s1, s2);
        const text = fmtLen(c.length);
        ctx.font = "12px ui-monospace, monospace";
        const halfWidth = ctx.measureText(text).width / 2 + 6;
        const labelPoint = distanceLabelPoint(c, s1, s2);
        if (Math.abs(sx - labelPoint.x) <= halfWidth && Math.abs(sy - labelPoint.y) <= 10) {
          d = 0;
        }
      }
    } else if (c.type === "angle") {
      const g = angleGeometry(c);
      if (g) {
        const badge = badgeLeftOfLabel(g.label, fmtDeg(Math.abs(c.degrees)));
        d = Math.min(
          Math.hypot(sx - g.label.x, sy - g.label.y),
          Math.hypot(sx - badge.x, sy - badge.y),
        );
      }
    } else if (c.type === "coincident") {
      for (const pid of [c.a, c.b]) {
        const p = pt(pid);
        if (p) d = Math.min(d, Math.hypot(sx - (p.x * view.scale + view.ox), sy - (view.oy - p.y * view.scale)));
      }
    } else {
      const a = constraintAnchor(c);
      if (a) d = Math.hypot(sx - a.x, sy - a.y);
    }
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/* ---------- snapping ---------- */
function coincidentSet(pid) {
  // all points transitively tied to pid by coincident constraints
  const set = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of state.constraints) {
      if (c.type === "coincident") {
        if (set.has(c.a) && !set.has(c.b)) { set.add(c.b); changed = true; }
        else if (set.has(c.b) && !set.has(c.a)) { set.add(c.a); changed = true; }
      }
    }
  }
  return set;
}

function snapWorld(w, exclude) {
  let best = null, bestD = 12 / view.scale;
  for (const p of Object.values(state.points)) {
    if (exclude && exclude.has(p.id)) continue;
    const d = Math.hypot(p.x - w.x, p.y - w.y);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best) return { x: best.x, y: best.y, pid: best.id };
  const step = gridSteps()[0];
  return {
    x: Math.round(w.x / step) * step,
    y: Math.round(w.y / step) * step,
    pid: null,
  };
}

function snapMeasurementPoint(w, enabled) {
  if (!enabled) return { x: w.x, y: w.y };
  let best = null, bestDistance = 12 / view.scale;
  for (const point of Object.values(state.points)) {
    const distance = Math.hypot(point.x - w.x, point.y - w.y);
    if (distance < bestDistance) {
      best = { x: point.x, y: point.y };
      bestDistance = distance;
    }
  }
  if (best) return best;
  const edges = [];
  for (const wall of state.walls || []) {
    if (!hasCorners(wall)) continue;
    const points = corners(wall);
    for (let index = 0; index < points.length; index++) {
      edges.push([points[index], points[(index + 1) % points.length]]);
    }
  }
  for (const rectangle of state.rectangles || []) {
    const points = rectanglePoints(rectangle);
    for (let index = 0; index < points.length; index++) {
      edges.push([points[index], points[(index + 1) % points.length]]);
    }
  }
  for (const [a, b] of edges) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / lengthSquared))
      : 0;
    const point = { x: a.x + t * dx, y: a.y + t * dy };
    const distance = Math.hypot(point.x - w.x, point.y - w.y);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best || { x: w.x, y: w.y };
}

function polygonArea(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twiceArea) / 2;
}

function polygonCentroid(points) {
  let twiceArea = 0, x = 0, y = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  if (Math.abs(twiceArea) < 1e-9) {
    return points.reduce((center, point) => ({ x: center.x + point.x / points.length, y: center.y + point.y / points.length }), { x: 0, y: 0 });
  }
  return { x: x / (3 * twiceArea), y: y / (3 * twiceArea) };
}

function polygonLabelPoint(points) {
  const centroid = polygonCentroid(points);
  if (pointInPolygon(centroid, points)) return centroid;
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  let best = points[0], bestDistance = -1;
  for (let xIndex = 0; xIndex <= 20; xIndex++) {
    for (let yIndex = 0; yIndex <= 20; yIndex++) {
      const candidate = { x: minX + (maxX - minX) * xIndex / 20, y: minY + (maxY - minY) * yIndex / 20 };
      if (!pointInPolygon(candidate, points)) continue;
      const distance = points.reduce((minimum, point, index) => Math.min(minimum,
        distToSegWorld(candidate, point, points[(index + 1) % points.length])), Infinity);
      if (distance > bestDistance) { best = candidate; bestDistance = distance; }
    }
  }
  return best;
}

function pointInPolygon(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > point.y) !== (b.y > point.y)
        && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function pickMeasurement(w) {
  for (let index = measurements.length - 1; index >= 0; index--) {
    const item = measurements[index];
    if (item.kind === "area" && (pointInPolygon(w, item.points) || item.points.some((point, edge) =>
      distToSegScreen(w.x * view.scale + view.ox, view.oy - w.y * view.scale,
        toScreen(point.x, point.y), toScreen(item.points[(edge + 1) % item.points.length].x, item.points[(edge + 1) % item.points.length].y)) <= 8))) return item;
    if (item.kind === "distance" && distToSegScreen(
      w.x * view.scale + view.ox, view.oy - w.y * view.scale,
      toScreen(item.points[0].x, item.points[0].y), toScreen(item.points[1].x, item.points[1].y),
    ) <= 8) return item;
  }
  return null;
}

/* ---------- transforms ---------- */
function toScreen(x, y) {
  return { x: x * view.scale + view.ox, y: view.oy - y * view.scale };
}

function toWorld(px, py) {
  return { x: (px - view.ox) / view.scale, y: (view.oy - py) / view.scale };
}

function eventWorld(e) {
  const r = canvas.getBoundingClientRect();
  return toWorld(e.clientX - r.left, e.clientY - r.top);
}

/* ---------- rendering ---------- */
const GLYPHS = {
  distance: "↔", angle: "∠", coincident: "≡",
  horizontal: "─", vertical: "│",
};
const COLORS = {
  distance: "#6cd0ff", angle: "#a78bfa", coincident: "#a78bfa",
  horizontal: "#7ec8a5", vertical: "#7ec8a5",
};

function gridSteps() {
  if (view.scale >= 40) return [0.1, 1];
  if (view.scale >= 8) return [1, 5];
  return [5, 25];
}

function rectangleRenderPoints(rectangle) {
  if (symbolResizePreview?.symbolId === rectangle.symbol) {
    return symbolResizePreview.instances.get(rectangle.id) || rectanglePoints(rectangle);
  }
  return rectanglePoints(rectangle);
}

function updateSymbolResizePreview(rectangle, corners) {
  const symbol = state.symbols.find(item => item.id === rectangle?.symbol);
  if (!symbol) {
    symbolResizePreview = null;
    return;
  }
  const p0 = corners[0], p1 = corners[1], p3 = corners[3];
  const width = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const height = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const instances = new Map();
  const initialInstances = symbolResizePreview?.symbolId === symbol.id
    ? symbolResizePreview.initialInstances
    : new Map(state.rectangles
      .filter(instance => instance.symbol === symbol.id)
      .map(instance => [instance.id, rectanglePoints(instance).map(point => ({ x: point.x, y: point.y }))]));
  for (const instance of state.rectangles) {
    if (instance.symbol !== symbol.id) continue;
    if (instance.id === rectangle.id) {
      instances.set(instance.id, corners);
      continue;
    }
    const points = initialInstances.get(instance.id) || rectanglePoints(instance);
    const oldWidth = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
    const oldHeight = Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y);
    if (!oldWidth || !oldHeight) continue;
    const u = { x: (points[1].x - points[0].x) / oldWidth, y: (points[1].y - points[0].y) / oldWidth };
    const v = { x: (points[3].x - points[0].x) / oldHeight, y: (points[3].y - points[0].y) / oldHeight };
    const center = { x: (points[0].x + points[2].x) / 2, y: (points[0].y + points[2].y) / 2 };
    const origin = {
      x: center.x - (width * u.x + height * v.x) / 2,
      y: center.y - (width * u.y + height * v.y) / 2,
    };
    instances.set(instance.id, [
      origin,
      { x: origin.x + width * u.x, y: origin.y + width * u.y },
      { x: origin.x + width * u.x + height * v.x, y: origin.y + width * u.y + height * v.y },
      { x: origin.x + height * v.x, y: origin.y + height * v.y },
    ]);
  }
  for (const instance of state.rectangles) {
    if (instance.symbol !== symbol.id) continue;
    const preview = instances.get(instance.id);
    if (!preview) continue;
    instance.corners.forEach((pid, index) => {
      state.points[pid] = { ...state.points[pid], id: pid, x: preview[index].x, y: preview[index].y };
    });
  }
  symbolResizePreview = {
    symbolId: symbol.id,
    width,
    height,
    instances,
    initialInstances,
    sourceId: rectangle.id,
    sourceCorners: corners,
  };
}

function allVisibleConstraints() {
  const shared = [];
  for (const rectangle of state.rectangles || []) {
    const symbol = (state.symbols || []).find(item => item.id === rectangle.symbol);
    if (!symbol) continue;
    for (const template of symbol.constraints || []) {
      const expanded = JSON.parse(JSON.stringify(template));
      expanded.instance = rectangle.id;
      if (expanded.type === "angle") {
        for (const ref of [expanded.a, expanded.b]) {
          if (ref.kind === "segment") {
            ref.start = rectangle.corners[ref.start_corner];
            ref.end = rectangle.corners[ref.end_corner];
          }
        }
      } else if (expanded.type === "horizontal" || expanded.type === "vertical") {
        const ref = expanded.target;
        if (ref.kind === "segment") {
          ref.start = rectangle.corners[ref.start_corner];
          ref.end = rectangle.corners[ref.end_corner];
        }
      } else if (expanded.type === "distance") {
        for (const ref of [expanded.a, expanded.b]) {
          if (ref.kind === "vertex" && ref.corner != null) {
            ref.pid = rectangle.corners[ref.corner];
          }
        }
      } else if (expanded.type === "coincident") {
        expanded.a = rectangle.corners[expanded.a];
        expanded.b = rectangle.corners[expanded.b];
      }
      shared.push(expanded);
    }
  }
  return [...(state.constraints || []), ...shared];
}

function draw() {
  const w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#14181f";
  ctx.fillRect(0, 0, w, h);
  drawGrid(w, h);
  if (showC) {
    for (const c of allVisibleConstraints()) {
      if (c.type === "coincident") drawCoincident(c);
      else if (c.type === "angle") drawAngle(c);
    }
  }
  drawWalls();
  if (showC) {
    for (const c of allVisibleConstraints()) {
      if (c.type === "distance") drawDistance(c);
    }
    for (const c of allVisibleConstraints()) drawBadge(c);
  }
  drawRectangles();
  drawOpenings();
  drawMeasurements();
  drawPreview();
  drawHover();
}

function drawGrid(w, h) {
  const [minor, major] = gridSteps();
  const wLeft = (0 - view.ox) / view.scale;
  const wRight = (w - view.ox) / view.scale;
  const wBottom = (view.oy - h) / view.scale;
  const wTop = view.oy / view.scale;
  const iStart = Math.ceil(wLeft / minor - 1e-9);
  const iEnd = Math.floor(wRight / minor + 1e-9);
  const jStart = Math.ceil(wBottom / minor - 1e-9);
  const jEnd = Math.floor(wTop / minor + 1e-9);
  const ratio = Math.round(major / minor);
  ctx.lineWidth = 1;
  for (let i = iStart; i <= iEnd; i++) {
    const sx = Math.round(i * minor * view.scale + view.ox) + 0.5;
    const isMajor = ((i % ratio) + ratio) % ratio === 0;
    ctx.strokeStyle = isMajor ? "#26303f" : "#1c222c";
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
    ctx.stroke();
  }
  for (let j = jStart; j <= jEnd; j++) {
    const sy = Math.round(view.oy - j * minor * view.scale) + 0.5;
    const isMajor = ((j % ratio) + ratio) % ratio === 0;
    ctx.strokeStyle = isMajor ? "#26303f" : "#1c222c";
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
    ctx.stroke();
  }
}

function line2(a, b) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawWalls() {
  for (const w of state.walls) {
    if (!hasCorners(w)) continue;
    const cs = corners(w);
    const sel = selection && selection.kind === "wall" && selection.id === w.id;
    const hov = hover && hover.kind === "wall" && hover.id === w.id;
    ctx.strokeStyle = sel ? "#ffb454" : hov ? "#e8eef6" : "#d7dee8";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cs[0].x * view.scale + view.ox, view.oy - cs[0].y * view.scale);
    for (const c of [cs[1], cs[2], cs[3], cs[0]]) {
      ctx.lineTo(c.x * view.scale + view.ox, view.oy - c.y * view.scale);
    }
    ctx.stroke();
    ctx.fillStyle = sel ? "#ffb454" : "#d7dee8";
    for (const c of cs) {
      const s = toScreen(c.x, c.y);
      ctx.fillRect(s.x - 2.5, s.y - 2.5, 5, 5);
    }
  }
}

function drawRectangles() {
  for (const rectangle of state.rectangles || []) {
    const corners = rectangleRenderPoints(rectangle);
    if (corners.length !== 4) continue;
    const points = corners.map(p => toScreen(p.x, p.y));
    const selected = selection?.kind === "rectangle" && selection.id === rectangle.id;
    const hovered = hover?.kind === "rectangle" && hover.id === rectangle.id;
    ctx.strokeStyle = selected ? "#ffb454" : hovered ? "#e8eef6" : "#9ad9bc";
    ctx.lineWidth = selected ? 2.5 : 2;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const p of [...points.slice(1), points[0]]) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fillStyle = selected ? "rgba(255,180,84,0.16)" : "rgba(126,200,165,0.06)";
    ctx.fill();
    ctx.stroke();
    if (selected) {
      ctx.fillStyle = "#ffb454";
      ctx.strokeStyle = "#14181f";
      ctx.lineWidth = 1;
      for (const point of points) {
        ctx.beginPath();
        ctx.rect(point.x - 4, point.y - 4, 8, 8);
        ctx.fill();
        ctx.stroke();
      }
    }
    const symbol = (state.symbols || []).find(item => item.id === rectangle.symbol);
    if (symbol) {
      const bounds = rectBounds(rectangle);
      const center = toScreen((bounds.x1 + bounds.x2) / 2, (bounds.y1 + bounds.y2) / 2);
      label(center.x, center.y, symbol.label, "#7ec8a5");
    }
  }
}

function drawOpenings() {
  for (const opening of state.openings || []) {
    const ends = openingEnds(opening);
    if (!ends) continue;
    const selected = selection?.kind === "opening" && selection.id === opening.id;
    const hovered = hover?.kind === "opening" && hover.id === opening.id;
    ctx.strokeStyle = selected ? "#ffb454" : hovered ? "#6cd0ff" : "#f0c674";
    ctx.lineWidth = selected ? 5 : 4;
    const start = toScreen(ends[0].x, ends[0].y), end = toScreen(ends[1].x, ends[1].y);
    line2(start, end);
    const hasLengthDimension = state.constraints.some(c => openingLengthRefs(c)?.opening === opening.id);
    if (!hasLengthDimension) {
      label((start.x + end.x) / 2, (start.y + end.y) / 2 - 12, fmtLen(opening.length), "#f0c674");
    }
    if (selected) {
      ctx.fillStyle = "#ffb454";
      for (const end of ends) {
        const p = toScreen(end.x, end.y);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function arrowHead(from, to, col) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(from.x - 8 * Math.cos(ang - 0.35), from.y - 8 * Math.sin(ang - 0.35));
  ctx.lineTo(from.x - 8 * Math.cos(ang + 0.35), from.y - 8 * Math.sin(ang + 0.35));
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.fill();
}

function drawDistance(c) {
  const seg = distMeasureWorld(c);
  if (!seg) return;
  const s1 = toScreen(seg[0].x, seg[0].y), s2 = toScreen(seg[1].x, seg[1].y);
  const sel = selection && selection.kind === "constraint" && selection.id === c.id;
  const col = sel ? "#ffb454" : "#6cd0ff";
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.5;
  const lengthRef = openingLengthRefs(c);
  if (lengthRef) {
    const opening = (state.openings || []).find(item => item.id === lengthRef.opening);
    const ends = opening && openingEnds(opening);
    const host = opening && wallsById[opening.wall];
    const dimensionEnds = distMeasureWorld(c);
    if (ends && dimensionEnds && host && hasCorners(host)) {
      for (let i = 0; i < 2; i++) {
        const source = toScreen(ends[i].x, ends[i].y);
        const offset = toScreen(dimensionEnds[i].x, dimensionEnds[i].y);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        line2(source, offset);
        ctx.setLineDash([]);
      }
    }
  }
  line2(s1, s2);
  arrowHead(s1, s2, col);
  arrowHead(s2, s1, col);
  const mx = (s1.x + s2.x) / 2, my = (s1.y + s2.y) / 2;
  const labelPoint = distanceLabelPoint(c, s1, s2);
  label(labelPoint.x, labelPoint.y, fmtLen(c.length), col);
}

function drawAngle(c) {
  const g = angleGeometry(c);
  if (!g) return;
  const sel = selection && selection.kind === "constraint" && selection.id === c.id;
  const col = sel ? "#ffb454" : "#a78bfa";
  for (const ref of [c.a, c.b]) {
    const points = linePoints(ref);
    if (!points) continue;
    const d = { x: points[1].x - points[0].x, y: points[1].y - points[0].y };
    const L = Math.hypot(d.x, d.y);
    if (L < 1e-9) continue;
    const ux = d.x / L, uy = d.y / L;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(g.anchor.x, g.anchor.y);
    ctx.lineTo(g.anchor.x + ux * 34, g.anchor.y - uy * 34);
    ctx.stroke();
  }
  if (!g.parallel) {
    const s1 = -g.t1, s2 = -(g.t1 + g.delta);
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(g.anchor.x, g.anchor.y, 30, s1, s2, g.delta > 0);
    ctx.stroke();
  }
  label(g.label.x, g.label.y, fmtDeg(Math.abs(c.degrees)), col);
}

function drawCoincident(c) {
  const sel = selection && selection.kind === "constraint" && selection.id === c.id;
  const col = sel ? "#ffb454" : "#a78bfa";
  const p1 = pt(c.a), p2 = pt(c.b);
  if (!p1 || !p2) return;
  const s1 = toScreen(p1.x, p1.y), s2 = toScreen(p2.x, p2.y);
  if (Math.hypot(s2.x - s1.x, s2.y - s1.y) > 2) {
    ctx.strokeStyle = col;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    line2(s1, s2);
    ctx.setLineDash([]);
  }
  for (const s of [s1, s2]) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function drawBadgeAt(anchor, type, color) {
  ctx.beginPath();
  ctx.arc(anchor.x, anchor.y, 8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(20,24,31,0.92)";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = "9px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(GLYPHS[type] || "?", anchor.x, anchor.y + 0.5);
}

function drawBadge(c) {
  const anchor = constraintAnchor(c);
  if (!anchor) return;
  const selected = selection && selection.kind === "constraint" && selection.id === c.id;
  drawBadgeAt(anchor, c.type, selected ? "#ffb454" : COLORS[c.type]);
}

function label(x, y, text, color) {
  ctx.font = "12px ui-monospace, monospace";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(20,24,31,0.92)";
  ctx.strokeStyle = "rgba(207,216,227,0.25)";
  ctx.lineWidth = 1;
  roundRect(x - w / 2 - 5, y - 9, w + 10, 18, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawMeasurements() {
  for (const measurement of measurements) {
    const selected = selection?.kind === "measurement" && selection.id === measurement.id;
    const color = selected ? "#ffb454" : "#f0c674";
    const points = measurement.points.map(point => toScreen(point.x, point.y));
    if (measurement.kind === "area") {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.closePath();
      ctx.fillStyle = selected ? "rgba(255,180,84,0.22)" : "rgba(240,198,116,0.16)";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 2 : 1.5;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      const center = polygonLabelPoint(measurement.points);
      const screen = toScreen(center.x, center.y);
      label(screen.x, screen.y, `${measurement.area.toFixed(2)} m²`, color);
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 1.5 : 1;
      ctx.setLineDash([5, 4]);
      line2(points[0], points[1]);
      ctx.setLineDash([]);
      label((points[0].x + points[1].x) / 2, (points[0].y + points[1].y) / 2 - 14,
        fmtLen(Math.hypot(measurement.points[1].x - measurement.points[0].x, measurement.points[1].y - measurement.points[0].y)), color);
    }
  }
}

function drawPreview() {
  if ((tool === "area" || tool === "measure-distance") && mouse.inside && pending.length) {
    const point = tool === "area"
      ? snapWorld({ x: mouse.wx, y: mouse.wy })
      : snapMeasurementPoint({ x: mouse.wx, y: mouse.wy }, mouse.shiftKey);
    if (tool === "area") {
      const points = [...pending, point].map(vertex => toScreen(vertex.x, vertex.y));
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const vertex of points.slice(1)) ctx.lineTo(vertex.x, vertex.y);
      if (pending.length >= 2) ctx.closePath();
      ctx.strokeStyle = "rgba(240,198,116,0.75)";
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      if (pending.length >= 2) {
        const area = polygonArea([...pending, point]);
        const center = polygonLabelPoint([...pending, point]);
        const screen = toScreen(center.x, center.y);
        label(screen.x, screen.y, `${area.toFixed(2)} m²`, "#f0c674");
      }
    } else {
      const start = toScreen(pending[0].x, pending[0].y), end = toScreen(point.x, point.y);
      ctx.strokeStyle = "rgba(240,198,116,0.8)";
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      line2(start, end);
      ctx.setLineDash([]);
      label((start.x + end.x) / 2, (start.y + end.y) / 2 - 14,
        fmtLen(Math.hypot(point.x - pending[0].x, point.y - pending[0].y)), "#f0c674");
    }
  }
  if (tool === "wall-path" && pending.length && mouse.inside) {
    const vertices = pending.map(point => ({ x: point.x, y: point.y }));
    vertices.push(snapWorld({ x: mouse.wx, y: mouse.wy }));
    const normals = [];
    for (let index = 0; index < vertices.length - 1; index++) {
      const a = vertices[index], b = vertices[index + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      normals.push({ x: -dy / length, y: dx / length });
    }
    const area = vertices.slice(0, -1).reduce((sum, point, index) => {
      const next = vertices[index + 1];
      return sum + point.x * next.y - next.x * point.y;
    }, 0);
    const side = area >= 0 ? 1 : -1;
    const offsetPoints = vertices.map((vertex, index) => {
      const previous = normals[Math.max(0, index - 1)];
      const next = normals[Math.min(normals.length - 1, index)];
      let nx = previous.x + next.x, ny = previous.y + next.y;
      const norm = Math.hypot(nx, ny) || 1;
      nx /= norm;
      ny /= norm;
      const denom = Math.abs(nx * next.x + ny * next.y) || 1;
      const distance = side * wallThickness / 2 / denom;
      return toScreen(vertex.x + nx * distance, vertex.y + ny * distance);
    });
    ctx.strokeStyle = "rgba(108,208,255,0.8)";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    for (let index = 0; index < offsetPoints.length - 1; index++) {
      line2(offsetPoints[index], offsetPoints[index + 1]);
    }
    ctx.setLineDash([]);
  }
  if (tool === "cut" && mouse.inside) {
    const wall = pickWall({ x: mouse.wx, y: mouse.wy });
    if (wall) {
      const station = projectOpening({ x: mouse.wx, y: mouse.wy }, wall);
      const axis = wallAxis(wall);
      const dx = axis.bx - axis.ax, dy = axis.by - axis.ay;
      const length = Math.hypot(dx, dy) || 1;
      const marker = toScreen(axis.ax + dx / length * station, axis.ay + dy / length * station);
      ctx.strokeStyle = "#ffb454";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(marker.x - 7, marker.y - 7);
      ctx.lineTo(marker.x + 7, marker.y + 7);
      ctx.moveTo(marker.x - 7, marker.y + 7);
      ctx.lineTo(marker.x + 7, marker.y - 7);
      ctx.stroke();
    }
  }
  if (((tool === "rectangle" && pending.length === 1) || symbolPlacement) && mouse.inside) {
    let bounds;
    if (symbolPlacement) {
      const center = snapWorld({ x: mouse.wx, y: mouse.wy });
      bounds = {
        x1: center.x - symbolPlacement.width / 2,
        y1: center.y - symbolPlacement.height / 2,
        x2: center.x + symbolPlacement.width / 2,
        y2: center.y + symbolPlacement.height / 2,
      };
    } else {
      const start = pending[0];
      const end = snapWorld({ x: mouse.wx, y: mouse.wy });
      bounds = {
        x1: Math.min(start.x, end.x),
        y1: Math.min(start.y, end.y),
        x2: Math.max(start.x, end.x),
        y2: Math.max(start.y, end.y),
      };
    }
    const points = [
      { x: bounds.x1, y: bounds.y1 },
      { x: bounds.x2, y: bounds.y1 },
      { x: bounds.x2, y: bounds.y2 },
      { x: bounds.x1, y: bounds.y2 },
    ].map(p => toScreen(p.x, p.y));
    ctx.strokeStyle = "rgba(126,200,165,0.8)";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const p of [...points.slice(1), points[0]]) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (tool === "wall-path" && mouse.inside && hover?.kind === "point") {
    const point = state.points[hover.id];
    if (point) {
      const screen = toScreen(point.x, point.y);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, 8, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(108,208,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  if ((tool === "dim" || tool === "coincident") && mouse.inside) {
    const target = pickTarget({ x: mouse.wx, y: mouse.wy });
    if (target && target.kind === "vertex") {
      const point = targetPos(target);
      if (point) {
        const screen = toScreen(point.x, point.y);
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 8, 0, Math.PI * 2);
        ctx.strokeStyle = tool === "dim" ? "rgba(108,208,255,0.9)" : "rgba(167,139,250,0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
  if (tool === "opening" && pending.length === 1 && mouse.inside) {
    const wall = wallsById[pending[0].wall];
    if (!wall || !hasCorners(wall)) return;
    const end = projectOpening({ x: mouse.wx, y: mouse.wy }, wall);
    if (end == null || Math.abs(end - pending[0].station) < 0.01) return;
    const axis = wallAxis(wall);
    const dir = axisDir(wall);
    const length = Math.hypot(dir.x, dir.y);
    const ux = dir.x / length, uy = dir.y / length;
    const a = toScreen(axis.ax + ux * pending[0].station, axis.ay + uy * pending[0].station);
    const b = toScreen(axis.ax + ux * end, axis.ay + uy * end);
    ctx.strokeStyle = "rgba(240,198,116,0.8)";
    ctx.lineWidth = 4;
    line2(a, b);
  }
  if (tool === "wall" && pending.length === 1 && mouse.inside) {
    const s = snapWorld({ x: mouse.wx, y: mouse.wy });
    const a = pending[0];
    if (Math.hypot(s.x - a.x, s.y - a.y) < 1e-9) return;
    // rectangle preview around the raw axis
    const dx = s.x - a.x, dy = s.y - a.y;
    const L = Math.hypot(dx, dy);
    const nx = -dy / L, ny = dx / L, h = wallThickness / 2;
    const quad = [
      { x: a.x + h * nx, y: a.y + h * ny },
      { x: a.x - h * nx, y: a.y - h * ny },
      { x: s.x - h * nx, y: s.y - h * ny },
      { x: s.x + h * nx, y: s.y + h * ny },
    ].map(c => toScreen(c.x, c.y));
    ctx.strokeStyle = "rgba(108,208,255,0.7)";
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (const q of [quad[1], quad[2], quad[3], quad[0]]) ctx.lineTo(q.x, q.y);
    ctx.stroke();
    ctx.setLineDash([]);
    const deg = Math.atan2(dy, dx) * 180 / Math.PI;
    label((quad[0].x + quad[3].x) / 2, (quad[0].y + quad[3].y) / 2 - 16,
      `${fmtLen(L)} ∠${fmtDeg(deg)}`, "#6cd0ff");
  }
  if (tool === "dim" && pending.length === 1 && mouse.inside) {
    const p = targetPos(pending[0]);
    if (!p) return;
    const s = toScreen(p.x, p.y);
    ctx.strokeStyle = "rgba(108,208,255,0.5)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(mouse.sx, mouse.sy);
    ctx.stroke();
    ctx.setLineDash([]);
    label((s.x + mouse.sx) / 2, (s.y + mouse.sy) / 2 - 16,
      fmtLen(Math.hypot(mouse.wx - p.x, mouse.wy - p.y)), "#6cd0ff");
  }
  if (tool === "coincident" && pending.length === 1 && mouse.inside) {
    const p = pt(pending[0].pid);
    if (!p) return;
    const s = toScreen(p.x, p.y);
    ctx.strokeStyle = "rgba(167,139,250,0.5)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(mouse.sx, mouse.sy);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawHover() {
  if (!hover) return;
  if (hover.kind === "measurement") {
    const measurement = measurements.find(item => item.id === hover.id);
    if (measurement) {
      ctx.strokeStyle = "rgba(240,198,116,0.8)";
      ctx.lineWidth = 2;
      if (measurement.kind === "area") {
        const points = measurement.points.map(point => toScreen(point.x, point.y));
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
        ctx.closePath();
        ctx.stroke();
      } else {
        line2(toScreen(measurement.points[0].x, measurement.points[0].y), toScreen(measurement.points[1].x, measurement.points[1].y));
      }
    }
  } else if (hover.kind === "opening-handle") {
    const [openingId, handle] = hover.id.split(":");
    const opening = (state.openings || []).find(item => item.id === openingId);
    const ends = opening && openingEnds(opening);
    if (!ends) return;
    const p = toScreen(ends[handle === "start" ? 0 : 1].x, ends[handle === "start" ? 0 : 1].y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.strokeStyle = "#6cd0ff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else if (hover.kind === "rectangle") {
    const rectangle = (state.rectangles || []).find(item => item.id === hover.id);
    if (!rectangle) return;
    ctx.strokeStyle = "rgba(126,200,165,0.8)";
    ctx.lineWidth = 4;
    const points = rectanglePoints(rectangle).map(p => toScreen(p.x, p.y));
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const p of [...points.slice(1), points[0]]) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (hover.kind === "opening-length") {
    const opening = (state.openings || []).find(item => item.id === hover.id);
    const ends = opening && openingEnds(opening);
    if (!ends) return;
    ctx.strokeStyle = "rgba(108,208,255,0.8)";
    ctx.lineWidth = 6;
    line2(toScreen(ends[0].x, ends[0].y), toScreen(ends[1].x, ends[1].y));
  } else if (hover.kind === "point") {
    const p = pt(hover.id);
    if (!p) return;
    const s = toScreen(p.x, p.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
    ctx.strokeStyle = "#6cd0ff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else if (hover.kind === "wall") {
    const w = wallsById[hover.id];
    if (!w || !hasCorners(w)) return;
    const cs = corners(w);
    ctx.strokeStyle = "rgba(255,180,84,0.35)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cs[0].x * view.scale + view.ox, view.oy - cs[0].y * view.scale);
    for (const c of [cs[1], cs[2], cs[3], cs[0]]) {
      ctx.lineTo(c.x * view.scale + view.ox, view.oy - c.y * view.scale);
    }
    ctx.stroke();
  } else if (hover.kind === "wall-end") {
    const target = targetPos({ kind: "wall-end", wall: hover.wall, end: hover.end });
    if (!target) return;
    const point = toScreen(target.x, target.y);
    ctx.beginPath();
    ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
    ctx.strokeStyle = "#6cd0ff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else if (hover.kind === "edge") {
    const w = wallsById[hover.wall];
    if (!w || !hasCorners(w)) return;
    const [P, Q] = edgePts(w, hover.side);
    ctx.strokeStyle = "rgba(108,208,255,0.6)";
    ctx.lineWidth = 3;
    line2(toScreen(P.x, P.y), toScreen(Q.x, Q.y));
  }
}

/* ---------- interaction ---------- */
function setTool(t) {
  if (tool !== t) hover = null;
  tool = t;
  pending = [];
  if (!symbolPlacement && t !== "rectangle") rectangleGesture = null;
  if (t !== "rectangle") symbolPlacement = null;
  for (const b of document.querySelectorAll("[data-tool]")) {
    b.classList.toggle("active", b.dataset.tool === t);
  }
  hintEl.classList.remove("error");
  hintEl.textContent = HINTS[t] || "";
  draw();
}

const HINTS = {
  select: "Drag corners or walls · drag opening ends to resize or its middle to move · right-drag rotates walls",
  wall: "Click two axis points; snapping to a corner creates a coincident constraint (Esc cancels)",
  "wall-path": "Click path vertices; Enter closes a polygon, double-click finishes an open path, Esc cancels",
  cut: "Click a wall to split it at that position (Esc cancels)",
  opening: "Click two points along a wall axis to create an opening (Esc cancels)",
  dim: "Click two targets (opening segment or handle, corner, wall edge, or wall axis end)",
  area: "Click polygon vertices; click near the first point to close, or press Enter (Esc cancels)",
  "measure-distance": "Click two points to measure; hold Shift to snap to corners or wall edges (Esc cancels)",
  angle: "Click two wall axes or rectangle sides, then enter the angle",
  coincident: "Click two wall corners to make them coincident",
  horizontal: "Click a wall axis or rectangle side to make it horizontal",
  vertical: "Click a wall axis or rectangle side to make it vertical",
};

function flash(msg) {
  hintEl.textContent = msg;
  hintEl.classList.add("error");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    hintEl.classList.remove("error");
    hintEl.textContent = HINTS[tool] || "";
  }, 3500);
}

function sendDrag(pointsMap, force, preserveLengths) {
  const now = performance.now();
  if (!force && now - lastDragSend < 33) return;
  lastDragSend = now;
  const op = { op: "drag", points: pointsMap };
  if (preserveLengths && Object.keys(preserveLengths).length) {
    op.preserve_lengths = preserveLengths;
  }
  send(op);
}

function updateHover(w) {
  if (tool === "cut") {
    const wall = pickWall(w);
    hover = wall ? { kind: "wall", id: wall.id } : null;
  } else if (tool === "wall-path") {
    const target = pickWallPathCorner(w);
    hover = target ? { kind: "point", id: target.pid } : null;
  } else if (tool === "measure-distance" || tool === "area") {
    const measurement = pickMeasurement(w);
    hover = measurement ? { kind: "measurement", id: measurement.id } : null;
  } else if (tool === "dim") {
    const target = pickTarget(w);
    if (!target) hover = null;
    else if (target.kind === "opening") {
      hover = { kind: "opening-handle", id: `${target.opening}:${target.handle}` };
    } else if (target.kind === "opening-length") {
      hover = { kind: "opening-length", id: target.opening };
    } else if (target.kind === "wall-end") {
      hover = { kind: "wall-end", wall: target.wall, end: target.end };
    } else if (target.kind === "edge") {
      hover = { kind: "edge", wall: target.wall, side: target.side };
    } else {
      hover = { kind: "point", id: target.pid };
    }
  } else if (tool === "select") {
    const measurement = pickMeasurement(w);
    const rectangle = measurement ? null : pickRectangle(w);
    if (measurement) hover = { kind: "measurement", id: measurement.id };
    else if (rectangle) hover = { kind: "rectangle", id: rectangle.id };
    else {
      const opening = pickOpening(w);
      if (opening) hover = { kind: "opening", id: opening.id };
      else {
        const p = pickPoint(w);
        if (p) hover = { kind: "point", id: p.id };
        else {
          const wall = pickWall(w);
          hover = wall ? { kind: "wall", id: wall.id } : null;
        }
      }
    }
  } else if (tool === "rectangle" || tool === "select") {
    const rectangle = pickRectangle(w);
    hover = rectangle ? { kind: "rectangle", id: rectangle.id } : null;
  } else if (tool === "opening") {
    const wall = pickWall(w);
    hover = wall ? { kind: "wall", id: wall.id } : null;
  } else {
    const wall = pickWall(w);
    hover = wall ? { kind: "wall", id: wall.id } : null;
  }
  canvas.style.cursor = tool === "select" ? (hover ? "move" : "default") : "crosshair";
}

canvas.addEventListener("dblclick", (e) => {
  if (tool === "wall-path") {
    e.preventDefault();
    if (pending.length < 2) {
      flash("an open wall path needs at least two points");
      return;
    }
    send({
      op: "add_wall_path",
      vertices: pending.map(point => [point.x, point.y]),
      joins: pending.map(point => point.pid),
      closed: false,
      thickness: wallThickness,
    });
    pending = [];
    draw();
    return;
  }
  if (!dialogEl.hidden || tool !== "select") return;
  const c = pickConstraint(eventWorld(e));
  if (!c) return;
  e.preventDefault();
  selection = { kind: "constraint", id: c.id };
  syncPanel();
  draw();
  editConstraint(c);
});

canvas.addEventListener("pointerdown", (e) => {
  if (!dialogEl.hidden) return;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  const w = eventWorld(e);
  if (e.button === 1) {
    // middle-drag always pans
    pan = { sx: e.clientX, sy: e.clientY, ox: view.ox, oy: view.oy };
    e.preventDefault();
    return;
  }
  if (e.button === 2) {
    let rectangle = tool === "select" ? pickRectangle(w) : null;
    let wall = null;
    if (!rectangle && tool === "select") {
      if (selection && selection.kind === "wall") wall = wallsById[selection.id];
      if (!wall || !hasCorners(wall)) wall = pickWall(w);
    }
    if (rectangle) {
      selection = { kind: "rectangle", id: rectangle.id };
      syncPanel();
      const points = rectanglePoints(rectangle);
      const pivot = {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      };
      const reference = Math.hypot(w.x - pivot.x, w.y - pivot.y) > 0.02
        ? w
        : points[1];
      rotate = {
        id: rectangle.id,
        kind: "rectangle",
        pids: [...rectangle.corners],
        orig: points.map(point => ({ x: point.x, y: point.y })),
        pivot,
        startAng: Math.atan2(reference.y - pivot.y, reference.x - pivot.x),
      };
      draw();
    } else if (wall && hasCorners(wall)) {
      if (!selection || selection.id !== wall.id) {
        selection = { kind: "wall", id: wall.id };
        syncPanel();
      }
      const cs = corners(wall);
      const pivot = {
        x: (cs[0].x + cs[1].x + cs[2].x + cs[3].x) / 4,
        y: (cs[0].y + cs[1].y + cs[2].y + cs[3].y) / 4,
      };
      const TH = 0.02;
      const startAng = Math.hypot(w.x - pivot.x, w.y - pivot.y) > TH
        ? Math.atan2(w.y - pivot.y, w.x - pivot.x)
        : Math.atan2(cs[3].y - cs[0].y, cs[3].x - cs[0].x);
      rotate = {
        id: wall.id,
        kind: "wall",
        pids: [...wall.corners],
        orig: cs.map(c => ({ x: c.x, y: c.y })),
        pivot,
        startAng,
      };
      draw();
    } else {
      pan = { sx: e.clientX, sy: e.clientY, ox: view.ox, oy: view.oy };
    }
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;

  if (tool === "area") {
    const point = snapWorld(w);
    if (pending.length >= 3 && Math.hypot(point.x - pending[0].x, point.y - pending[0].y) < 0.08) {
      const area = polygonArea(pending);
      if (area > 1e-6) {
        measurements.push({ id: nextMeasurementId++, kind: "area", points: pending.map(vertex => ({ x: vertex.x, y: vertex.y })), area });
      }
      pending = [];
      selection = null;
      draw();
      return;
    }
    if (pending.length && Math.hypot(point.x - pending[pending.length - 1].x, point.y - pending[pending.length - 1].y) < 0.01) return;
    pending.push({ x: point.x, y: point.y });
    draw();
    return;
  }
  if (tool === "measure-distance") {
    const point = snapMeasurementPoint(w, e.shiftKey);
    if (!pending.length) {
      pending.push(point);
      draw();
      return;
    }
    const start = pending[0];
    if (Math.hypot(point.x - start.x, point.y - start.y) < 1e-9) return;
    measurements.push({ id: nextMeasurementId++, kind: "distance", points: [start, point] });
    pending = [];
    selection = null;
    draw();
    return;
  }
  if (tool === "wall-path") {
    const point = snapWorld(w);
    if (pending.length > 2 && Math.hypot(
      point.x - pending[0].x,
      point.y - pending[0].y,
    ) < 0.05) {
      send({
        op: "add_wall_path",
        vertices: pending.map(p => [p.x, p.y]),
        joins: pending.map(p => p.pid),
        closed: true,
        thickness: wallThickness,
      });
      pending = [];
      return;
    }
    if (pending.length && Math.hypot(point.x - pending[pending.length - 1].x, point.y - pending[pending.length - 1].y) < 0.01) return;
    const join = pickWallPathCorner(w);
    pending.push({ x: point.x, y: point.y, pid: join?.id ?? null });
    return;
  }
  if (tool === "cut") {
    const wall = pickWall(w);
    if (!wall) { flash("click a wall to split"); return; }
    send({ op: "cut_wall", id: wall.id, station: projectOpening(w, wall) });
    return;
  }

  if (symbolPlacement) {
    const center = snapWorld(w);
    send({
      op: "add_rectangle",
      x1: center.x - symbolPlacement.width / 2,
      y1: center.y - symbolPlacement.height / 2,
      x2: center.x + symbolPlacement.width / 2,
      y2: center.y + symbolPlacement.height / 2,
      symbol: symbolPlacement.id,
    });
    symbolPlacement = null;
    setTool("select");
    return;
  }

  if (tool === "rectangle") {
    const point = snapWorld(w);
    pending.push({ x: point.x, y: point.y });
    if (pending.length === 2) {
      const [start, end] = pending;
      pending = [];
      if (Math.abs(end.x - start.x) < 0.01 || Math.abs(end.y - start.y) < 0.01) {
        flash("rectangle needs positive width and height");
        return;
      }
      send({ op: "add_rectangle", x1: start.x, y1: start.y, x2: end.x, y2: end.y });
    }
    return;
  }

  if (tool === "select") {
    const measurement = pickMeasurement(w);
    if (measurement) {
      selection = { kind: "measurement", id: measurement.id };
      syncPanel();
      draw();
      return;
    }
    let rectangle = null, corner = null;
    for (const candidate of state.rectangles || []) {
      const index = pickRectangleCorner(candidate, w);
      if (index !== null) { rectangle = candidate; corner = index; break; }
    }
    if (!rectangle) rectangle = pickRectangle(w);
    if (rectangle) {
      selection = { kind: "rectangle", id: rectangle.id };
      const points = rectanglePoints(rectangle);
      const symbol = (state.symbols || []).find(item => item.id === rectangle.symbol);
      drag = {
        mode: corner === null ? "rectangle" : "rectangle_resize",
        id: rectangle.id,
        corner,
        start: w,
        orig: points.map(point => ({ x: point.x, y: point.y })),
        final: points.map(point => ({ x: point.x, y: point.y })),
      };
      syncPanel();
      draw();
      return;
    }
    const opening = pickOpening(w);

    if (opening) {
      const wall = wallsById[opening.wall];
      const ends = openingEnds(opening);
      const sx = w.x * view.scale + view.ox;
      const sy = view.oy - w.y * view.scale;
      const startScreen = toScreen(ends[0].x, ends[0].y);
      const endScreen = toScreen(ends[1].x, ends[1].y);
      const startDistance = Math.hypot(sx - startScreen.x, sy - startScreen.y);
      const endDistance = Math.hypot(sx - endScreen.x, sy - endScreen.y);
      const endpoint = Math.min(startDistance, endDistance) <= 9
        ? (startDistance < endDistance ? "start" : "end")
        : "body";
      const station = projectOpening(w, wall);
      drag = {
        mode: "opening",
        id: opening.id,
        endpoint,
        origStart: opening.start,
        origLength: opening.length,
        grabOffset: endpoint === "body" ? station - opening.start : 0,
      };
      selection = { kind: "opening", id: opening.id };
      syncPanel();
      draw();
      return;
    }
    const constraint = pickConstraint(w);
    if (constraint) {
      selection = { kind: "constraint", id: constraint.id };
      syncPanel();
      draw();
      return;
    }
    const p = pickPoint(w);
    if (p) {
      const owner = findWallByCorner(p.id);
      const axis = owner ? wallAxis(owner) : null;
      const preserveLengths = axis ? {
        [owner.id]: Math.hypot(axis.bx - axis.ax, axis.by - axis.ay),
      } : {};
      drag = { mode: "point", id: p.id, preserveLengths };
      selection = null;
      return;
    }
    const wall = pickWall(w);
    if (wall) {
      selection = { kind: "wall", id: wall.id };
      drag = {
        mode: "wall",
        id: wall.id,
        pids: [...wall.corners],
        orig: corners(wall).map(c => ({ x: c.x, y: c.y })),
        start: w,
      };
      syncPanel();
      draw();
      return;
    }
    selection = null;
    syncPanel();
    draw();
    return;
  }

  if (tool === "opening") {
    if (!pending.length) {
      const wall = pickWall(w);
      if (!wall) { flash("click a wall"); return; }
      const station = projectOpening(w, wall);
      pending.push({ wall: wall.id, station });
      selection = null;
      draw();
      return;
    }
    const wall = wallsById[pending[0].wall];
    const end = wall ? projectOpening(w, wall) : null;
    if (!wall || end == null || Math.abs(end - pending[0].station) < 0.01) {
      pending = [];
      flash("opening must have positive length");
      return;
    }
    const start = Math.min(pending[0].station, end);
    const finish = Math.max(pending[0].station, end);
    send({ op: "add_opening", wall: wall.id, start, end: finish });
    pending = [];
    return;
  }

  if (tool === "wall") {
    const s = snapWorld(w);
    pending.push(s);
    if (pending.length === 2) {
      const [p, q] = pending;
      pending = [];
      const dx = q.x - p.x, dy = q.y - p.y;
      const L = Math.hypot(dx, dy);
      if (L * view.scale < 8) return;
      const ux = dx / L, uy = dy / L, h = wallThickness / 2;
      const joins = [];
      let S = { x: p.x, y: p.y }, E = { x: q.x, y: q.y };
      for (const [isStart, info] of [[true, p], [false, q]]) {
        if (!info.pid) continue;
        const owner = findWallByCorner(info.pid);
        if (!owner) continue;
        const idx = owner.corners.indexOf(info.pid);
        const sigmaT = (idx === 0 || idx === 3) ? 1 : -1;
        const oc = corners(owner);
        const oax = (oc[0].x + oc[1].x) / 2, oay = (oc[0].y + oc[1].y) / 2;
        const obx = (oc[2].x + oc[3].x) / 2, oby = (oc[2].y + oc[3].y) / 2;
        const oL = Math.hypot(obx - oax, oby - oay);
        const k = oL > 1e-9 ? ((obx - oax) * ux + (oby - oay) * uy) / oL : 0;
        const sigmaNew = Math.abs(k) > 0.9 ? sigmaT * (k > 0 ? 1 : -1) : 1;
        // Shift the axis endpoint so corner c_sigmaNew lands exactly on the
        // snapped vertex: pt = T - sigma*h*perp(other - pt), by iteration.
        const other = isStart ? E : S;
        let adj = { x: info.x, y: info.y };
        for (let it = 0; it < 6; it++) {
          const ddx = other.x - adj.x, ddy = other.y - adj.y;
          const LL = Math.hypot(ddx, ddy);
          if (LL < 1e-9) break;
          adj = { x: info.x - sigmaNew * h * (-ddy / LL), y: info.y - sigmaNew * h * (ddx / LL) };
        }
        if (isStart) S = adj; else E = adj;
        const cornerIdx = isStart ? (sigmaNew > 0 ? 0 : 1) : (sigmaNew > 0 ? 3 : 2);
        joins.push({ corner: cornerIdx, pid: info.pid });
      }
      send({ op: "add_wall", x1: S.x, y1: S.y, x2: E.x, y2: E.y, thickness: wallThickness, joins });
    }
    return;
  }

  if (tool === "dim") {
    const t = pickTarget(w);
    if (!t) { flash("click an opening or opening handle, wall corner, or edge"); return; }
    pending.push(t);
    if (pending.length === 2) {
      const [t1, t2] = pending;
      pending = [];
      if (t1.kind === "wall-end" && t2.kind === "wall-end"
          && t1.wall === t2.wall && t1.end === t2.end) {
        flash("pick two different targets");
        return;
      }
      if (t1.kind === "vertex" && t2.kind === "vertex" && t1.pid === t2.pid) {
        flash("pick two different targets");
        return;
      }
      if (t1.kind === "opening" && t2.kind === "opening"
          && t1.opening === t2.opening && t1.handle === t2.handle) {
        flash("pick two different targets");
        return;
      }
      if (t1.kind === "edge" && t2.kind === "edge" &&
          t1.wall === t2.wall && t1.side === t2.side) {
        flash("pick two different targets");
        return;
      }
      let cur;
      if (t1.kind !== "edge" && t2.kind !== "edge") {
        const p1 = targetPos(t1), p2 = targetPos(t2);
        cur = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      } else if (t1.kind === "edge" && t2.kind === "edge") {
        const w1 = wallsById[t1.wall], w2 = wallsById[t2.wall];
        const d1 = edgeUnit(w1, t1.side), d2 = edgeUnit(w2, t2.side);
        const cross = d1.x * d2.y - d1.y * d2.x;
        if (Math.abs(cross) > 0.09) {
          flash("edges must be nearly parallel");
          return;
        }
        cur = Math.abs(signedDistEdgeEdge(w1, t1.side, w2, t2.side));
      } else {
        const ve = t1.kind === "edge" ? t1 : t2;
        const vt = t1.kind === "edge" ? t2 : t1;
        cur = Math.abs(signedDistPointEdge(targetPos(vt), wallsById[ve.wall], ve.side));
      }
      if (cur == null) return;
      const sameOpening = t1.kind === "opening" && t2.kind === "opening"
        && t1.opening === t2.opening && t1.handle !== t2.handle;
      const sameOpeningLengthTarget =
        (t1.kind === "opening-length" && t2.kind === "opening"
          && t1.opening === t2.opening)
        || (t2.kind === "opening-length" && t1.kind === "opening"
          && t1.opening === t2.opening);
      const lengthOpeningId = sameOpening ? t1.opening
        : sameOpeningLengthTarget
          ? (t1.kind === "opening-length" ? t1.opening : t2.opening)
          : null;
      const hasLengthConstraint = lengthOpeningId !== null
        && state.constraints.some(c => openingLengthRefs(c)?.opening === lengthOpeningId);
      const axisLength = t1.kind === "wall-end" && t2.kind === "wall-end"
        && t1.wall === t2.wall && t1.end !== t2.end;
      const dimensionName = sameOpeningLengthTarget || (sameOpening && hasLengthConstraint)
        ? "Opening length"
        : axisLength
          ? "Wall length"
          : "Distance";
      if (t1.kind === "opening-length" && t2.kind === "opening-length") {
        flash("pick a different target");
        return;
      }
      openDialog(
        dimensionName,
        fmtLen(cur),
        parseLen,
        (v) => {
          send({ op: "add_constraint", constraint: {
            type: "distance", a: refOf(t1), b: refOf(t2), length: v,
          } });
        },
      );
    }
    return;
  }

  if (tool === "angle") {
    const line = pickConstraintLine(w);
    if (!line) { flash("click on a wall axis or rectangle side"); return; }
    const key = lineRefKey(line);
    if (pending[0] && lineRefKey(pending[0]) === key) return;
    pending.push(line);
    if (pending.length === 2) {
      const [a, b] = pending;
      pending = [];
      const pa = linePoints(a), pb = linePoints(b);
      const av = { x: pa[1].x - pa[0].x, y: pa[1].y - pa[0].y };
      const bv = { x: pb[1].x - pb[0].x, y: pb[1].y - pb[0].y };
      const degrees = Math.atan2(av.x * bv.y - av.y * bv.x, av.x * bv.x + av.y * bv.y) * 180 / Math.PI;
      openDialog("Angle (degrees)", fmtDeg(Math.abs(degrees)), parseAngle, value => {
        send({ op: "add_constraint", constraint: { type: "angle", a, b, degrees: value } });
      });
    }
    return;
  }

  if (tool === "coincident") {
    const p = pickPoint(w);
    if (!p) { flash("click near a wall corner"); return; }
    pending.push(p);
    if (pending.length === 2) {
      const [p1, p2] = pending;
      pending = [];
      if (p1.id !== p2.id) {
        send({ op: "add_constraint", constraint: { type: "coincident", a: p1.id, b: p2.id } });
      }
    }
    return;
  }

  if (tool === "horizontal" || tool === "vertical") {
    const target = pickConstraintLine(w);
    if (target) {
      send({ op: "add_constraint", constraint: { type: tool, target } });
    } else {
      flash("click on a wall axis or rectangle side");
    }
  }
});

canvas.addEventListener("pointermove", (e) => {
  const w = eventWorld(e);
  const r = canvas.getBoundingClientRect();
  mouse = { wx: w.x, wy: w.y, sx: e.clientX - r.left, sy: e.clientY - r.top, inside: true, shiftKey: e.shiftKey };
  coordsEl.textContent = `x: ${fmtLen(w.x)}  y: ${fmtLen(w.y)}`;

  if (drag && drag.mode === "opening") {
    const opening = (state.openings || []).find(item => item.id === drag.id);
    const wall = opening && wallsById[opening.wall];
    const station = wall ? projectOpening(w, wall) : null;
    if (opening && station != null) {
      const axis = wallAxis(wall);
      const direction = axisDir(wall);
      const wallLength = Math.hypot(direction.x, direction.y);
      let start = drag.origStart, end = drag.origStart + drag.origLength;
      if (drag.endpoint === "start") start = Math.max(0, Math.min(end - 0.01, station));
      else if (drag.endpoint === "end") end = Math.min(wallLength, Math.max(start + 0.01, station));
      else {
        start = Math.max(0, Math.min(wallLength - drag.origLength, station - drag.grabOffset));
        end = start + drag.origLength;
      }
      opening.start = start;
      opening.length = end - start;
      drag.finalStart = start;
      drag.finalEnd = end;
      const now = performance.now();
      if (now - lastDragSend >= 33) {
        lastDragSend = now;
        send({ op: "update_opening", id: opening.id, start, end });
      }
      draw();
    }
    return;
  }


  if (symbolPlacement) {
    draw();
    return;
  }

  if (rotate) {
    const delta = Math.atan2(w.y - rotate.pivot.y, w.x - rotate.pivot.x) - rotate.startAng;
    const cos = Math.cos(delta), sin = Math.sin(delta);
      const map = {};
      const rotated = [];
      rotate.pids.forEach((pid, i) => {
        const original = rotate.orig[i];
        const nx = rotate.pivot.x + (original.x - rotate.pivot.x) * cos - (original.y - rotate.pivot.y) * sin;
        const ny = rotate.pivot.y + (original.x - rotate.pivot.x) * sin + (original.y - rotate.pivot.y) * cos;
        const point = state.points[pid];
        if (point) { point.x = nx; point.y = ny; }
        rotated.push([nx, ny]);
        map[pid] = [nx, ny];
      });
      if (rotate.kind === "rectangle") {
        const now = performance.now();
        if (now - lastDragSend >= 33) {
          lastDragSend = now;
          send({ op: "update_rectangle_corners", id: rotate.id, corners: rotated });
        }
      } else {
        sendDrag(map);
      }

    draw();
    return;
  }

  if (pan) {
    view.ox = pan.ox + (e.clientX - pan.sx);
    view.oy = pan.oy + (e.clientY - pan.sy);
    draw();
    return;
  }

  if (drag) {
    if (drag.mode === "point") {
      const p = state.points[drag.id];
      if (p) { p.x = w.x; p.y = w.y; }
      sendDrag({ [drag.id]: [w.x, w.y] }, false, drag.preserveLengths);
    } else if (drag.mode === "rectangle" || drag.mode === "rectangle_resize") {
      const rectangle = (state.rectangles || []).find(item => item.id === drag.id);
      if (drag.mode === "rectangle") {
        const dx = w.x - drag.start.x, dy = w.y - drag.start.y;
        drag.final = drag.orig.map(point => ({ x: point.x + dx, y: point.y + dy }));
      } else {
        const opposite = (drag.corner + 2) % 4;
        const fixed = drag.orig[opposite];
        const ux = drag.orig[1].x - drag.orig[0].x;
        const uy = drag.orig[1].y - drag.orig[0].y;
        const vx = drag.orig[3].x - drag.orig[0].x;
        const vy = drag.orig[3].y - drag.orig[0].y;
        const ul = Math.hypot(ux, uy), vl = Math.hypot(vx, vy);
        const u = { x: ux / ul, y: uy / ul }, v = { x: vx / vl, y: vy / vl };
        const dx = w.x - fixed.x, dy = w.y - fixed.y;
        const signU = drag.corner === 0 || drag.corner === 3 ? -1 : 1;
        const signV = drag.corner === 0 || drag.corner === 1 ? -1 : 1;
        const width = Math.max(0.001, Math.abs(dx * u.x + dy * u.y));
        const height = Math.max(0.001, Math.abs(dx * v.x + dy * v.y));
        const center = {
          x: fixed.x + signU * width / 2 * u.x + signV * height / 2 * v.x,
          y: fixed.y + signU * width / 2 * u.y + signV * height / 2 * v.y,
        };
        drag.final = drag.orig.map((_, index) => {
          const cornerX = index === 0 || index === 3 ? -1 : 1;
          const cornerY = index < 2 ? -1 : 1;
          return {
            x: center.x + cornerX * width / 2 * u.x + cornerY * height / 2 * v.x,
            y: center.y + cornerX * width / 2 * u.y + cornerY * height / 2 * v.y,
          };
        });
      }
      if (rectangle) rectangle.corners = drag.final;
      if (drag.mode === "rectangle_resize") updateSymbolResizePreview(rectangle, drag.final);
      else if (symbolResizePreview) symbolResizePreview = null;
      send({ op: "update_rectangle_corners", id: drag.id, corners: drag.final.map(point => [point.x, point.y]) });
    } else if (drag.mode === "wall") {
      // translate the whole rectangle, snapped to the grid
      const step = gridSteps()[0];
      const dx = w.x - drag.start.x, dy = w.y - drag.start.y;
      const DX = Math.round(dx / step) * step;
      const DY = Math.round(dy / step) * step;
      const map = {};
      drag.pids.forEach((pid, i) => {
        const p = state.points[pid];
        if (p) {
          p.x = drag.orig[i].x + DX;
          p.y = drag.orig[i].y + DY;
          map[pid] = [p.x, p.y];
        }
      });
      sendDrag(map);
    }
    draw();
    return;
  }

  updateHover(w);
  draw();
});

canvas.addEventListener("pointerup", (e) => {
  if (pan) { pan = null; return; }
  if (symbolPlacement) return;
  if (rotate) {
    const map = {};
    const points = [];
    rotate.pids.forEach((pid) => {
      const point = state.points[pid];
      if (point) {
        map[pid] = [point.x, point.y];
        points.push([point.x, point.y]);
      }
    });
    if (rotate.kind === "rectangle") {
      send({ op: "update_rectangle_corners", id: rotate.id, corners: points });
    } else {
      sendDrag(map, true);
    }
    send({ op: "drag_end" });
    rotate = null;
    return;
  }
  if (drag) {
    // make sure the server saw the final positions, then trigger a full solve
    if (drag.mode === "opening") {
      const opening = (state.openings || []).find(item => item.id === drag.id);
      if (opening && Number.isFinite(drag.finalStart) && Number.isFinite(drag.finalEnd)) {
        send({ op: "update_opening", id: opening.id, start: drag.finalStart, end: drag.finalEnd });
      }
    } else if (drag.mode === "point") {
      const p = state.points[drag.id];
      if (p) sendDrag({ [drag.id]: [p.x, p.y] }, true, drag.preserveLengths);
    } else if (drag.mode === "rectangle" || drag.mode === "rectangle_resize") {
      const points = drag.final || drag.orig;
      send({ op: "update_rectangle_corners", id: drag.id, corners: points.map(point => [point.x, point.y]) });
      if (drag.mode === "rectangle_resize" && symbolResizePreview) {
        symbolResizePreview.released = true;
        const symbol = state.symbols.find(item => item.id === symbolResizePreview.symbolId);
        if (symbol) {
          symbol.width = symbolResizePreview.width;
          symbol.height = symbolResizePreview.height;
          for (const rectangle of state.rectangles) {
            if (rectangle.symbol !== symbol.id) continue;
            const preview = symbolResizePreview.instances.get(rectangle.id);
            if (!preview) continue;
            rectangle.corners.forEach((pid, index) => {
              state.points[pid] = { ...state.points[pid], x: preview[index].x, y: preview[index].y };
            });
          }
        }
      }
      if (drag.mode === "rectangle_resize" && symbolResizePreview) {
        symbolResizePreview.released = true;
      }
    } else if (drag.mode === "wall") {
      const map = {};
      drag.pids.forEach((pid) => {
        const p = state.points[pid];
        if (p) map[pid] = [p.x, p.y];
      });
      sendDrag(map, true);
    }
    const endOp = { op: "drag_end" };
    if (drag.mode === "point" && Object.keys(drag.preserveLengths || {}).length) {
      endOp.preserve_lengths = drag.preserveLengths;
    }
    send(endOp);
    drag = null;
  }
});

canvas.addEventListener("pointerleave", () => {
  mouse.inside = false;
  hover = null;
  draw();
});

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0012));
}, { passive: false });

function zoomAt(px, py, factor) {
  const wx = (px - view.ox) / view.scale;
  const wy = (view.oy - py) / view.scale;
  view.scale = Math.min(2000, Math.max(5, view.scale * factor));
  view.ox = px - wx * view.scale;
  view.oy = py + wy * view.scale;
  draw();
}

/* ---------- dialog ---------- */
let dialogSubmit = null;
let dialogParse = null;

function openDialog(labelText, value, parse, onSubmit) {
  dialogSubmit = onSubmit;
  dialogParse = parse;
  dialogLabel.textContent = labelText;
  dialogInput.value = value;
  dialogEl.hidden = false;
  const selectValue = () => {
    dialogInput.focus();
    dialogInput.setSelectionRange(0, dialogInput.value.length, "forward");
  };
  selectValue();
  requestAnimationFrame(() => requestAnimationFrame(selectValue));
  setTimeout(selectValue, 50);
}

dialogInput.addEventListener("focus", () => {
  dialogInput.setSelectionRange(0, dialogInput.value.length, "forward");
});

function editConstraint(c) {
  if (c.shared_symbol) {
    const symbol = state.symbols.find(item => item.id === c.shared_symbol);
    const constraint = symbol?.constraints.find(item => item.id === c.id);
    if (!constraint) return;
    const owner = symbol.label;
    if (constraint.type === "distance") {
      openDialog(`Shared ${owner} distance`, fmtLen(constraint.length), parseLen, value => {
        send({ op: "update_constraint", id: constraint.id, value });
      });
    } else if (constraint.type === "angle") {
      openDialog(`Shared ${owner} angle (degrees)`, fmtDeg(Math.abs(constraint.degrees)), parseAngle, value => {
        send({ op: "update_constraint", id: constraint.id, value });
      });
    }
    return;
  }
  if (c.type === "distance") {
    const isOpeningLength = c.a.kind === "opening-length"
      || c.b.kind === "opening-length"
      || (c.a.kind === "opening" && c.b.kind === "opening"
        && c.a.opening === c.b.opening && c.a.handle !== c.b.handle);
    if (isOpeningLength) {
      openDialog("Opening length", fmtLen(c.length), parseLen, (value) => {
        send({ op: "update_constraint", id: c.id, value });
      });
    } else {
      openDialog("Distance", fmtLen(c.length), parseLen, (value) => {
        send({ op: "update_constraint", id: c.id, value });
      });
    }
  } else if (c.type === "angle") {
    openDialog("Angle (degrees)", fmtDeg(Math.abs(c.degrees)), parseAngle, (value) => {
      send({ op: "update_constraint", id: c.id, value });
    });
  }
}

function closeDialog(ok) {
  if (dialogEl.hidden) return;
  const raw = dialogInput.value;
  dialogEl.hidden = true;
  if (ok && dialogSubmit) {
    const v = dialogParse(raw);
    if (v !== null) dialogSubmit(v);
    else flash("enter a valid number");
  }
  dialogSubmit = null;
  dialogParse = null;
}

dialogInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") closeDialog(true);
  else if (e.key === "Escape") closeDialog(false);
  e.stopPropagation();
});

document.getElementById("dialog-ok").addEventListener("click", () => closeDialog(true));
document.getElementById("dialog-cancel").addEventListener("click", () => closeDialog(false));

/* ---------- constraint panel ---------- */
function pname(pid) {
  const p = state.points[pid];
  return p ? p.name : "?";
}

function refName(r, rectangleId = null) {
  if (r.kind === "vertex") return pname(r.pid);
  if (r.corner != null) {
    const rectangle = state.rectangles.find(item => item.id === rectangleId);
    return rectangle ? pname(rectangle.corners[r.corner]) : `corner ${r.corner + 1}`;
  }
  if (r.kind === "opening") {
    const opening = (state.openings || []).find(item => item.id === r.opening);
    const name = opening ? `${opening.name}·` : "?";
    return `${name}${r.handle}`;
  }
  if (r.kind === "opening-length") {
    const opening = (state.openings || []).find(item => item.id === r.opening);
    return `${opening ? opening.name : "?"} length`;
  }
  if (r.kind === "wall-end") {
    const wall = wallsById[r.wall];
    return `${wall ? wall.name : "?"}·${r.end}`;
  }
  const w = wallsById[r.wall];
  return `${w ? w.name : "?"}·${r.side > 0 ? "+" : "−"}`;
}

function lineName(ref, rectangleId = null) {
  if (ref.kind === "wall") return wallsById[ref.wall]?.name ?? "?";
  if (ref.start_corner != null) {
    const rectangle = state.rectangles.find(item => item.id === rectangleId);
    return rectangle
      ? `${state.points[rectangle.corners[ref.start_corner]]?.name ?? "?"}–${state.points[rectangle.corners[ref.end_corner]]?.name ?? "?"}`
      : `corner ${ref.start_corner + 1}–${ref.end_corner + 1}`;
  }
  const start = state.points[ref.start], end = state.points[ref.end];
  return `${start?.name ?? "?"}–${end?.name ?? "?"}`;
}

function describe(c) {
  const shared = c.shared_symbol ? "Shared · " : "";
  if (c.type === "distance") return `${shared}${fmtLen(c.length)}  (${refName(c.a, c.instance)}–${refName(c.b, c.instance)})`;
  if (c.type === "angle") return `${shared}${fmtDeg(Math.abs(c.degrees))}  (${lineName(c.a, c.instance)}·${lineName(c.b, c.instance)})`;
  if (c.type === "coincident") return `${shared}${pname(c.a)} ≡ ${pname(c.b)}`;
  if (c.type === "horizontal") return `${shared}${lineName(c.target, c.instance)} horizontal`;
  return `${shared}${lineName(c.target, c.instance)} vertical`;
}

let symbolSaveTarget = null;
let pendingSymbolSave = null;

function saveSelectedRectangle() {
  let rectangle = state.rectangles.find(item => item.id === selection?.id);
  if (!rectangle) {
    rectangle = [...state.rectangles].reverse().find(item => !item.symbol);
    if (!rectangle) rectangle = state.rectangles[state.rectangles.length - 1];
    if (rectangle) {
      selection = { kind: "rectangle", id: rectangle.id };
      syncPanel();
      draw();
    }
  }
  if (!rectangle) {
    flash("draw a rectangle before saving a symbol");
    return;
  }
  setSidebarTab("symbols");
  symbolSaveTarget = rectangle.id;
  pendingSymbolSave = null;
  const symbol = state.symbols.find(item => item.id === rectangle.symbol);
  symbolLabelInput.value = symbol ? symbol.label : "";
  symbolModal.hidden = false;
  symbolLabelInput.focus();
  symbolLabelInput.select();
}

function closeSymbolModal(save) {
  if (symbolModal.hidden) return;
  if (save && symbolSaveTarget) {
    const text = symbolLabelInput.value.trim();
    if (!text) {
      flash("enter a symbol label");
      symbolLabelInput.focus();
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      flash("not connected; symbol was not saved");
      return;
    }
    pendingSymbolSave = { id: symbolSaveTarget, label: text };
    send({ op: "save_symbol", ...pendingSymbolSave });
  }
  symbolModal.hidden = true;
  symbolSaveTarget = null;
}

function syncPanel() {
  listEl.innerHTML = "";
  const visibleConstraints = allVisibleConstraints();
  if (!visibleConstraints.length) {
    const li = document.createElement("li");
    li.className = "placeholder";
    li.textContent = "No constraints yet";
    listEl.appendChild(li);
  }
  for (const c of visibleConstraints) {
    const li = document.createElement("li");
    if (selection && selection.kind === "constraint" && selection.id === c.id) {
      li.classList.add("selected");
    }
    const name = document.createElement("span");
    name.className = "cname";
    name.textContent = c.name;
    const desc = document.createElement("span");
    desc.className = "cdesc";
    desc.textContent = describe(c);
    const del = document.createElement("button");
    del.className = "cdel";
    del.textContent = "✕";
    del.title = c.shared_symbol ? "Delete shared symbol constraint" : "Delete constraint";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      send({ op: "delete", id: c.id });
    });
    li.addEventListener("click", () => {
      selection = { kind: "constraint", id: c.id };
      for (const row of listEl.children) row.classList.toggle("selected", row === li);
      draw();
    });
    li.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (e.target.closest("button")) return;
      selection = { kind: "constraint", id: c.id };
      syncPanel();
      draw();
      editConstraint(c);
    });
    li.append(name, desc, del);
    listEl.appendChild(li);
  }
  syncSymbolPanel();
  syncStatus();
}

function setSidebarTab(name) {
  const constraintsActive = name === "constraints";
  const constraintsTab = document.getElementById("constraints-tab");
  const symbolsTab = document.getElementById("symbols-tab");
  const constraintsPanel = document.getElementById("constraints-panel");
  const symbolsPanel = document.getElementById("symbols-panel");
  constraintsTab.classList.toggle("active", constraintsActive);
  symbolsTab.classList.toggle("active", !constraintsActive);
  constraintsTab.setAttribute("aria-selected", String(constraintsActive));
  symbolsTab.setAttribute("aria-selected", String(!constraintsActive));
  constraintsPanel.hidden = !constraintsActive;
  symbolsPanel.hidden = constraintsActive;
}

document.getElementById("constraints-tab").addEventListener("click", () => setSidebarTab("constraints"));
document.getElementById("symbols-tab").addEventListener("click", () => setSidebarTab("symbols"));
saveSymbolButton.addEventListener("click", saveSelectedRectangle);

function syncSymbolPanel() {
  symbolListEl.innerHTML = "";
  const selectedRectangle = state.rectangles.find(item => item.id === selection?.id);
  saveSymbolButton.disabled = state.rectangles.length === 0;
  saveSymbolButton.textContent = selectedRectangle?.symbol
    ? "Edit symbol label"
    : selectedRectangle
      ? "Save selected as symbol"
      : "Save latest as symbol";
  if (!state.symbols.length) {
    const li = document.createElement("li");
    li.className = "placeholder";
    li.textContent = "No symbols saved";
    symbolListEl.appendChild(li);
  }
  if (selectedRectangle?.symbol) {
    const editLabel = document.createElement("button");
    editLabel.className = "symbol-save";
    editLabel.textContent = "Edit symbol label";
    editLabel.addEventListener("click", saveSelectedRectangle);
    symbolListEl.appendChild(editLabel);
    const detach = document.createElement("button");
    detach.className = "symbol-save";
    detach.textContent = "Make independent rectangle";
    detach.title = "Detach this instance from its shared symbol constraints";
    detach.addEventListener("click", () => send({ op: "detach_rectangle", id: selectedRectangle.id }));
    symbolListEl.appendChild(detach);
  }
  for (const symbol of state.symbols) {
    const li = document.createElement("li");
    li.className = "symbol-row";
    const name = document.createElement("span");
    name.className = "cdesc";
    const instances = (state.rectangles || []).filter(r => r.symbol === symbol.id);
    name.textContent = `${symbol.label} (${fmtLen(symbol.width)} × ${fmtLen(symbol.height)})`;
    if (instances.length) name.textContent += ` · ${instances.length} placed`;
    const place = document.createElement("button");
    place.textContent = "Place";
    place.addEventListener("click", () => {
      symbolPlacement = { id: symbol.id, width: symbol.width, height: symbol.height, start: null };
      rectangleGesture = null;
      setTool("rectangle");
      flash(`Place ${symbol.label}: click where its center should be`);
    });
    const remove = document.createElement("button");
    remove.className = "cdel";
    remove.textContent = "✕";
    remove.title = "Remove symbol; keep placed rectangles as independent shapes";
    remove.setAttribute("aria-label", `Remove symbol ${symbol.label}`);
    remove.addEventListener("click", () => {
      if (symbolPlacement?.id === symbol.id) symbolPlacement = null;
      send({ op: "remove_symbol", id: symbol.id });
    });
    li.append(name, place, remove);
    symbolListEl.appendChild(li);
  }
}

document.getElementById("symbol-save").addEventListener("click", () => closeSymbolModal(true));
document.getElementById("symbol-cancel").addEventListener("click", () => closeSymbolModal(false));
symbolLabelInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") closeSymbolModal(true);
  else if (e.key === "Escape") closeSymbolModal(false);
  e.stopPropagation();
});

function syncStatus() {
  const st = state.status;
  if (!st) { solverEl.textContent = ""; return; }
  statusEl.textContent =
    `${st.params} free parameters · ${st.rows} constraint equations · ${st.iterations} iterations`;
  if (st.converged) {
    solverEl.textContent = `converged · ${st.dofs} DOF`;
    solverEl.className = "ok";
  } else {
    solverEl.textContent = `not converged (max residual ${st.max_residual.toFixed(4)})`;
    solverEl.className = "bad";
  }
}

/* ---------- keyboard ---------- */
window.addEventListener("keydown", (e) => {
  if (!dialogEl.hidden || !symbolModal.hidden) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  const tools = {
    s: "select", w: "wall", p: "wall-path", x: "cut", o: "opening", d: "dim", n: "measure-distance", g: "area",
    a: "angle", c: "coincident", h: "horizontal", v: "vertical",
  };
  const k = e.key.toLowerCase();
  if (tools[k]) { setTool(tools[k]); return; }
  if (e.key === "Enter" && (tool === "wall-path" || tool === "area")) {
    if (pending.length < 3) {
      flash(tool === "area" ? "an area needs at least three points" : "a closed wall path needs at least three points");
      return;
    }
    if (tool === "wall-path") {
      send({
        op: "add_wall_path",
        vertices: pending.map(point => [point.x, point.y]),
        joins: pending.map(point => point.pid),
        closed: true,
        thickness: wallThickness,
      });
    } else {
      const area = polygonArea(pending);
      if (area > 1e-6) {
        measurements.push({ id: nextMeasurementId++, kind: "area", points: pending.map(point => ({ x: point.x, y: point.y })), area });
      }
    }
    pending = [];
    draw();
    return;
  }
  if (e.key === "Escape") {
    pending = [];
    rectangleGesture = null;
    symbolPlacement = null;
    if (!symbolModal.hidden) closeSymbolModal(false);
    selection = null;
    syncPanel();
    draw();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (selection) {
      if (selection.kind === "measurement") {
        measurements = measurements.filter(item => item.id !== selection.id);
      } else {
        send({ op: "delete", id: selection.id });
      }
      selection = null;
      syncPanel();
      draw();
    }
  }
});

/* ---------- toolbar ---------- */
for (const b of document.querySelectorAll("[data-tool]")) {
  b.addEventListener("click", () => setTool(b.dataset.tool));
}
thickInput.addEventListener("change", () => {
  const v = parseLen(thickInput.value);
  if (v) {
    wallThickness = v;
    thickInput.value = fmtLen(v);
  } else {
    flash("invalid wall thickness");
  }
});
const showBox = document.getElementById("show-constraints");
showBox.addEventListener("change", () => {
  showC = showBox.checked;
  selection = showC ? selection : (selection && selection.kind === "wall" ? selection : null);
  syncPanel();
  draw();
});
const unitM = document.getElementById("unit-m");
const unitCm = document.getElementById("unit-cm");
function setUnits(u) {
  units = u;
  unitM.classList.toggle("active", u === "m");
  unitCm.classList.toggle("active", u === "cm");
  syncPanel();
  draw();
}
unitM.addEventListener("click", () => setUnits("m"));
unitCm.addEventListener("click", () => setUnits("cm"));
document.getElementById("solve-btn").addEventListener("click", () => send({ op: "solve" }));
document.getElementById("save-map-btn").addEventListener("click", () => {
  const documentData = { ...state, measurements: measurements.map(item => ({
    ...item,
    points: item.points.map(point => ({ x: point.x, y: point.y })),
  })) };
  delete documentData.status;
  const blob = new Blob([JSON.stringify(documentData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "archimple-map.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});
const loadMapButton = document.getElementById("load-map-btn");
const loadMapInput = document.getElementById("load-map-input");
loadMapButton.addEventListener("click", () => loadMapInput.click());
loadMapInput.addEventListener("change", async () => {
  const file = loadMapInput.files[0];
  loadMapInput.value = "";
  if (!file) return;
  try {
    const documentData = JSON.parse(await file.text());
    if (!documentData || typeof documentData !== "object" || Array.isArray(documentData)) {
      throw new Error("map file must contain a JSON object");
    }
    const importedMeasurements = Array.isArray(documentData.measurements)
      ? documentData.measurements.filter(item => item && (item.kind === "area" || item.kind === "distance")
        && Array.isArray(item.points)
        && (item.kind === "area" ? item.points.length >= 3 : item.points.length === 2)
        && item.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)))
        .map(item => ({
          id: Number.isSafeInteger(item.id) && item.id > 0 ? item.id : nextMeasurementId++,
          kind: item.kind,
          points: item.points.map(point => ({ x: point.x, y: point.y })),
          ...(item.kind === "area" ? { area: polygonArea(item.points) } : {}),
        }))
      : [];
    delete documentData.measurements;
    pendingMeasurementsRestore = importedMeasurements;
    send({ op: "load", document: documentData });
  } catch (error) {
    flash(`could not load map: ${error.message}`);
  }
});
document.getElementById("clear-map-btn").addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    flash("not connected; map was not cleared");
    return;
  }
  const emptyDocument = {
    points: {},
    walls: [],
    openings: [],
    rectangles: [],
    symbols: [],
    constraints: [],
  };
  pendingMeasurementsRestore = [];
  send({ op: "load", document: emptyDocument });
});

/* ---------- resize ---------- */
function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  if (!viewInitialized) {
    viewInitialized = true;
    view.ox = w / 2;
    view.oy = h / 2;
  }
  draw();
}
new ResizeObserver(resize).observe(wrap);

/* ---------- boot ---------- */
setTool("select");
resize();
connect();

// test seam: lets automated tests (and curious users) inspect live state
window.__archimple = {
  get state() { return state; },
  get drag() { return drag; },
  get rotate() { return rotate; },
  get selection() { return selection; },
  get tool() { return tool; },
  get showC() { return showC; },
  view,
};
