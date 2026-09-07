'use strict';
/* 战术地图 v3：房间/通道/连接线 对象模型 + 楼层 + 编辑/显示双模式。
   依赖 app.js 全局: user, gmCode, isGM, viewRoom, roomNames, escapeHtml, appendSystem */
const M = (s) => document.querySelector(s);
const CELL = 30;                                   // 每逻辑格渲染像素(缩放前)

const MS = {
  room: '', v: -1, data: null,
  tool: 'select', scale: 1, ox: 0, oy: 0,
  sel: null, selType: '',                          // 选中 zone{id} / door
  linkA: null,                                     // 安门/梯 第一个 zoneId
  drag: null, stroke: null,
  hover: null,
  aim: null,                                        // 编辑绘图时的"吸附准星"(逻辑整数格点)，作为真正的放置光标
  floor: null,                                     // 当前显示楼层 id（编辑模式由 GM 切换）
  mode: 'edit',                                    // 'edit' 编辑模式 / 'show' 显示模式(GM 预览&玩家)
  undo: [], redo: []
};

function mapRoomId() { return viewRoom === '__all__' ? 'general' : viewRoom; }
function isOpen() { return M('#mapModal') && !M('#mapModal').classList.contains('hidden'); }
function uid(p) { return (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
// 楼层相关：当前数据楼层里 zone
function curFloor() { return MS.floor || ((MS.data && MS.data.floors && MS.data.floors[0] && MS.data.floors[0].id) || 'F1'); }
function curZones(d) { d = d || MS.data; if (!d) return { rooms: [], passages: [] }; const f = curFloor(); return { rooms: (d.rooms || []).filter(r => (r.floorId || 'F1') === f), passages: (d.passages || []).filter(p => (p.floorId || 'F1') === f) }; }
function zoneAtFloor(d, id) { if (!d) return null; const z = (d.rooms || []).find(r => r.id === id) || (d.passages || []).find(p => p.id === id); return z || null; }
function zf(id) { return zoneAtFloor(MS.data, id); }
function zoneName(z) { return z ? (z.name || (z.shape ? '' : '通道')) : ''; }
function zoneCenter(z) { return z.shape === 'circle' ? { x: z.cx, y: z.cy } : { x: z.x + z.w / 2, y: z.y + z.h / 2 }; }

// 画布坐标↔逻辑格
function toLog(p) { const c = CELL * MS.scale; return { x: (p.x - MS.ox) / c, y: (p.y - MS.oy) / c }; }
// 命中检测(仅当前层)
function zoneAt(log) {
  const d = MS.data; if (!d) return null;
  const { rooms, passages } = curZones(d);
  for (let i = rooms.length - 1; i >= 0; i--) {
    const z = rooms[i];
    if (z.shape === 'circle') { const dx = log.x - z.cx, dy = log.y - z.cy; if (dx * dx + dy * dy <= z.r * z.r) return { kind: 'room', z }; }
    else if (log.x >= z.x && log.x < z.x + z.w && log.y >= z.y && log.y < z.y + z.h) return { kind: 'room', z };
  }
  for (let i = passages.length - 1; i >= 0; i--) {
    const z = passages[i];
    if (log.x >= z.x && log.x < z.x + z.w && log.y >= z.y && log.y < z.y + z.h) return { kind: 'passage', z };
  }
  return null;
}
// 就近命中：点不在任何对象内部时，返回光标附近(tol 格内)最近的对象，便于点选 1 格细的通道或对象边缘
function zoneAtNear(log, tol) {
  const d = MS.data; if (!d) return null;
  const { rooms, passages } = curZones(d);
  let best = null, bestD = tol;
  const consider = (z, kind) => {
    const dist = isCirc(z)
      ? Math.abs(Math.hypot(log.x - z.cx, log.y - z.cy) - z.r)
      : distPtRect(log.x, log.y, zbox(z));
    if (dist < bestD) { bestD = dist; best = { kind, z }; }
  };
  for (const z of rooms) consider(z, 'room');
  for (const z of passages) consider(z, 'passage');
  return best;
}
/* ---- 门/可达辅助 ----
   移动可达 = 同层几何相邻(相贴/相交)；若有门且 locked 则阻断。跨层需"梯"门。
   门的同层放置要求两端几何相邻；跨层直接视为梯。 */
function zbox(z) {
  if (z.shape === 'circle') return { x0: z.cx - z.r, y0: z.cy - z.r, x1: z.cx + z.r, y1: z.cy + z.r };
  return { x0: z.x, y0: z.y, x1: z.x + (z.w || 1), y1: z.y + (z.h || 1) };
}
/* 真实几何(与后端一致)：相邻/可走 = 同层真实最短距离 ≤ ADJ。
   贴边(gap≈0)或通道轻切圆/对象(≤ADJ)都算连通——解决"圆没有直边难贴"。
   创建只禁"过度穿透"(gap < -ADJ)，即最多轻切 1 格。 */
const ADJ = 1;
function isCirc(z) { return z.shape === 'circle'; }
function distPtRect(x, y, rc) { const dx = Math.max(rc.x0 - x, 0, x - rc.x1), dy = Math.max(rc.y0 - y, 0, y - rc.y1); return Math.hypot(dx, dy); }
function rectRectGap(a, b) {
  const xov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const yov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (xov < 0 && yov < 0) return Math.hypot(-xov, -yov);
  if (xov >= 0 && yov >= 0) return -Math.min(xov, yov);
  return xov < 0 ? -xov : -yov;
}
function circleRectGap(c, rc) { return distPtRect(c.cx, c.cy, rc) - c.r; }
function circleCircleGap(c1, c2) { return Math.hypot(c1.cx - c2.cx, c1.cy - c2.cy) - c1.r - c2.r; }
function shapeGap(a, b) {
  const ac = isCirc(a), bc = isCirc(b);
  if (ac && bc) return circleCircleGap(a, b);
  if (ac || bc) { const c = ac ? a : b, rc = ac ? zbox(b) : zbox(a); return circleRectGap(c, rc); }
  return rectRectGap(zbox(a), zbox(b));
}
function sameFloor2(a, b) { return (a.floorId || 'F1') === (b.floorId || 'F1'); }
function touches(a, b) { if (!a || !b || !sameFloor2(a, b)) return false; return shapeGap(a, b) <= ADJ; }
function doorBetween(aId, bId) {
  const d = MS.data; if (!d) return null;
  return (d.doors || []).find((x) => (x.a === aId && x.b === bId) || (x.b === aId && x.a === bId)) || null;
}
// 门的逻辑落点：同层取两包围盒重叠区中心；跨层(梯)取当前层那端中心。
function doorAnchor(d) {
  const a = zf(d.a), b = zf(d.b); if (!a || !b) return null;
  const cross = (a.floorId || 'F1') !== (b.floorId || 'F1');
  if (cross) {
    const here = (a.floorId || 'F1') === curFloor() ? a : b, hc = zoneCenter(here);
    return { x: hc.x, y: hc.y };
  }
  const A = zbox(a), B = zbox(b);
  const x = (Math.max(A.x0, B.x0) + Math.min(A.x1, B.x1)) / 2;
  const y = (Math.max(A.y0, B.y0) + Math.min(A.y1, B.y1)) / 2;
  // 若不相交(纯边贴/小缝)则用两中心中点
  const cA = zoneCenter(a), cB = zoneCenter(b);
  const rx = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
  const ry = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
  if (rx < -0.001 || ry < -0.001) return { x: (cA.x + cB.x) / 2, y: (cA.y + cB.y) / 2 };
  return { x, y };
}
// 命中门（距逻辑锚点小于 tol）
function doorNear(log, tol) {
  const d = MS.data; if (!d) return null;
  for (let i = (d.doors || []).length - 1; i >= 0; i--) {
    const d0 = d.doors[i], a = zf(d0.a), b = zf(d0.b); if (!a || !b) continue;
    if ((a.floorId || 'F1') !== curFloor() && (b.floorId || 'F1') !== curFloor()) continue;
    const an = doorAnchor(d0); if (!an) continue;
    const dx = log.x - an.x, dy = log.y - an.y;
    if (dx * dx + dy * dy < tol * tol) return { kind: 'door', d: d0, anchor: an };
  }
  return null;
}
function doorLabel(d) {
  const a = zf(d.a), b = zf(d.b); if (!a || !b) return '';
  const cross = (a.floorId || 'F1') !== (b.floorId || 'F1');
  const na = zoneName(a) || (a.shape ? '房间' : '通道'), nb = zoneName(b) || (b.shape ? '房间' : '通道');
  return na + (cross ? '(梯)↕' : '↔') + nb + (d.locked ? ' 🔒锁定' : '');
}
function tip(t) { const e = M('#mapTip'); if (e) e.innerHTML = t || ''; }

/* ---- 编辑绘图"内部光标"(吸附准星) ----
   想法：编辑模式用绘图工具时，不依赖系统鼠标，而是隐藏原生指针并显示一个吸附到
   最近整数格点的准星(MS.aim)。真正的"落点"以准星为准，房间边界永远贴齐准星，
   这样贴出来的边和你能看到的瞄准点完全一致，不再出现"边离鼠标很远"的偏差。 */
function isDrawTool() { return isGM && MS.mode === 'edit' && (MS.tool === 'rect' || MS.tool === 'circle' || MS.tool === 'passage'); }
function syncCursor() {
  const cv = M('#mapCanvas'); if (!cv) return;
  if (isDrawTool()) { cv.style.cursor = 'none'; }               // 隐藏系统指针，用画内准星代替
  else if (isGM && MS.mode === 'edit') cv.style.cursor = MS.tool === 'select' ? 'grab' : 'crosshair';
  else cv.style.cursor = 'grab';
  if (!isDrawTool()) MS.aim = null;                             // 非绘图时无准星
}
function drawAim(ctx) {
  const a = MS.aim; if (!a) return;
  const c = CELL * MS.scale;
  const px = rp(a.x), py = rp(a.y);
  const len = Math.max(6, c * 0.5);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,214,110,0.98)'; ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(px - len, py); ctx.lineTo(px + len, py);
  ctx.moveTo(px, py - len); ctx.lineTo(px, py + len);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,235,160,0.98)';
  ctx.beginPath(); ctx.arc(px, py, 1.8, 0, Math.PI * 2); ctx.fill();
  // 吸附点坐标
  ctx.font = '11px system-ui,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText('(' + a.x + ', ' + a.y + ')', px + 7, py - 6);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

/* ---- 创建放行校验(同层)：禁止"过度穿透" ---- */
// 允许贴边与轻切(≤ADJ 切入)；仅当切入超过 ADJ 才视为非法重叠(该对象被穿太多)。
// 返回冲突对象(需拒绝) 或 null(可创建)。这样通道能轻微切到圆/矩形旁即可连通。
function conflictZone(newZone, d) {
  const f = newZone.floorId || curFloor();
  const others = (d.rooms || []).filter(r => (r.floorId || 'F1') === f && r.id !== newZone.id)
    .concat((d.passages || []).filter(p => (p.floorId || 'F1') === f && p.id !== newZone.id));
  for (const o of others) if (shapeGap(newZone, o) < -ADJ) return o;
  return null;
}
// 供选择命中的同层 zone（rooms+passages，返回原对象引用）
function zoneAtId(d, id) {
  if (!d) return null;
  return (d.rooms || []).find(r => r.id === id) || (d.passages || []).find(p => p.id === id) || null;
}
// 草稿形状与已有对象的关系：返回最"近"的一个 { zone, gap }（gap≤0 表示已相贴/轻切）。
// 用于创建提示：红色=穿透过深；绿=已连通(贴边/轻切)；黄=尚需拉近。
function draftInfo(probe, d) {
  const f = probe.floorId || curFloor();
  const others = (d.rooms || []).filter(r => (r.floorId || 'F1') === f && r.id !== probe.id)
    .concat((d.passages || []).filter(p => (p.floorId || 'F1') === f && p.id !== probe.id));
  let best = null, deep = null;
  for (const o of others) {
    const g = shapeGap(probe, o);
    if (g < -ADJ) deep = { zone: o, gap: g };          // 穿过太深，必拒
    if (!best || Math.abs(g) < Math.abs(best.gap)) best = { zone: o, gap: g };
  }
  return { nearest: best, deep };
}
// 创建时"自动吸附"：若新形状与最近对象只差一点(gap∈(0,ADJ])，沿主轴平移把它贴过去(gap→0)。
// 仅在能干净贴紧(平移后不与他者冲突、坐标取整一致)时生效；否则原样返回。返回 {shape, snapTo}。
function snapDraft(shape, d) {
  const probe = shapeToZone(shape, '__snap__');
  const info = draftInfo(probe, d);
  if (!info.nearest || info.deep) return { shape, snapTo: '' };
  const nb = info.nearest.zone, g = info.nearest.gap;
  if (g <= 0 || g > ADJ) return { shape, snapTo: g <= 0 && g > -ADJ ? zoneName(nb) : '' };
  // 主分离轴
  const cb = zoneCenter(nb), cn = zoneCenter(probe);
  const dx = cb.x - cn.x, dy = cb.y - cn.y;
  const axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
  const dir = axis === 'x' ? (dx >= 0 ? 1 : -1) : (dy >= 0 ? 1 : -1);
  // 按主轴向目标移动使接触；对矩形取整，对圆直接平移圆心
  const out = JSON.parse(JSON.stringify(shape));
  const step = g;
  if (axis === 'x') {
    if (out.kind === 'circle') out.cx += dir * step; else out.x += dir * step;
  } else {
    if (out.kind === 'circle') out.cy += dir * step; else out.y += dir * step;
  }
  // 取整回网格(矩形)
  if (out.kind !== 'circle') { out.x = Math.round(out.x); out.y = Math.round(out.y); }
  const probe2 = shapeToZone(out, '__snap__');
  const i2 = draftInfo(probe2, d);
  // 只有真正贴上(或仅轻切)且不再过深才采纳
  if (i2.deep) return { shape, snapTo: '' };
  if (i2.nearest && i2.nearest.gap > -ADJ && i2.nearest.gap <= ADJ) return { shape: out, snapTo: zoneName(nb) };
  return { shape, snapTo: '' };
}
function shapeToZone(shape, id) {
  const fid = shape.floorId || 'F1';
  if (shape.kind === 'circle') return { id: id || '__new__', floorId: fid, shape: 'circle', cx: shape.cx, cy: shape.cy, r: shape.r };
  return { id: id || '__new__', floorId: fid, shape: 'rect', x: shape.x, y: shape.y, w: shape.w, h: shape.h };
}

/* ---- 服务端交互 ---- */
function sendOps(ops) {
  fetch('/api/map/op', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: MS.room, user, gm: gmCode, ops })
  }).then(r => r.json()).catch(() => {});
}
function doLocal(ops) {
  applyLocal(ops);
  for (const o of ops) { MS.undo.push(o); if (MS.undo.length > 60) MS.undo.shift(); MS.redo = []; }
  sendOps(ops);
  render();
}
function applyLocal(ops) {
  const d = MS.data; if (!d) return;
  for (const op of ops || []) {
    if (!op || !op.t) continue;
    if (op.t === 'room.upsert') { const r = op.room; const i = (d.rooms || []).findIndex(x => x.id === r.id); if (i >= 0) d.rooms[i] = Object.assign({}, d.rooms[i], r); else (d.rooms = d.rooms || []).push(r); }
    else if (op.t === 'room.del') { d.rooms = (d.rooms || []).filter(x => x.id !== op.id); }
    else if (op.t === 'passage.upsert') { const p = op.passage; const i = (d.passages || []).findIndex(x => x.id === p.id); if (i >= 0) d.passages[i] = Object.assign({}, d.passages[i], p); else (d.passages = d.passages || []).push(p); }
    else if (op.t === 'passage.del') { d.passages = (d.passages || []).filter(x => x.id !== op.id); }
    else if (op.t === 'door.set') { const x = op.door; const i = (d.doors || []).findIndex(g => (g.a === x.a && g.b === x.b) || (g.b === x.a && g.a === x.b)); if (i >= 0) d.doors[i] = Object.assign({}, d.doors[i], x); else (d.doors = d.doors || []).push(x); }
    else if (op.t === 'door.del') { const dd = op.door || op; d.doors = (d.doors || []).filter(x => !(x.id === op.id || (dd.a && ((x.a === dd.a && x.b === dd.b) || (x.b === dd.a && x.a === dd.b))))); }
    else if (op.t === 'door.lock') { const dd = (d.doors || []).find(x => x.id === op.id || (op.a && ((x.a === op.a && x.b === op.b) || (x.b === op.a && x.a === op.b)))); if (dd) dd.locked = !!op.v; }
    else if (op.t === 'entry') { d.entry = op.id; }
    else if (op.t === 'explore') { const r = (d.rooms || []).find(x => x.id === op.id); if (r) r.explored = !!op.v; }
    else if (op.t === 'room.open') { const r = (d.rooms || []).find(x => x.id === op.id); if (r) { if (op.v) delete r.open; else r.open = false; } }
    else if (op.t === 'explore.floor') { const f = op.floor || curFloor(); (d.rooms || []).filter(x => (x.floorId || 'F1') === f).forEach(r => r.explored = !!op.v); }
    else if (op.t === 'explore.all') { (d.rooms || []).forEach(r => r.explored = !!op.v); }
    else if (op.t === 'floor.add') { (d.floors = d.floors || []).push({ id: op.floor.id, name: op.floor.name || ('层' + (d.floors.length + 1)) }); }
    else if (op.t === 'floor.del') { d.floors = (d.floors || []).filter(x => x.id !== op.id); d.doors = (d.doors || []).filter(x => zf(x.a) && zf(x.b)); }
  }
}
function undoMap() { const o = MS.undo.pop(); if (!o) return; applyLocal(invertOps(o)); MS.redo.push(o); sendOps(invertOps(o)); render(); }
function redoMap() { const o = MS.redo.pop(); if (!o) return; applyLocal(o); MS.undo.push(o); sendOps(o); render(); }
function invertOps(op) {
  if (op.t === 'room.upsert' && op.__new) return [{ t: 'room.del', id: op.room.id }];
  if (op.t === 'room.del') return [{ t: 'room.upsert', room: op.room }];
  if (op.t === 'passage.upsert' && op.__new) return [{ t: 'passage.del', id: op.passage.id }];
  if (op.t === 'passage.del') return [{ t: 'passage.upsert', passage: op.passage }];
  if (op.t === 'door.set' && op.__new) return [{ t: 'door.del', a: op.door.a, b: op.door.b }];
  if (op.t === 'door.del') return [{ t: 'door.set', door: op.door }];
  if (op.t === 'door.lock') return [{ t: 'door.lock', id: op.id, a: op.a, b: op.b, v: !op.v }];
  if (op.t === 'entry') return [{ t: 'entry', id: op.__prev }];
  if (op.t === 'explore') return [{ t: 'explore', id: op.id, v: !op.v }];
  if (op.t === 'room.open') return [{ t: 'room.open', id: op.id, v: !op.v }];
  if (op.t === 'explore.floor') return [{ t: 'explore.floor', floor: op.floor, v: !op.v }];
  if (op.t === 'explore.all') return [{ t: 'explore.all', v: !op.v }];
  return [];
}
function pushUndo(op, marker) { if (marker) op.__new = true; MS.undo.push(op); if (MS.undo.length > 60) MS.undo.shift(); MS.redo = []; }

/* ---- 绘制 ---- */
function rp(x) { return MS.ox + x * CELL * MS.scale; }
function paint(ctx, W, H) {
  const d = MS.data; if (!d) return;
  const showGrid = MS.mode === 'edit';
  const gbg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.15, W / 2, H / 2, Math.max(W, H) * 0.75);
  gbg.addColorStop(0, '#0c1d15'); gbg.addColorStop(1, '#050b08');
  ctx.fillStyle = gbg; ctx.fillRect(0, 0, W, H);
  const inView = (x, y) => x > -60 && x < W + 60 && y > -60 && y < H + 60;
  const c = CELL * MS.scale;
  const myFloor = curFloor();
  if (showGrid) {
    const g0x = Math.floor(-MS.ox / c) | 0, g1x = Math.ceil((W - MS.ox) / c) | 0;
    const g0y = Math.floor(-MS.oy / c) | 0, g1y = Math.ceil((H - MS.oy) / c) | 0;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120,255,170,0.18)'; ctx.beginPath();
    for (let g = g0x; g <= g1x; g++) { if (g % 5 === 0) continue; const x = rp(g); if (inView(x, 0)) { ctx.moveTo(x, 0); ctx.lineTo(x, H); } }
    for (let g = g0y; g <= g1y; g++) { if (g % 5 === 0) continue; const y = rp(g); if (inView(0, y)) { ctx.moveTo(0, y); ctx.lineTo(W, y); } }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(150,255,190,0.35)'; ctx.beginPath();
    for (let g = g0x; g <= g1x; g++) { if (g % 5 !== 0) continue; const x = rp(g); if (inView(x, 0)) { ctx.moveTo(x, 0); ctx.lineTo(x, H); } }
    for (let g = g0y; g <= g1y; g++) { if (g % 5 !== 0) continue; const y = rp(g); if (inView(0, y)) { ctx.moveTo(0, y); ctx.lineTo(W, y); } }
    ctx.stroke();
    const oxp = rp(0), oyp = rp(0);
    if (inView(oxp, oyp)) { ctx.strokeStyle = 'rgba(255,210,120,0.85)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(oxp - 8, oyp); ctx.lineTo(oxp + 8, oyp); ctx.moveTo(oxp, oyp - 8); ctx.lineTo(oxp, oyp + 8); ctx.stroke(); ctx.fillStyle = 'rgba(255,210,120,0.9)'; ctx.font = '10px system-ui,sans-serif'; ctx.textAlign = 'left'; ctx.fillText('0,0', oxp + 10, oyp - 6); }
    ctx.fillStyle = 'rgba(150,255,190,0.55)'; ctx.font = '10px system-ui,sans-serif';
    for (let g = g0x; g <= g1x; g++) { if (g % 5 !== 0) continue; const x = rp(g); if (inView(x, 12)) ctx.fillText(String(g), x + 2, 11); }
    for (let g = g0y; g <= g1y; g++) { if (g % 5 !== 0) continue; const y = rp(g); if (inView(12, y)) ctx.fillText(String(g), 2, y - 2); }
  }
  // doors(门/梯)先画在 zone 之下更清晰，选中高亮在顶层
  drawDoors(ctx, false);
  // zones(当前层)：先统一填充，再统一描边并互相抠掉相接处，使连通的房间/通道看起来一体
  const zs = curZones(d);
  const kinds = new Map();
  for (const r of zs.rooms) kinds.set(r.id, 'room');
  for (const p of zs.passages) kinds.set(p.id, 'passage');
  drawZones(ctx, zs.rooms.concat(zs.passages), kinds);
  drawDoors(ctx, true);
  // 入口标记(房间顶部文字 + 房间中心星标)
  const entry = d.entry ? zf(d.entry) : null;
  if (entry && (entry.floorId || 'F1') === myFloor) {
    const z = entry, ec = zoneCenter(z);
    const topY = rp(ec.y) - (z.shape === 'circle' ? z.r : Math.max(z.h, 1) / 2) * c;
    ctx.fillStyle = '#eaffc9'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('★入口', rp(ec.x), topY - 4);
    ctx.font = 'bold ' + Math.max(14, c * 0.5) + 'px sans-serif';
    ctx.fillText('★', rp(ec.x), rp(ec.y) + 6);
    ctx.textAlign = 'left';
  }
  // players(仅当前层)
  drawPlayers(ctx);
  // 拖拽预览(编辑模式)
  drawStroke(ctx);
  // 编辑绘图"内部光标"(吸附准星)，置于最上层，始终标示真实落点
  drawAim(ctx);
  ctx.textAlign = 'left';
}
function zoneStyle(z, kind) {
  const showMode = MS.mode === 'show';
  const isUnrevealed = kind === 'room' && showMode && !z.explored;
  if (kind === 'passage') return { fill: 'rgba(90,170,130,0.55)', line: '#7fe0a8', isUnrevealed: false };
  if (isUnrevealed) return { fill: 'rgba(60,100,80,0.55)', line: 'rgba(140,200,170,0.6)', isUnrevealed: true };
  return { fill: 'rgba(28,82,54,0.95)', line: '#41e58f', isUnrevealed: false };
}
function zoneShapePath(ctx, z, pad) {
  const c = CELL * MS.scale;
  if (z.shape === 'circle') {
    const R = Math.max(0.1, (z.r + pad) * c);
    ctx.moveTo(rp(z.cx) + R, rp(z.cy));
    ctx.arc(rp(z.cx), rp(z.cy), R, 0, Math.PI * 2);
  } else {
    ctx.rect(rp(z.x) - pad * c, rp(z.y) - pad * c, (z.w + 2 * pad) * c, (z.h + 2 * pad) * c);
  }
}
function fillZone(ctx, z, kind) {
  const { fill } = zoneStyle(z, kind);
  const px = rp(z.x), py = rp(z.y);
  ctx.fillStyle = fill;
  if (z.shape === 'circle') {
    const R = Math.max(2, z.r * CELL * MS.scale);
    ctx.beginPath(); ctx.arc(rp(z.cx), rp(z.cy), R, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillRect(px, py, z.w * CELL * MS.scale, z.h * CELL * MS.scale);
  }
}
function strokeZone(ctx, z, kind, neighbors) {
  const { line } = zoneStyle(z, kind);
  const c = CELL * MS.scale, pad = 3 / c; // 外扩约3px，完全盖住2.5px描边+抗锯齿
  ctx.save();
  ctx.beginPath();
  ctx.rect(-1e6, -1e6, 2e6, 2e6);
  for (const n of neighbors) zoneShapePath(ctx, n, pad);
  ctx.clip(); // nonzero: 大矩形+同向邻区 => 邻区内部被抠掉
  ctx.beginPath();
  if (z.shape === 'circle') {
    const R = Math.max(2, z.r * c);
    ctx.arc(rp(z.cx), rp(z.cy), R, 0, Math.PI * 2);
  } else {
    ctx.rect(rp(z.x), rp(z.y), z.w * c, z.h * c);
  }
  ctx.strokeStyle = line; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.restore();
}
function drawZones(ctx, zones, kinds) {
  const adj = new Map();
  for (const z of zones) adj.set(z.id, []);
  // 同层且真实相触(gap<=0，贴合或轻切)的 zone 互记为相邻 => 描边时抠掉接口
  for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) {
    const a = zones[i], b = zones[j];
    if ((a.floorId || 'F1') !== (b.floorId || 'F1')) continue;
    if (shapeGap(a, b) <= 0) { adj.get(a.id).push(b); adj.get(b.id).push(a); }
  }
  for (const z of zones) fillZone(ctx, z, kinds.get(z.id));
  for (const z of zones) strokeZone(ctx, z, kinds.get(z.id), adj.get(z.id));
}
function drawZone(ctx, z, kind) {
  const c = CELL * MS.scale, sel = MS.sel && MS.selType !== 'door' && MS.sel === z.id;
  const revealed = kind === 'passage' || z.explored;
  const isUnrevealed = zoneStyle(z, kind).isUnrevealed;
  if (sel) { ctx.strokeStyle = '#ffd76a'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); const w = (z.shape === 'circle' ? z.r * 2 : z.w) * c, h = (z.shape === 'circle' ? z.r * 2 : z.h) * c; ctx.strokeRect(rp(zoneCenter(z).x) - w / 2 - 3, rp(zoneCenter(z).y) - h / 2 - 3, w + 6, h + 6); ctx.setLineDash([]); }
  if (z.name) {
    const ec = zoneCenter(z), fogged = kind === 'room' && !z.explored;
    // 编辑模式：未公开房间画亮色 + 名字右上角加小锁标记提醒 GM（不影响玩家看到）
    if (!showMode && fogged) {
      ctx.font = '10px system-ui,sans-serif'; ctx.fillStyle = '#ffd76a';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('🔒', rp(ec.x) + (z.shape === 'circle' ? z.r : z.w / 2) * c * 0.6, rp(ec.y) - (z.shape === 'circle' ? z.r : z.h / 2) * c * 0.7);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    const label = z.name + (isUnrevealed ? ' (未揭示)' : '');
    ctx.font = 'bold ' + Math.max(10, c * 0.4) + 'px system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = isUnrevealed ? 'rgba(150,190,170,0.8)' : '#d7ffdf';
    ctx.fillText(label, rp(ec.x), rp(ec.y));
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  // 未开放(open=false)标记：GM 管理看得到；已揭示给玩家的房间也显示"未开放"提示不可进
  if (kind === 'room' && z.open === false) {
    const ec = zoneCenter(z);
    const Rm = (z.shape === 'circle' ? z.r : Math.max(z.w, z.h) / 2) * c;
    ctx.font = 'bold ' + Math.max(10, c * 0.34) + 'px system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff9d9d';
    ctx.fillText('🔒 未开放', rp(ec.x), rp(ec.y) + Rm * 0.72);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
}
function drawDoors(ctx, top) {
  const d = MS.data, myFloor = curFloor(); if (!d) return;
  for (const g of (d.doors || [])) {
    const a = zf(g.a), b = zf(g.b); if (!a || !b) continue;
    const cross = (a.floorId || 'F1') !== (b.floorId || 'F1');
    const hereA = (a.floorId || 'F1') === myFloor, hereB = (b.floorId || 'F1') === myFloor;
    if (!hereA && !hereB) continue;                                  // 两端都不在本层
    const isSel = MS.sel && MS.selType === 'door' && MS.sel === g.id;
    if (top && !isSel) continue;                                     // 非选中在底层画，选中在顶层补描边
    if (!top && isSel) continue;
    drawDoor(ctx, g, isSel);
  }
}
function drawDoor(ctx, g, isSel) {
  const a = zf(g.a), b = zf(g.b); if (!a || !b) return;
  const c = CELL * MS.scale;
  const cross = (a.floorId || 'F1') !== (b.floorId || 'F1');
  const an = doorAnchor(g); if (!an) return;
  const px = rp(an.x), py = rp(an.y);
  const sz = Math.max(8, c * 0.5);
  const col = cross ? '#e6c860' : '#4ee18f';
  const lineCol = g.locked ? '#ff8f6b' : col;
  // 主体：门为一条横跨"缝"的短杆 + 端点；锁则加锁点；梯画 ↕
  ctx.save();
  // 若同层可求相贴方向则把杆转成竖/横
  let vert = true;
  if (!cross) {
    const A = zbox(a), B = zbox(b);
    const ox = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
    const oy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
    vert = oy >= ox;                                               // 竖直共享边 => 杆竖放
  }
  ctx.strokeStyle = lineCol; ctx.lineWidth = 2.5;
  ctx.beginPath();
  if (cross) { ctx.setLineDash([5, 4]); ctx.moveTo(px - sz * 0.5, py); ctx.lineTo(px + sz * 0.5, py); ctx.moveTo(px, py - sz * 0.5); ctx.lineTo(px, py + sz * 0.5); ctx.setLineDash([]); }
  else if (vert) { ctx.moveTo(px, py - sz / 2); ctx.lineTo(px, py + sz / 2); }
  else { ctx.moveTo(px - sz / 2, py); ctx.lineTo(px + sz / 2, py); }
  ctx.stroke();
  ctx.fillStyle = lineCol;
  if (!cross) { ctx.fillRect(px - 1.6, py - 1.6, 3.2, 3.2); }
  // 锁点
  if (g.locked) {
    ctx.fillStyle = '#ffc26b';
    ctx.beginPath(); ctx.arc(px + (vert ? sz / 2 : 0), py + (vert ? 0 : sz / 2), Math.max(3, c * 0.16), 0, Math.PI * 2); ctx.fill();
  }
  // 端点锚环(便于点击/选中)
  ctx.strokeStyle = isSel ? '#ffd76a' : 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(px, py, sz / 2 + 2, 0, Math.PI * 2); ctx.stroke();
  // 标签
  const la = zoneName(a) || (a.shape ? '房间' : '通道'), lb = zoneName(b) || (b.shape ? '房间' : '通道');
  ctx.fillStyle = g.locked ? '#ffb28f' : (cross ? '#ffe9a8' : '#d7ffdf');
  ctx.font = 'bold ' + Math.max(9, c * 0.32) + 'px system-ui,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(cross ? ('↕' + (a.floorId || 'F1') + '↕' + (b.floorId || 'F1')) : (g.locked ? '🔒 ' + la + '·' + lb : la + '↔' + lb), px, py - sz / 2 - 6);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.restore();
}
function drawPlayers(ctx) {
  const d = MS.data; if (!d) return;
  const c = CELL * MS.scale; const myFloor = curFloor();
  const colors = ['#5cf08a', '#7fe0ff', '#ffcf7e', '#ff8f8f', '#d9a4ff', '#9fffd0'];
  const colFor = (call) => { let h = 0; for (let i = 0; i < call.length; i++) h = (h * 31 + call.charCodeAt(i)) >>> 0; return colors[h % colors.length]; };
  for (const zid in (d.players || {})) {
    const z = zf(zid); if (!z || (z.floorId || 'F1') !== myFloor) continue;
    for (const pl of d.players[zid]) {
      const cx = rp(pl.x + 0.5), cy = rp(pl.y + 0.5), R = Math.max(6, c * 0.34);
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = colFor(pl.call); ctx.fill();
      if (pl.call === user) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke(); }
      ctx.fillStyle = '#08121a'; ctx.font = 'bold ' + Math.max(9, R) + 'px system-ui,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText((pl.call || '?').slice(0, 1), cx, cy + 0.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
  }
}
// 拖拽预览(矩形/圆): 虚线框 + 尺寸 + 状态色(绿=已连通/黄=需拉近/红=穿透过深)
function drawStroke(ctx) {
  const s = MS.stroke; if (!s || !s.x1) return;
  const c = CELL * MS.scale; const myFloor = curFloor();
  const kindName = s.kind === 'circle' ? '圆形房间' : (s.kind === 'passage' ? '通道' : '矩形房间');
  if (s.kind === 'circle') {
    const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2, R = Math.max(0.3, Math.hypot(s.x1 - cx, s.y1 - cy));
    const probe = { id: '__new__', floorId: myFloor, shape: 'circle', cx, cy, r: R };
    const info = draftInfo(probe, MS.data);
    const st = strokeState(info);
    ctx.beginPath(); ctx.arc(rp(cx), rp(cy), R * c, 0, Math.PI * 2);
    ctx.strokeStyle = st.col; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = st.col.replace('#', 'rgba(') + (st.col === '#ff6b6b' ? ',0.12)' : ',0.10)');
    ctx.fillStyle = st.col === '#ff6b6b' ? 'rgba(255,107,107,0.14)' : (st.ok ? 'rgba(90,220,140,0.16)' : 'rgba(255,215,106,0.12)'); ctx.fill();
    ctx.fillStyle = st.col; ctx.font = '12px system-ui,sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(kindName + ' r≈' + R.toFixed(1) + st.txt, rp(cx) + R * c + 6, rp(cy));
  } else {
    const x0 = Math.min(s.x0, s.x1), y0 = Math.min(s.y0, s.y1), w = Math.abs(s.x1 - s.x0), h = Math.abs(s.y1 - s.y0);
    const px = rp(x0), py = rp(y0), pw = Math.max(1, w * c), ph = Math.max(1, h * c);
    const probe = { id: '__new__', floorId: myFloor, shape: s.kind === 'passage' ? 'rect' : 'rect', x: Math.round(x0), y: Math.round(y0), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
    const info = draftInfo(probe, MS.data);
    const st = strokeState(info);
    ctx.strokeStyle = st.col; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(px, py, pw, ph); ctx.setLineDash([]);
    ctx.fillStyle = st.col === '#ff6b6b' ? 'rgba(255,107,107,0.14)' : (st.ok ? 'rgba(90,220,140,0.14)' : 'rgba(255,215,106,0.12)'); ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = st.col; ctx.font = '12px system-ui,sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(kindName + ' ' + Math.max(1, Math.round(w)) + '×' + Math.max(1, Math.round(h)) + st.txt, px, py - 6);
  }
}
function strokeState(info) {
  if (!info) return { col: '#ffd76a', ok: false, txt: '' };
  if (info.deep) return { col: '#ff6b6b', ok: false, txt: ' ⚠穿入过深(' + zoneLabel1(info.deep.zone) + ')' };
  if (info.nearest && info.nearest.gap <= ADJ) return { col: '#5adc8c', ok: true, txt: ' ✓连通 ' + zoneLabel1(info.nearest.zone) };
  const g = info.nearest ? info.nearest.gap : null;
  return { col: '#ffd76a', ok: false, txt: g == null ? '' : ' · 距 ' + zoneLabel1(info.nearest.zone) + ' ' + g.toFixed(1) + ' 格' };
}
function zoneLabel1(z) { return z ? (z.name || (z.shape ? '房间' : '通道')) : ''; }

/* ---- 渲染入口 / 视图 ---- */
function render() {
  if (!isOpen()) return;
  const cvs = M('#mapCanvas'), wrap = M('#mapWrap'); if (!cvs || !wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight; if (w <= 0 || h <= 0) return;
  if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) { cvs.width = Math.round(w * dpr); cvs.height = Math.round(h * dpr); cvs.style.width = w + 'px'; cvs.style.height = h + 'px'; }
  const ctx = cvs.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paint(ctx, w, h);
}
function bbox() {
  const d = MS.data; if (!d) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
  const addZ = (z) => { if (z.shape === 'circle') { grow(z.cx - z.r, z.cy - z.r); grow(z.cx + z.r, z.cy + z.r); } else { grow(z.x, z.y); grow(z.x + z.w, z.y + z.h); } };
  curZones(d).rooms.forEach(addZ); curZones(d).passages.forEach(addZ);
  if (x0 === Infinity) return null;
  return { x0, y0, x1, y1 };
}
function fit() {
  const wrap = M('#mapWrap'), d = MS.data; if (!wrap || !d) return;
  const bb = bbox();
  if (!bb) { MS.scale = 1; const cc = CELL; MS.ox = wrap.clientWidth / 2 - 8 * cc; MS.oy = wrap.clientHeight / 2 - 6 * cc; render(); return; }
  const pad = 60, c = CELL;
  const bw = (bb.x1 - bb.x0) * c, bh = (bb.y1 - bb.y0) * c;
  const s = Math.max(0.25, Math.min(4, (wrap.clientWidth - pad) / Math.max(bw, 1), (wrap.clientHeight - pad) / Math.max(bh, 1)));
  MS.scale = s; const cc = c * s;
  MS.ox = (wrap.clientWidth - (bb.x1 - bb.x0) * cc) / 2 - bb.x0 * cc;
  MS.oy = (wrap.clientHeight - (bb.y1 - bb.y0) * cc) / 2 - bb.y0 * cc;
  render();
}

/* ---- 交互 ---- */
function pos(e) { const r = M('#mapCanvas').getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function capturePtr(e) { try { M('#mapCanvas').setPointerCapture(e.pointerId); } catch (err) {} }
function onDown(e) {
  if (!MS.data) return;
  const p = pos(e), lg = toLog(p);
  const isEdit = MS.mode === 'edit' && isGM;
  // 右键(2)/中键(1)按住拖拽=平移地图（编辑与显示模式均可）
  if (e.button === 2 || e.button === 1) {
    capturePtr(e);
    MS.aim = null;
    MS.drag = { kind: 'pan', sx: p.x, sy: p.y, ox: MS.ox, oy: MS.oy };
    M('#mapCanvas').style.cursor = 'grabbing';
    return;
  }
  // 非编辑模式(显示模式/玩家)：玩家左键仅平移；GM 在显示模式可点选房间来"开放/关闭/揭晓/设入口"
  if (!isEdit) {
    if (e.button !== 0) return;
    if (isGM) {
      const zh = zoneAt(lg);
      if (zh && zh.kind === 'room') {
        MS.sel = zh.z.id; MS.selType = 'room';
        tip('已选「' + (zoneName(zh.z) || '房间') + '」· 可用「开放/关闭」「揭晓/隐藏」管理'); updateAct(); render(); return;
      }
      MS.sel = null; updateAct(); render();
    }
    capturePtr(e); MS.aim = null; MS.drag = { kind: 'pan', sx: p.x, sy: p.y, ox: MS.ox, oy: MS.oy }; M('#mapCanvas').style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0) return;
  capturePtr(e);
  if (MS.tool === 'select') {
    const dh = doorNear(lg, 1.4); const zh = zoneAt(lg);
    if (dh) { MS.selType = 'door'; MS.sel = dh.d.id; tip('门：' + doorLabel(dh.d) + ' · 可用「锁/开锁」与「删除」'); updateAct(); render(); return; }
    if (zh) { MS.selType = zh.kind === 'passage' ? 'passage' : 'room'; MS.sel = zh.z.id; tip('已选「' + (zoneName(zh.z) || (zh.kind === 'passage' ? '通道' : '房间')) + '」' + (isGM ? ' · 可设为入口 / 揭晓隐藏 / 删除' : '')); updateAct(); render(); return; }
    MS.sel = null; tip(''); updateAct(); render();
    MS.aim = null; MS.drag = { kind: 'pan', sx: p.x, sy: p.y, ox: MS.ox, oy: MS.oy }; M('#mapCanvas').style.cursor = 'grabbing'; return;
  }
  if (MS.tool === 'door') {
    const zh = zoneAt(lg) || zoneAtNear(lg, 0.8);
    if (!zh) { tip(MS.linkA ? '再点第二个房间/通道（点对象内部或边缘附近即可）' : '请先点一个房间或通道（点对象内部或边缘附近）'); return; }
    if (!MS.linkA) { MS.linkA = zh.z.id; tip('已选「' + (zoneName(zh.z) || (zh.kind === 'passage' ? '通道' : '房间')) + '」，再点另一个（同层需相邻；跨层自动成梯）'); render(); return; }
    if (zh.z.id === MS.linkA) { tip('两个端不能相同'); return; }
    const a = zf(MS.linkA), b = zh.z; MS.linkA = null;
    const cross = (a.floorId || 'F1') !== (b.floorId || 'F1');
    if (!cross && !touches(a, b)) { tip('这两个不挨着，走不过去。请先用「通道」把两处连到相邻（相贴/轻切都行），再在这对之间安门。'); render(); return; }
    if (doorBetween(a.id, b.id)) { tip('这对之间已经有门了，可点选后用「锁/开锁」。'); render(); return; }
    const did = uid('D'); const op = { t: 'door.set', door: { id: did, a: a.id, b: b.id, type: cross ? 'ladder' : 'door', locked: false } }; op.__new = true;
    pushUndo(op); applyLocal([op]); sendOps([op]);
    tip(cross ? '已放一扇「梯」（跨层）。' : '已放一扇门（未锁）。可点选后「锁/开锁」。'); render(); return;
  }
  if (MS.tool === 'rect' || MS.tool === 'circle' || MS.tool === 'passage') {
    // 起终点均吸附到最近整数格点，保证房间/通道边界贴齐网格（落点以画内准星为准）
    const sx = MS.aim ? MS.aim.x : Math.round(lg.x), sy = MS.aim ? MS.aim.y : Math.round(lg.y);
    MS.stroke = { kind: MS.tool, x0: sx, y0: sy, name: '' }; render(); return;
  }
}
function onMove(e) {
  if (!MS.data) return;
  const p = pos(e), lg = toLog(p);
  if (MS.stroke) { MS.stroke.x1 = Math.round(lg.x); MS.stroke.y1 = Math.round(lg.y); MS.aim = { x: MS.stroke.x1, y: MS.stroke.y1 }; render(); return; }
  if (MS.drag && MS.drag.kind === 'pan') { MS.aim = null; MS.ox = MS.drag.ox + (p.x - MS.drag.sx); MS.oy = MS.drag.oy + (p.y - MS.drag.sy); render(); return; }
  if (isDrawTool()) { MS.aim = { x: Math.round(lg.x), y: Math.round(lg.y) }; render(); return; }
}
// 松开：不再直接创建，弹出网页内"确认+命名"对话框
function onUp(e) {
  const s = MS.stroke;
  if (s) {
    const x0 = Math.min(s.x0, s.x1 || s.x0), y0 = Math.min(s.y0, s.y1 || s.y0);
    const x1 = Math.max(s.x0, s.x1 || s.x0), y1 = Math.max(s.y0, s.y1 || s.y0);
    const w = x1 - x0, h = y1 - y0;
    MS.stroke = null;
    if (s.kind === 'circle') {
      const cx = (s.x0 + (s.x1 || s.x0)) / 2, cy = (s.y0 + (s.y1 || s.y0)) / 2;
      const r = Math.max(1, Math.hypot((s.x1 || s.x0) - cx, (s.y1 || s.y0) - cy));
      const base = { kind: 'circle', cx, cy, r, floorId: curFloor(), label: '圆形房间' };
      const sn = snapDraft(base, MS.data);
      if (sn.snapTo) tip('已吸附到「' + sn.snapTo + '」旁边（贴紧连通）');
      openCreateDialog(sn.shape);
    } else if (w > 0.5 || h > 0.5) {
      if (s.kind === 'passage') {
        const base = { kind: 'passage', x: Math.round(x0), y: Math.round(y0), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), floorId: curFloor() };
        const sn = snapDraft(base, MS.data);
        if (sn.snapTo) tip('自动贴边并连上「' + sn.snapTo + '」（通道已吸附）');
        createPassageDirect(sn.shape);
      } else {
        const base = { kind: 'rect', x: Math.round(x0), y: Math.round(y0), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), floorId: curFloor(), label: '矩形房间' };
        const sn = snapDraft(base, MS.data);
        if (sn.snapTo) tip('已吸附到「' + sn.snapTo + '」旁边（贴紧连通）');
        openCreateDialog(sn.shape);
      }
    }
  }
  MS.drag = null; render();
  try { M('#mapCanvas').releasePointerCapture(e.pointerId); } catch (err) {}
  syncCursor();
}
function onWheel(e) {
  if (!MS.data) return; e.preventDefault();
  const p = pos(e), lg = toLog(p);
  MS.scale = Math.max(0.2, Math.min(5, MS.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  MS.ox = p.x - lg.x * CELL * MS.scale; MS.oy = p.y - lg.y * CELL * MS.scale;
  render();
}

/* ---- 新建房间确认+命名对话框(网页内) ---- */
// 通道(走廊)无需命名，松开即建（不做命名弹窗）；允许轻微切入对象(≤ADJ)以连通。
function createPassageDirect(shape) {
  const d = MS.data; if (!d) return;
  const probe = { id: uid('P'), floorId: shape.floorId, shape: 'rect', x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  const info = draftInfo(probe, d);
  if (info.deep) { tip('⚠ 通道穿入「' + zoneName(info.deep.zone) + '」过深，未创建。请只轻微搭到它边上即可连通。'); return; }
  const passage = { id: probe.id, x: shape.x, y: shape.y, w: shape.w, h: shape.h, floorId: shape.floorId };
  const op = { t: 'passage.upsert', passage }; pushUndo(op, true); applyLocal([op]); sendOps([op]);
  const hit = info.nearest && info.nearest.gap <= ADJ;
  tip(hit ? ('已画通道，连上「' + zoneName(info.nearest.zone) + '」（贴边/轻切即通）。') : '已画一段通道。伸到房间/通道边 1 格内即连通，圆形可轻微切入。');
}
function openCreateDialog(shape) {
  const d = MS.data; if (!d) return;
  const probe = { id: '__new__', floorId: shape.floorId, shape: shape.kind === 'circle' ? 'circle' : 'rect', cx: shape.cx, cy: shape.cy, r: shape.r, x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  const clash = draftInfo(probe, d).deep;
  let sizeTxt;
  if (shape.kind === 'circle') sizeTxt = '半径 ' + Math.max(1, Math.round(shape.r)) + ' 格';
  else sizeTxt = Math.max(1, shape.w) + ' × ' + Math.max(1, shape.h) + ' 格';
  const title = shape.label;
  const dlg = M('#createDlg'); if (!dlg) return;
  M('#createTitle').textContent = '新建' + title;
  M('#createType').textContent = title + '（' + (shape.floorId ? (floorName(shape.floorId) || shape.floorId) : '') + '）';
  M('#createSize').textContent = '尺寸：' + sizeTxt;
  M('#createName').value = '';
  M('#createClash').style.display = clash ? 'block' : 'none';
  M('#createClash').textContent = clash ? ('⚠ 与「' + zoneName(clash) + '」穿插过深，无法创建。请拖开些。') : '';
  M('#createConfirm').disabled = !!clash;
  dlg.classList.remove('hidden');
  setTimeout(() => M('#createName').focus(), 10);
  MS.createShape = shape;
}
function closeCreateDialog() { const d = M('#createDlg'); if (d) d.classList.add('hidden'); MS.createShape = null; }
function commitCreate() {
  const s = MS.createShape; if (!s) return;
  const d = MS.data; if (!d) return;
  const name = (M('#createName').value || '').trim().slice(0, 20);
  const myFloor = s.floorId;
  const roomOk = (probe) => { const i = draftInfo(probe, d); if (i.deep) { alert('与「' + zoneName(i.deep.zone) + '」穿插过深，无法创建'); return false; } return true; };
  if (s.kind === 'circle') {
    const probe = { id: uid('R'), shape: 'circle', floorId: myFloor, cx: s.cx, cy: s.cy, r: s.r };
    if (!roomOk(probe)) return;
    const room = { id: probe.id, shape: 'circle', floorId: myFloor, cx: s.cx, cy: s.cy, r: Math.max(1, s.r), name, explored: false };
    const op = { t: 'room.upsert', room }; pushUndo(op, true); applyLocal([op]); sendOps([op]);
  } else if (s.kind === 'passage') {
    const probe = { id: uid('P'), floorId: myFloor, shape: 'rect', x: s.x, y: s.y, w: s.w, h: s.h };
    const i = draftInfo(probe, d); if (i.deep) { alert('与「' + zoneName(i.deep.zone) + '」穿插过深，无法创建'); return; }
    const passage = { id: probe.id, x: s.x, y: s.y, w: s.w, h: s.h, floorId: myFloor, name };
    const op = { t: 'passage.upsert', passage }; pushUndo(op, true); applyLocal([op]); sendOps([op]);
  } else {
    const probe = { id: uid('R'), shape: 'rect', floorId: myFloor, x: s.x, y: s.y, w: s.w, h: s.h };
    if (!roomOk(probe)) return;
    const room = { id: probe.id, shape: 'rect', floorId: myFloor, x: s.x, y: s.y, w: s.w, h: s.h, name, explored: false };
    const op = { t: 'room.upsert', room }; pushUndo(op, true); applyLocal([op]); sendOps([op]);
  }
  closeCreateDialog(); render();
}

/* ---- 楼层 UI ---- */
function floorName(id) { const d = MS.data; if (!d || !d.floors) return ''; const f = d.floors.find(x => x.id === id); return f ? f.name : ''; }
function renderFloorTabs() {
  const bar = M('#mapFloors'); const d = MS.data; if (!bar || !d) return;
  if (!isGM) { bar.innerHTML = ''; return; }
  const edit = MS.mode === 'edit';
  const floors = d.floors || [];
  let h = '';
  floors.forEach((f) => { const cur = curFloor() === f.id ? ' active' : ''; h += '<div class="map-floor-tab' + cur + '" data-fid="' + f.id + '">' + (edit ? '<span class="fx">✕</span>' : '') + '<span>' + escapeHtml(f.name) + '</span></div>'; });
  if (edit && floors.length < 6) h += '<div class="map-floor-add" id="mapFloorAdd">＋楼层</div>';
  bar.innerHTML = h;
  bar.querySelectorAll('.map-floor-tab').forEach((tab) => {
    const fx = tab.querySelector('.fx');
    if (fx) fx.addEventListener('click', (ev) => { ev.stopPropagation(); const fid = tab.dataset.fid; if (floors.length <= 1) { alert('至少保留一层'); return; } if (!confirm('删除该层及其所有房间？')) return; const op = { t: 'floor.del', id: fid }; pushUndo(op); applyLocal([op]); sendOps([op]); if (MS.floor === fid) { MS.floor = (d.floors || [])[0] ? (d.floors || [])[0].id : null; } renderFloorTabs(); render(); });
    tab.addEventListener('click', () => { MS.floor = tab.dataset.fid; MS.sel = null; MS.stroke = null; renderFloorTabs(); render(); fit(); });
  });
  const add = M('#mapFloorAdd');
  if (add) add.addEventListener('click', () => { const name = prompt('楼层名（如 2F）') || ''; const fid = uid('F'); const op = { t: 'floor.add', floor: { id: fid, name: (name || '').slice(0, 12) } }; pushUndo(op); applyLocal([op]); sendOps([op]); MS.floor = fid; renderFloorTabs(); render(); });
}

/* ---- 模式切换 UI ---- */
function modeInfo() {
  const d = MS.data; if (!d) return;
  const players = (d.players || {}); let inZone = null;
  for (const zid in players) if (players[zid].some(pl => pl.call === user)) { inZone = zid; break; }
  if (isGM && MS.mode === 'edit') {
    const { rooms, passages } = curZones(d);
    tip((rooms.length + passages.length ? '' : '空楼层，选绘制工具拖出房间/通道 · ') + '本层 ' + rooms.length + ' 房间 / ' + passages.length + ' 通道 · 全图 ' + (d.doors || []).length + ' 门/梯' + (d.entry ? ' · 入口已设' : ' · 未设入口'));
  } else if (isGM && MS.mode === 'show') {
    tip('显示模式（玩家视角）· ' + curFloor() + ' 层 · 仅展示已公开内容');
  } else if (inZone) {
    tip('你在：' + zoneName(zf(inZone)) + '（' + (curFloor() || '') + ' 层）· 聊天框 !go 房间名 移动，!here 查看可去');
  } else {
    tip('打开地图查看本层布局 · 聊天框用 !here / !go 房间名 移动');
  }
}
function applyMode() {
  const gm = isGM, edit = gm && MS.mode === 'edit', d = MS.data;
  // 通用 GM 控件(头部模式/公开/撤销/重做/侧栏绘制组/楼层条)
  const showHeadGm = gm;                 // GM 才显示头部 GM 按钮
  const showEditTools = edit;            // 绘制/楼层等仅编辑模式
  // ① 所有 .gm-only 先按类型显隐
  document.querySelectorAll('#mapModal .gm-only').forEach((el) => {
    if (el.id === 'mapFloors') { el.style.display = gm ? '' : 'none'; return; } // 楼层条：GM 恒显示(编辑切层画/显示预览)
    const isEditTool = el.hasAttribute('data-edit') || (el.classList.contains('tool') && el.closest('.map-sec') && el.closest('.map-sec').hasAttribute('data-edit'));
    if (isEditTool) { el.style.display = showEditTools ? '' : 'none'; }
    else { el.style.display = showHeadGm ? '' : 'none'; }
  });
  M('#mapUndo').style.display = edit ? '' : 'none';
  M('#mapRedo').style.display = edit ? '' : 'none';
  // 编辑模式：绘图工具用画内吸附准星(隐藏系统指针)，其余按工具设光标；显示模式抓手
  MS.aim = null;
  syncCursor();
  // 非编辑(显示模式/玩家)不可绘制：工具归选择，并同步按钮高亮
  if (!edit) {
    MS.tool = 'select'; MS.stroke = null; MS.linkA = null; MS.drag = null;
    document.querySelectorAll('button.tool').forEach(x => x.classList.toggle('active', x.dataset.tool === 'select'));
  }
  renderFloorTabs();
  if (d) modeInfo();
  render();
}

/* ---- 载入 / 开关 ---- */
function loadMap() {
  MS.room = mapRoomId();
  fetch('/api/map?room=' + encodeURIComponent(MS.room) + '&user=' + encodeURIComponent(user) + '&gm=' + encodeURIComponent(gmCode))
    .then(r => r.json()).then(dd => {
      if (!dd || !dd.map) return;
      const first = !MS.data;
      MS.v = dd.v || 0; MS.data = dd.map;
      // 定位当前层
      const floors = dd.map.floors || [];
      // 玩家/显示模式：跟随服务端给出的玩家所在层 curFloor
      if (MS.mode === 'show' || !isGM) { if (dd.map.curFloor) MS.floor = dd.map.curFloor; else if (floors.length) MS.floor = floors[0].id; }
      if (floors.length && !floors.find(f => f.id === MS.floor)) MS.floor = floors[0].id;
      if (!MS.floor && floors.length) MS.floor = floors[0].id;
      renderFloorTabs();
      if (first) { setTimeout(fit, 40); }
      else { render(); }
      modeInfo();
    }).catch(() => {});
}
let mapReloadTimer = null;
function onMapEvent(m) { if (!isOpen() || !m || m.room !== MS.room) return; clearTimeout(mapReloadTimer); mapReloadTimer = setTimeout(loadMap, 200); }
function openMap() {
  const d0 = MS.data;
  M('#mapModal').classList.remove('hidden');
  M('#mapScope').textContent = (typeof roomNames !== 'undefined' && roomNames[mapRoomId()]) || mapRoomId();
  // 初始化模式
  if (isGM) { MS.mode = 'edit'; } else { MS.mode = 'show'; }
  if (MS.data && MS.room !== mapRoomId()) MS.data = null;
  M('#mapDel').classList.add('hidden'); M('#mapEntryBtn').classList.add('hidden'); M('#mapExploreBtn').classList.add('hidden'); M('#mapOpenBtn').classList.add('hidden');
  // 同步按钮态
  const editBtn = M('#mapModeEdit'), showBtn = M('#mapModeShow');
  if (editBtn) editBtn.classList.toggle('on', isGM && MS.mode === 'edit');
  if (showBtn) showBtn.classList.toggle('on', !isGM || MS.mode === 'show');
  applyMode();
  loadMap();
}
function closeMap() { M('#mapModal').classList.add('hidden'); }

function updateAct() {
  const hasSel = !!MS.sel;
  M('#mapDel').classList.toggle('hidden', !hasSel);
  const selRoom = hasSel && MS.selType === 'room' ? zf(MS.sel) : null;
  M('#mapEntryBtn').classList.toggle('hidden', !selRoom);
  M('#mapExploreBtn').classList.toggle('hidden', !selRoom);
  const openBtn = M('#mapOpenBtn');
  if (openBtn) {
    openBtn.classList.toggle('hidden', !selRoom);
    if (selRoom) openBtn.textContent = selRoom.open === false ? '开放' : '关闭';
  }
  if (selRoom) M('#mapExploreBtn').textContent = selRoom.explored ? '隐藏' : '揭晓';
  const lock = M('#mapLockBtn');
  if (lock) {
    const selDoor = hasSel && MS.selType === 'door' ? (MS.data.doors || []).find(x => x.id === MS.sel) : null;
    lock.classList.toggle('hidden', !selDoor);
    if (selDoor) lock.textContent = selDoor.locked ? '开锁' : '锁门';
  }
  M('#mapUndo').disabled = !MS.undo.length;
  M('#mapRedo').disabled = !MS.redo.length;
}
function exportPng() {
  const d = MS.data; if (!d) return;
  const bb = bbox(); if (!bb) return;
  const cvs2 = document.createElement('canvas');
  const C = CELL * 1; const W = Math.max(1, Math.ceil((bb.x1 - bb.x0) * C)), H = Math.max(1, Math.ceil((bb.y1 - bb.y0) * C));
  cvs2.width = W; cvs2.height = H;
  const prevScale = MS.scale, prevOx = MS.ox, prevOy = MS.oy;
  MS.scale = 1; MS.ox = -bb.x0 * C; MS.oy = -bb.y0 * C;
  paint(cvs2.getContext('2d'), W, H);
  MS.scale = prevScale; MS.ox = prevOx; MS.oy = prevOy;
  const a = document.createElement('a'); a.href = cvs2.toDataURL('image/png'); a.download = 'mothership-map-' + curFloor() + '.png';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---- 事件绑定 ---- */
M('#mapBtn').addEventListener('click', openMap);
M('#mapClose').addEventListener('click', closeMap);
M('#mapUndo').addEventListener('click', undoMap);
M('#mapRedo').addEventListener('click', redoMap);
M('#mapPng').addEventListener('click', exportPng);
M('#mapFit').addEventListener('click', fit);
M('#mapZoomIn').addEventListener('click', () => { MS.scale = Math.min(5, MS.scale * 1.25); render(); });
M('#mapZoomOut').addEventListener('click', () => { MS.scale = Math.max(0.2, MS.scale / 1.25); render(); });
// 地图帮助：页面内浮层
const mapHelpDlg = M('#mapHelpDlg');
function openMapHelp() { if (!mapHelpDlg) return; mapHelpDlg.classList.remove('hidden'); setTimeout(() => { const b = M('#mapHelpOk'); if (b) b.focus(); }, 10); }
function closeMapHelp() { if (mapHelpDlg) mapHelpDlg.classList.add('hidden'); }
M('#mapHelp').addEventListener('click', openMapHelp);
const helpOk = M('#mapHelpOk'); if (helpOk) helpOk.addEventListener('click', closeMapHelp);
if (mapHelpDlg) mapHelpDlg.addEventListener('click', (ev) => { if (ev.target === mapHelpDlg) closeMapHelp(); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && mapHelpDlg && !mapHelpDlg.classList.contains('hidden')) closeMapHelp(); });
// 模式切换
const mbEdit = M('#mapModeEdit'), mbShow = M('#mapModeShow');
if (mbEdit) mbEdit.addEventListener('click', () => { if (!isGM) return; MS.mode = 'edit'; mbEdit.classList.add('on'); if (mbShow) mbShow.classList.remove('on'); applyMode(); });
if (mbShow) mbShow.addEventListener('click', () => { if (!isGM) return; MS.mode = 'show'; if (mbEdit) mbEdit.classList.remove('on'); mbShow.classList.add('on'); applyMode(); });
// 删除
M('#mapDel').addEventListener('click', () => {
  if (!MS.sel || !confirm('删除所选元素？')) return;
  const id = MS.sel, type = MS.selType;
  if (type === 'door') { const g = (MS.data.doors || []).find(x => x.id === id); const op = { t: 'door.del', id, door: g }; pushUndo(op); applyLocal([op]); sendOps([op]); }
  else if (type === 'room') { const z = zf(id); const op = { t: 'room.del', id, room: z }; pushUndo(op); applyLocal([op]); sendOps([op]); }
  else if (type === 'passage') { const z = zf(id); const op = { t: 'passage.del', id, passage: z }; pushUndo(op); applyLocal([op]); sendOps([op]); }
  MS.sel = null; updateAct(); render();
});
M('#mapLockBtn').addEventListener('click', () => {
  if (!MS.sel || MS.selType !== 'door') return;
  const g = (MS.data.doors || []).find(x => x.id === MS.sel); if (!g) return;
  const op = { t: 'door.lock', id: g.id, a: g.a, b: g.b, v: !g.locked };
  pushUndo(op); applyLocal([op]); sendOps([op]); updateAct(); render();
});
M('#mapEntryBtn').addEventListener('click', () => {
  if (!MS.sel || MS.selType !== 'room') return;
  const cur = MS.data.entry; const op = { t: 'entry', id: MS.sel }; op.__prev = cur || null;
  pushUndo(op); applyLocal([op]); sendOps([op]); tip('已设为入口'); render();
});
M('#mapExploreBtn').addEventListener('click', () => {
  if (!MS.sel || MS.selType !== 'room') return;
  const r = zf(MS.sel); if (!r) return;
  const op = { t: 'explore', id: MS.sel, v: !r.explored };
  pushUndo(op); applyLocal([op]); sendOps([op]); render();
});
// 开放/关闭某房间：关闭后玩家走不进（通道/门在也不放行）
M('#mapOpenBtn').addEventListener('click', () => {
  if (!MS.sel || MS.selType !== 'room') return;
  const r = zf(MS.sel); if (!r) return;
  const closing = r.open !== false;                     // 当前开放→本次关闭
  const op = { t: 'room.open', id: MS.sel, v: !closing };
  pushUndo(op); applyLocal([op]); sendOps([op]);
  tip(closing ? '已「关闭」：玩家无法进入此房间（通道/门不通行）' : '已「开放」：玩家可进入此房间');
  updateAct(); render();
});
// 一键公开
const pubCur = M('#mapPublishFloor'), pubAll = M('#mapPublishAll');if (pubCur) pubCur.addEventListener('click', () => { if (!isGM) return; const op = { t: 'explore.floor', floor: curFloor(), v: true }; pushUndo(op); applyLocal([op]); sendOps([op]); tip('已公开当前楼层'); render(); });
if (pubAll) pubAll.addEventListener('click', () => { if (!isGM) return; const op = { t: 'explore.all', v: true }; pushUndo(op); applyLocal([op]); sendOps([op]); tip('已公开全部楼层'); render(); });
document.querySelectorAll('button.tool').forEach((b) => {
  b.addEventListener('click', () => {
    MS.tool = b.dataset.tool; MS.linkA = null; MS.stroke = null;
    document.querySelectorAll('button.tool').forEach(x => x.classList.toggle('active', x === b));
    syncCursor();
    if (MS.tool === 'rect') tip('移动鼠标，画内准星会吸到整数格点；在想要的角按住拖出房间');
    else if (MS.tool === 'circle') tip('移动鼠标，准星吸到整数格点；按住拖出半径');
    else if (MS.tool === 'passage') tip('拖出通道（走廊）。伸到房间/通道旁 1 格内即连通，圆可轻微切入；绿框=已连通');
    else if (MS.tool === 'door') tip('点两个相邻(贴边/轻切都算)的对象放一扇门；若两处在不同楼层则自动成“梯”。可再点选门后锁/开锁');
    else if (MS.tool === 'select') tip('点选房间/通道/门；门可锁/开锁/删除；右键拖拽平移');
    else tip('');
  });
});
// 新建对话框
const cd = M('#createDlg');
if (cd) {
  M('#createCancel').addEventListener('click', closeCreateDialog);
  M('#createConfirm').addEventListener('click', commitCreate);
  M('#createName').addEventListener('keydown', (e) => { if (e.key === 'Enter') commitCreate(); if (e.key === 'Escape') closeCreateDialog(); });
}
const cvs = M('#mapCanvas');
cvs.addEventListener('pointerdown', onDown);
cvs.addEventListener('pointermove', onMove);
cvs.addEventListener('pointerup', onUp);
cvs.addEventListener('pointercancel', onUp);
cvs.addEventListener('wheel', onWheel, { passive: false });
cvs.addEventListener('contextmenu', (e) => e.preventDefault());
cvs.addEventListener('pointerleave', () => { if (!MS.stroke && !MS.drag) { MS.aim = null; render(); } });
window.addEventListener('resize', () => { if (isOpen()) render(); });
document.addEventListener('keydown', (e) => {
  if (!isOpen()) return;
  if (e.key === 'Escape') { const cd2 = M('#createDlg'); if (cd2 && !cd2.classList.contains('hidden')) { closeCreateDialog(); return; } MS.linkA = null; MS.stroke = null; MS.tool = 'select'; document.querySelectorAll('button.tool').forEach(x => x.classList.toggle('active', x.dataset.tool === 'select')); render(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redoMap() : undoMap(); }
  if (e.key === 'Delete' || e.key === 'Backspace') { const b = M('#mapDel'); if (b && !b.classList.contains('hidden')) b.click(); }
});

// node 冒烟测试导出
if (typeof module !== 'undefined' && module.exports) { module.exports = { MS, paint, render, fit, applyLocal, doLocal, sendOps, undoMap, redoMap, exportPng, zoneAt, rp, curZones, shapeGap, touches, draftInfo, snapDraft, conflictZone, ADJ }; }
// 浏览器调试钩子
if (typeof window !== 'undefined') { window.__map = { MS, paint, render, fit, openMap, loadMap, applyLocal }; }
