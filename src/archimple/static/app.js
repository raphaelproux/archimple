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
const statusEl = document.getElementById("status");
const dialogEl = document.getElementById("dialog");
const dialogLabel = document.getElementById("dialog-label");
const dialogInput = document.getElementById("dialog-input");

/* ---------- state ---------- */
let state = { points: {}, walls: [], openings: [], constraints: [], status: null };
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
let hover = null;   // {kind, id, side?}
let selection = null; // {kind, id}
let drag = null;
let rotate = null;
let pan = null;
let mouse = { wx: 0, wy: 0, sx: 0, sy: 0, inside: false };
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
      indexState();
      syncPanel();
      draw();
    } else if (msg.op === "error") {
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

function currentAngleDeg(w1, w2) {
  const a = axisDir(w1), b = axisDir(w2);
  return Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180 / Math.PI;
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

function angleGeometry(c) {
  const wa = wallsById[c.wall_a], wb = wallsById[c.wall_b];
  if (!wa || !wb || !hasCorners(wa) || !hasCorners(wb)) return null;
  const aa = wallAxis(wa), ab = wallAxis(wb);
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
  const w = wallsById[c.wall];
  if (!w || !hasCorners(w)) return null;
  const a = wallAxis(w);
  return toScreen((a.ax + a.bx) / 2, (a.ay + a.by) / 2);
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
  for (const c of state.constraints) {
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

function draw() {
  const w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#14181f";
  ctx.fillRect(0, 0, w, h);
  drawGrid(w, h);
  if (showC) {
    for (const c of state.constraints) {
      if (c.type === "coincident") drawCoincident(c);
      else if (c.type === "angle") drawAngle(c);
    }
  }
  drawWalls();
  if (showC) {
    for (const c of state.constraints) {
      if (c.type === "distance") drawDistance(c);
    }
    for (const c of state.constraints) drawBadge(c);
  }
  drawOpenings();
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
  const wa = wallsById[c.wall_a], wb = wallsById[c.wall_b];
  if (!wa || !wb || !hasCorners(wa) || !hasCorners(wb)) return;
  for (const w of [wa, wb]) {
    const d = axisDir(w);
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

function drawBadge(c) {
  const a = constraintAnchor(c);
  if (!a) return;
  const sel = selection && selection.kind === "constraint" && selection.id === c.id;
  const col = sel ? "#ffb454" : COLORS[c.type];
  ctx.beginPath();
  ctx.arc(a.x, a.y, 8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(20,24,31,0.92)";
  ctx.fill();
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = col;
  ctx.font = "9px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(GLYPHS[c.type] || "?", a.x, a.y + 0.5);
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

function drawPreview() {
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
  if (hover.kind === "opening-handle") {
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
  tool = t;
  pending = [];
  for (const b of document.querySelectorAll("[data-tool]")) {
    b.classList.toggle("active", b.dataset.tool === t);
  }
  hintEl.classList.remove("error");
  hintEl.textContent = HINTS[t] || "";
}

const HINTS = {
  select: "Drag corners or walls · drag opening ends to resize or its middle to move · right-drag rotates walls",
  wall: "Click two axis points; snapping to a corner creates a coincident constraint (Esc cancels)",
  opening: "Click two points along a wall axis to create an opening (Esc cancels)",
  dim: "Click two targets (opening segment or handle, corner, wall edge, or wall axis end)",
  angle: "Click two walls, then enter the angle",
  coincident: "Click two wall corners to make them coincident",
  horizontal: "Click a wall to constrain its axis horizontal",
  vertical: "Click a wall to constrain its axis vertical",
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

function sendDrag(pointsMap, force) {
  const now = performance.now();
  if (!force && now - lastDragSend < 33) return;
  lastDragSend = now;
  send({ op: "drag", points: pointsMap });
}

function updateHover(w) {
  if (tool === "dim") {
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
    // right-drag rotates the selected wall (or the wall under the cursor)
    // around the clicked point; with no wall involved it pans
    let wall = null;
    if (tool === "select") {
      if (selection && selection.kind === "wall") wall = wallsById[selection.id];
      if (!wall || !hasCorners(wall)) wall = pickWall(w);
    }
    if (wall && hasCorners(wall)) {
      if (!selection || selection.id !== wall.id) {
        selection = { kind: "wall", id: wall.id };
        syncPanel();
      }
      // rotate around the wall's own center; the cursor sets the angle.
      // If the press lands on the center there is no cursor-to-pivot angle,
      // so the wall's own axis direction becomes the reference and the far
      // end follows the cursor like a handle.
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

  if (tool === "select") {
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
    const p = pickPoint(w);
    if (p) {
      drag = { mode: "point", id: p.id };
      selection = null;
      return;
    }
    const constraint = pickConstraint(w);
    if (constraint) {
      selection = { kind: "constraint", id: constraint.id };
      syncPanel();
      draw();
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
      if (sameOpening && !hasLengthConstraint) {
        send({ op: "add_constraint", constraint: {
          type: "distance", a: refOf(t1), b: refOf(t2), length: cur,
        } });
        return;
      }
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
    const wall = pickWall(w);
    if (!wall) { flash("click on a wall"); return; }
    if (pending[0] && pending[0].id === wall.id) return;
    pending.push(wall);
    if (pending.length === 2) {
      const [w1, w2] = pending;
      pending = [];
      openDialog("Angle (degrees)", fmtDeg(Math.abs(currentAngleDeg(w1, w2))), parseAngle, (v) => {
        send({ op: "add_constraint", constraint: { type: "angle", wall_a: w1.id, wall_b: w2.id, degrees: v } });
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
    const wall = pickWall(w);
    if (wall) {
      send({ op: "add_constraint", constraint: { type: tool, wall: wall.id } });
    } else {
      flash("click on a wall");
    }
  }
});

canvas.addEventListener("pointermove", (e) => {
  const w = eventWorld(e);
  const r = canvas.getBoundingClientRect();
  mouse = { wx: w.x, wy: w.y, sx: e.clientX - r.left, sy: e.clientY - r.top, inside: true };
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

  if (rotate) {
    const delta = Math.atan2(w.y - rotate.pivot.y, w.x - rotate.pivot.x) - rotate.startAng;
    const cos = Math.cos(delta), sin = Math.sin(delta);
    const map = {};
    rotate.pids.forEach((pid, i) => {
      const o = rotate.orig[i];
      const nx = rotate.pivot.x + (o.x - rotate.pivot.x) * cos - (o.y - rotate.pivot.y) * sin;
      const ny = rotate.pivot.y + (o.x - rotate.pivot.x) * sin + (o.y - rotate.pivot.y) * cos;
      const p = state.points[pid];
      if (p) { p.x = nx; p.y = ny; }
      map[pid] = [nx, ny];
    });
    sendDrag(map);
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
      // never snap the dragged point onto its own wall's corners or its
      // coincident partners - that degenerates the rectangle
      const exclude = coincidentSet(drag.id);
      const own = findWallByCorner(drag.id);
      if (own) for (const pid of own.corners) exclude.add(pid);
      const s = snapWorld(w, exclude);
      const p = state.points[drag.id];
      if (p) { p.x = s.x; p.y = s.y; }
      sendDrag({ [drag.id]: [s.x, s.y] });
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
  if (rotate) {
    // commit the rotated positions, then trigger a full solve
    const map = {};
    rotate.pids.forEach((pid) => {
      const p = state.points[pid];
      if (p) map[pid] = [p.x, p.y];
    });
    sendDrag(map, true);
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
      if (p) sendDrag({ [drag.id]: [p.x, p.y] }, true);
    } else if (drag.mode === "wall") {
      const map = {};
      drag.pids.forEach((pid) => {
        const p = state.points[pid];
        if (p) map[pid] = [p.x, p.y];
      });
      sendDrag(map, true);
    }
    send({ op: "drag_end" });
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
  dialogInput.focus();
  dialogInput.select();
}

function editConstraint(c) {
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

function refName(r) {
  if (r.kind === "vertex") return pname(r.pid);
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

function describe(c) {
  if (c.type === "distance") return `${fmtLen(c.length)}  (${refName(c.a)}–${refName(c.b)})`;
  if (c.type === "angle") return `${fmtDeg(Math.abs(c.degrees))}  (${wallsById[c.wall_a]?.name ?? "?"}·${wallsById[c.wall_b]?.name ?? "?"})`;
  if (c.type === "coincident") return `${pname(c.a)} ≡ ${pname(c.b)}`;
  if (c.type === "horizontal") return `${wallsById[c.wall]?.name ?? "?"} horizontal`;
  return `${wallsById[c.wall]?.name ?? "?"} vertical`;
}

function syncPanel() {
  listEl.innerHTML = "";
  if (!state.constraints.length) {
    const li = document.createElement("li");
    li.className = "placeholder";
    li.textContent = "No constraints yet";
    listEl.appendChild(li);
  }
  for (const c of state.constraints) {
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
    del.title = "Delete constraint";
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
  syncStatus();
}

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
  if (!dialogEl.hidden) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  const tools = {
    s: "select", w: "wall", o: "opening", d: "dim", a: "angle",
    c: "coincident", h: "horizontal", v: "vertical",
  };
  const k = e.key.toLowerCase();
  if (tools[k]) { setTool(tools[k]); return; }
  if (e.key === "Escape") {
    pending = [];
    selection = null;
    syncPanel();
    draw();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (selection) {
      send({ op: "delete", id: selection.id });
      selection = null;
      syncPanel();
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
