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
function zoneCode(z) {
  if (!z) return '??';
  const f = facInfo(z.type);
  if (f) return f.code;
  return z.shape ? 'RM' : 'PS';   // 有 shape=房间(无 type)回退 RM；无 shape=通道=PS
}
function zoneCenter(z) { if (z.shape === 'poly' && Array.isArray(z.polygon) && z.polygon.length) { let sx = 0, sy = 0; for (const p of z.polygon) { sx += p.x; sy += p.y; } return { x: sx / z.polygon.length, y: sy / z.polygon.length }; } return { x: z.x + z.w / 2, y: z.y + z.h / 2 }; }

// 画布坐标↔逻辑格
function toLog(p) { const c = CELL * MS.scale; return { x: (p.x - MS.ox) / c, y: (p.y - MS.oy) / c }; }
// 命中检测(仅当前层)
function zoneAt(log) {
  const d = MS.data; if (!d) return null;
  const { rooms, passages } = curZones(d);
  for (let i = rooms.length - 1; i >= 0; i--) {
    const z = rooms[i];
    if (z.shape === 'poly') { if (pointInPoly(log, z.polygon)) return { kind: 'room', z }; }
    else if (log.x >= z.x && log.x < z.x + z.w && log.y >= z.y && log.y < z.y + z.h) return { kind: 'room', z };
  }
  for (let i = passages.length - 1; i >= 0; i--) {
    const z = passages[i];
    if (log.x >= z.x && log.x < z.x + z.w && log.y >= z.y && log.y < z.y + z.h) return { kind: 'passage', z };
  }
  return null;
}
// 就近命中：点不在任何对象内部时，返回光标附近(tol 格内)最近的对象，便于点选 1 格细的通道或对象边缘
// excludeId：安门第二次点选时跳过已选的第一端，避免贴边点击反复选回同一房间
function zoneAtNear(log, tol, excludeId) {
  const d = MS.data; if (!d) return null;
  const { rooms, passages } = curZones(d);
  let best = null, bestD = tol;
  const consider = (z, kind) => {
    if (excludeId && z.id === excludeId) return;
    const dist = z.shape === 'poly' ? polyToPoint(log, z.polygon) : distPtRect(log.x, log.y, zbox(z));
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
  if (z.shape === 'poly' && Array.isArray(z.polygon) && z.polygon.length) return polyBBox(z.polygon);
  return { x0: z.x, y0: z.y, x1: z.x + (z.w || 1), y1: z.y + (z.h || 1) };
}
/* 真实几何(与后端一致)：相邻/可走 = 同层真实最短距离 ≤ ADJ。
   贴边(gap≈0)即连通；矩形/多边形均有直边，松手自动吸附贴紧。
   创建只禁"过度穿透"(gap < -ADJ)，即最多切入 1 格。 */
const ADJ = 1;
function distPtRect(x, y, rc) { const dx = Math.max(rc.x0 - x, 0, x - rc.x1), dy = Math.max(rc.y0 - y, 0, y - rc.y1); return Math.hypot(dx, dy); }
function rectRectGap(a, b) {
  const xov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const yov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (xov < 0 && yov < 0) return Math.hypot(-xov, -yov);
  if (xov >= 0 && yov >= 0) return -Math.min(xov, yov);
  return xov < 0 ? -xov : -yov;
}
// ---- 直角多边形几何(轴对齐边, 凸, 顶点贴格点) ----
function polyBBox(poly){ let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity; for(const p of poly){ if(p.x<x0)x0=p.x; if(p.y<y0)y0=p.y; if(p.x>x1)x1=p.x; if(p.y>y1)y1=p.y; } return {x0,y0,x1,y1}; }
function rectPoly(z){ return [{x:z.x,y:z.y},{x:z.x+z.w,y:z.y},{x:z.x+z.w,y:z.y+z.h},{x:z.x,y:z.y+z.h}]; }
function pointInPoly(pt, poly){ let inside=false; for(let i=0,j=poly.length-1;i<poly.length;j=i++){ const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y; if(((yi>pt.y)!==(yj>pt.y))&&(pt.x<(xj-xi)*(pt.y-yi)/(yj-yi)+xi)) inside=!inside; } return inside; }
function pointSeg(p,a,b){ const dx=b.x-a.x,dy=b.y-a.y; const L2=dx*dx+dy*dy; if(L2===0) return Math.hypot(p.x-a.x,p.y-a.y); let t=((p.x-a.x)*dx+(p.y-a.y)*dy)/L2; t=Math.max(0,Math.min(1,t)); return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy)); }
function segPointSeg(a1,a2,b1,b2){ return Math.min(pointSeg(a1,b1,b2),pointSeg(a2,b1,b2),pointSeg(b1,a1,a2),pointSeg(b2,a1,a2)); }
function segIntersect(p1,p2,p3,p4){ const d=(p2.x-p1.x)*(p4.y-p3.y)-(p2.y-p1.y)*(p4.x-p3.x); if(d===0)return false; const t=((p3.x-p1.x)*(p4.y-p3.y)-(p3.y-p1.y)*(p4.x-p3.x))/d; const u=((p3.x-p1.x)*(p2.y-p1.y)-(p3.y-p1.y)*(p2.x-p1.x))/d; return t>=0&&t<=1&&u>=0&&u<=1; }
function polyPolyGap(pa, pb){
  const ba=polyBBox(pa), bb=polyBBox(pb);
  if(rectRectGap(ba,bb) > ADJ*2) return rectRectGap(ba,bb);
  let minD=Infinity;
  for(let i=0;i<pa.length;i++){ const a1=pa[i],a2=pa[(i+1)%pa.length];
    for(let j=0;j<pb.length;j++){ const b1=pb[j],b2=pb[(j+1)%pb.length];
      if(segIntersect(a1,a2,b1,b2)) return 0;
      const dd=segPointSeg(a1,a2,b1,b2); if(dd<minD)minD=dd;
    }
  }
  let inside=false;
  for(const p of pa) if(pointInPoly(p,pb)){inside=true;break;}
  if(!inside) for(const p of pb) if(pointInPoly(p,pa)){inside=true;break;}
  if(inside) return -Math.min(minD,1);
  return minD;
}
function polyToPoint(pt, poly){ let minD=Infinity; for(let i=0;i<poly.length;i++){ const a=poly[i],b=poly[(i+1)%poly.length]; minD=Math.min(minD, pointSeg(pt,a,b)); } return pointInPoly(pt,poly) ? -minD : minD; }
function shapeGap(a, b) {
  const ap = a.shape === 'poly', bp = b.shape === 'poly';
  if (!ap && !bp) return rectRectGap(zbox(a), zbox(b));
  const pa = ap ? a.polygon : rectPoly(a), pb = bp ? b.polygon : rectPoly(b);
  return polyPolyGap(pa, pb);
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
  // 同层：优先落在两包围盒的"共享边"中心点；若两房间之间有缝(不重叠)，
  // 则取该轴上的"缝中点"而非两中心中点，使门卡在两房间连线、不至于飘到虚空。
  const ox0 = Math.max(A.x0, B.x0), ox1 = Math.min(A.x1, B.x1);
  const x = ox1 >= ox0 ? (ox0 + ox1) / 2 : (Math.min(A.x1, B.x1) + Math.max(A.x0, B.x0)) / 2;
  const oy0 = Math.max(A.y0, B.y0), oy1 = Math.min(A.y1, B.y1);
  const y = oy1 >= oy0 ? (oy0 + oy1) / 2 : (Math.min(A.y1, B.y1) + Math.max(A.y0, B.y0)) / 2;
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
  const ca = zoneCode(a), cb = zoneCode(b);
  return ca + (cross ? '(梯)↕' : '↔') + cb + (d.locked ? ' 🔒锁定' : '');
}
function tip(t) { const e = M('#mapTip'); if (e) e.innerHTML = t || ''; }

/* ---- 编辑绘图"内部光标"(吸附准星) ----
   想法：编辑模式用绘图工具时，不依赖系统鼠标，而是隐藏原生指针并显示一个吸附到
   最近整数格点的准星(MS.aim)。真正的"落点"以准星为准，房间边界永远贴齐准星，
   这样贴出来的边和你能看到的瞄准点完全一致，不再出现"边离鼠标很远"的偏差。 */
function isDrawTool() { return isGM && MS.mode === 'edit' && (MS.tool === 'rect' || MS.tool === 'poly' || MS.tool === 'passage'); }
function syncCursor() {
  const cv = M('#mapCanvas'); if (!cv) return;
  const doorTool = isGM && MS.mode === 'edit' && MS.tool === 'door';
  if (isDrawTool() || doorTool) { cv.style.cursor = 'none'; }  // 隐藏系统指针，用画内准星代替
  else if (isGM && MS.mode === 'edit') cv.style.cursor = MS.tool === 'select' ? 'grab' : 'crosshair';
  else cv.style.cursor = 'grab';
  if (!(isDrawTool() || doorTool)) MS.aim = null;              // 非绘图/门工具时无准星
  updateAimOverlay();
}
function drawAim(ctx) {
  const a = MS.aim; if (!a) return;
  const c = CELL * MS.scale;
  const px = rp(a.x), py = rpY(a.y);
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

// 游戏内准星(DOM 浮层)：绘图/门工具下跟随指针显示，必可见，并标出吸附到的整数格点坐标。
function updateAimOverlay() {
  const el = M('#mapAim'); if (!el) return;
  const show = isDrawTool() || (isGM && MS.mode === 'edit' && MS.tool === 'door');
  if (!show || !MS.aim) { el.classList.remove('show'); return; }
  const px = rp(MS.aim.x), py = rpY(MS.aim.y);
  el.style.left = px + 'px'; el.style.top = py + 'px';
  const coord = el.querySelector('.aim-coord'); if (coord) coord.textContent = '(' + MS.aim.x + ', ' + MS.aim.y + ')';
  el.classList.add('show');
}
/* ---- 创建放行校验(同层)：禁止"过度穿透" ---- */
// 允许贴边与轻微切入(≤ADJ)；仅当切入超过 ADJ 才视为非法重叠(该对象被穿太多)。
// 返回冲突对象(需拒绝) 或 null(可创建)。这样通道能轻微搭到房间/矩形旁即可连通。
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
// 草稿形状与已有对象的关系：返回最"近"的一个 { zone, gap }（gap≤0 表示已相贴/相切）。
// 用于创建提示：红色=穿透过深；绿=已连通(贴边/相切)；黄=尚需拉近。
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
  // 在吸附范围内(含轻微切入)：平移到恰好相贴(gap→0)，避免通道压进房间造成重叠
  if (Math.abs(g) > ADJ) return { shape, snapTo: '' };
  const cb = zoneCenter(nb), cn = zoneCenter(probe);
  const dx = cb.x - cn.x, dy = cb.y - cn.y;
  const axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
  const dir = axis === 'x' ? (dx >= 0 ? 1 : -1) : (dy >= 0 ? 1 : -1);
  // 按主轴向目标移动使接触；g>0 靠近，g<0(切入)拉回
  const out = JSON.parse(JSON.stringify(shape));
  if (axis === 'x') out.x += dir * g; else out.y += dir * g;
  out.x = Math.round(out.x); out.y = Math.round(out.y);   // 矩形/通道取整回网格
  const probe2 = shapeToZone(out, '__snap__');
  const i2 = draftInfo(probe2, d);
  if (i2.deep) return { shape, snapTo: '' };
  if (i2.nearest && i2.nearest.gap > -ADJ && i2.nearest.gap <= ADJ) return { shape: out, snapTo: zoneName(nb) };
  return { shape, snapTo: '' };
}
function shapeToZone(shape, id) {
  const fid = shape.floorId || 'F1';
  if (shape.kind === 'poly') return { id: id || '__new__', floorId: fid, shape: 'poly', polygon: shape.polygon, type: shape.type || '' };
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
    else if (op.t === 'room.del') { d.rooms = (d.rooms || []).filter(x => x.id !== op.id); if (d.entry === op.id) d.entry = null; }
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
    else if (op.t === 'types.set') { d.customTypes = op.types || []; }
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
  if (op.t === 'types.set') return [{ t: 'types.set', types: op.__prev || [] }];
  return [];
}
function pushUndo(op, marker) { if (marker) op.__new = true; MS.undo.push(op); if (MS.undo.length > 60) MS.undo.shift(); MS.redo = []; }

/* ---- 绘制 ---- */
function rp(x) { return MS.ox + x * CELL * MS.scale; }
function rpY(y) { return MS.oy + y * CELL * MS.scale; }
function paint(ctx, W, H) {
  const d = MS.data; if (!d) return;
  const showGrid = MS.mode === 'edit';
  const gbg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.15, W / 2, H / 2, Math.max(W, H) * 0.75);
  gbg.addColorStop(0, '#101823'); gbg.addColorStop(1, '#05080c');
  ctx.fillStyle = gbg; ctx.fillRect(0, 0, W, H);
  const inView = (x, y) => x > -60 && x < W + 60 && y > -60 && y < H + 60;
  const c = CELL * MS.scale;
  const myFloor = curFloor();
  if (showGrid) {
    const g0x = Math.floor(-MS.ox / c) | 0, g1x = Math.ceil((W - MS.ox) / c) | 0;
    const g0y = Math.floor(-MS.oy / c) | 0, g1y = Math.ceil((H - MS.oy) / c) | 0;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.beginPath();
    for (let g = g0x; g <= g1x; g++) { if (g % 5 === 0) continue; const x = rp(g); if (inView(x, 0)) { ctx.moveTo(x, 0); ctx.lineTo(x, H); } }
    for (let g = g0y; g <= g1y; g++) { if (g % 5 === 0) continue; const y = rpY(g); if (inView(0, y)) { ctx.moveTo(0, y); ctx.lineTo(W, y); } }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.20)'; ctx.beginPath();
    for (let g = g0x; g <= g1x; g++) { if (g % 5 !== 0) continue; const x = rp(g); if (inView(x, 0)) { ctx.moveTo(x, 0); ctx.lineTo(x, H); } }
    for (let g = g0y; g <= g1y; g++) { if (g % 5 !== 0) continue; const y = rpY(g); if (inView(0, y)) { ctx.moveTo(0, y); ctx.lineTo(W, y); } }
    ctx.stroke();
    const oxp = rp(0), oyp = rpY(0);
    if (inView(oxp, oyp)) { ctx.strokeStyle = 'rgba(255,210,120,0.85)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(oxp - 8, oyp); ctx.lineTo(oxp + 8, oyp); ctx.moveTo(oxp, oyp - 8); ctx.lineTo(oxp, oyp + 8); ctx.stroke(); ctx.fillStyle = 'rgba(255,210,120,0.9)'; ctx.font = '10px system-ui,sans-serif'; ctx.textAlign = 'left'; ctx.fillText('0,0', oxp + 10, oyp - 6); }
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '10px system-ui,sans-serif';
    for (let g = g0x; g <= g1x; g++) { if (g % 5 !== 0) continue; const x = rp(g); if (inView(x, 12)) ctx.fillText(String(g), x + 2, 11); }
    for (let g = g0y; g <= g1y; g++) { if (g % 5 !== 0) continue; const y = rpY(g); if (inView(12, y)) ctx.fillText(String(g), 2, y - 2); }
  }
  // zones(当前层)：先统一填充，再统一描边并互相抠掉相接处，使连通的房间/通道看起来一体
  let zs = curZones(d);
  // 侧栏小地图：只渲染已揭晓的房间（未揭晓的直接不画，连雾块都不留）
  // 例外：entryVisible=true 时强制把入口房间显示出来（不依赖探索）
  if (MS.__mini) {
    const dL = MS.data;
    const eid = dL && dL.entry;
    const ev = !!(dL && dL.entryVisible);
    zs = {
      rooms: zs.rooms.filter((r) => r.explored || (ev && r.id === eid)),
      passages: zs.passages
    };
  }
  const kinds = new Map();
  for (const r of zs.rooms) kinds.set(r.id, 'room');
  for (const p of zs.passages) kinds.set(p.id, 'passage');
  drawZones(ctx, zs.rooms.concat(zs.passages), kinds);
  // 门/梯画在房间之上（含选中高亮）
  drawDoors(ctx);
  // 入口标记。大地图：房间顶部「★入口」+ 中心★；小地图：入口房间高亮虚线框 + 顶部 ENTRY 小签（只画一个标记）。
  // 未公开的入口房间在小地图上不画任何标记（与"只画已揭晓"一致，避免出现孤零零的星）。
  const entry = d.entry ? zf(d.entry) : null;
  if (entry && (entry.floorId || 'F1') === myFloor && !(MS.__mini && hiddenInMini(entry))) {
    const z = entry, ec = zoneCenter(z), bb = zbox(z);
    if (MS.__mini) {
      const c2 = CELL * MS.scale;
      const ex = rp(bb.x0) - 3, ey = rpY(bb.y0) - 3;
      const ew = (bb.x1 - bb.x0) * c2 + 6, eh = (bb.y1 - bb.y0) * c2 + 6;
      ctx.save();
      ctx.strokeStyle = '#eaffc9'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.strokeRect(ex, ey, ew, eh);
      ctx.setLineDash([]);
      if (ey >= 14) {                       // 顶部空间够才画小签，避免出界
        ctx.font = 'bold 9px system-ui,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#eaffc9';
        ctx.fillText('▲ ENTRY', rp(ec.x), ey - 4);
      }
      ctx.restore();
      ctx.textAlign = 'left';
    } else {
      const topY = rpY(bb.y0) - 4;
      ctx.fillStyle = '#eaffc9'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('★入口', rp(ec.x), topY - 4);
      ctx.font = 'bold ' + Math.max(14, c * 0.5) + 'px sans-serif';
      ctx.fillText('★', rp(ec.x), rpY(ec.y) + 6);
      ctx.textAlign = 'left';
    }
  }
  // players(仅当前层)
  drawPlayers(ctx);
  // 拖拽预览(编辑模式)
  drawStroke(ctx);
  // 编辑绘图"内部光标"(吸附准星)，置于最上层，始终标示真实落点
  drawAim(ctx);
  ctx.textAlign = 'left';
}
// 基础飞船设施分类(自己设计, 不照抄参考图)。房间 type 用短码, 前端按此配色。
const FACILITIES = [
  { code: 'BR',  name: '舰桥',   fill: 'rgba(120,95,20,0.92)',  line: '#ffd76a' },
  { code: 'COM', name: '通讯',   fill: 'rgba(20,90,110,0.92)',  line: '#6fe0ff' },
  { code: 'MES', name: '餐厅',   fill: 'rgba(110,70,20,0.92)',  line: '#ffb45e' },
  { code: 'CRW', name: '船员舱', fill: 'rgba(20,80,50,0.92)',   line: '#5cf0a0' },
  { code: 'MED', name: '医疗舱', fill: 'rgba(110,30,55,0.92)',  line: '#ff8fb0' },
  { code: 'CRY', name: '低温舱', fill: 'rgba(20,60,110,0.92)',  line: '#7fb0ff' },
  { code: 'REA', name: '反应堆', fill: 'rgba(70,30,100,0.92)',  line: '#c79bff' },
  { code: 'ENG', name: '工程舱', fill: 'rgba(80,55,25,0.92)',   line: '#d6a86a' },
  { code: 'CRG', name: '货舱',   fill: 'rgba(70,75,80,0.92)',   line: '#c2cbd2' },
  { code: 'AIR', name: '气闸',   fill: 'rgba(90,95,100,0.92)',  line: '#e8edf2' },
  { code: 'STO', name: '储藏',   fill: 'rgba(35,70,45,0.92)',   line: '#86e0b0' }
];
function facInfo(code) {
  const f = FACILITIES.find((x) => x.code === code);
  if (f) return f;
  const cust = (MS.data && MS.data.customTypes) || [];
  return cust.find((x) => x.code === code) || null;
}
function zoneStyle(z, kind) {
  const showMode = MS.mode === 'show';
  const isUnrevealed = kind === 'room' && showMode && !isGM && !z.explored;
  if (kind === 'passage') return { fill: 'rgba(150,158,168,0.40)', line: 'rgba(255,255,255,0.85)', isUnrevealed: false };
  if (isUnrevealed) return { fill: 'rgba(74,82,92,0.55)', line: 'rgba(205,213,221,0.55)', isUnrevealed: true };
  const f = facInfo(z.type);
  if (f) return { fill: f.fill, line: f.line, isUnrevealed: false };
  return { fill: 'rgba(54,62,72,0.95)', line: 'rgba(255,255,255,0.90)', isUnrevealed: false };
}
// zonePath 支持多边形/矩形房间
function zonePath(ctx, z, pad) {
  const c = CELL * MS.scale;
  if (z.shape === 'poly' && Array.isArray(z.polygon) && z.polygon.length) {
    ctx.moveTo(rp(z.polygon[0].x), rpY(z.polygon[0].y));
    for (let i = 1; i < z.polygon.length; i++) ctx.lineTo(rp(z.polygon[i].x), rpY(z.polygon[i].y));
    ctx.closePath();
  } else {
    const p = pad ? pad * c : 0;
    ctx.rect(rp(z.x) - p, rpY(z.y) - p, (z.w + 2 * pad) * c, (z.h + 2 * pad) * c);
  }
}
function fillZone(ctx, z, kind) {
  const { fill } = zoneStyle(z, kind);
  ctx.fillStyle = fill;
  ctx.beginPath(); zonePath(ctx, z, 0); ctx.fill();
}
function strokeZone(ctx, z, kind) {
  const { line } = zoneStyle(z, kind);
  ctx.beginPath(); zonePath(ctx, z, 0);
  ctx.strokeStyle = line; ctx.lineWidth = 2.5; ctx.stroke();
}
// 把区域边界拆成轴对齐边（直角多边形/矩形）。返回 [{x1,y1,x2,y2}]（轴对齐）。
function zoneEdges(z) {
  if (z.shape === 'poly' && Array.isArray(z.polygon) && z.polygon.length) {
    const e = [];
    for (let i = 0; i < z.polygon.length; i++) { const a = z.polygon[i], b = z.polygon[(i + 1) % z.polygon.length]; e.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }); }
    return e;
  }
  const x0 = z.x, y0 = z.y, x1 = z.x + z.w, y1 = z.y + z.h;
  return [
    { x1: x0, y1: y0, x2: x1, y2: y0 }, { x1: x1, y1: y0, x2: x1, y2: y1 },
    { x1: x1, y1: y1, x2: x0, y2: y1 }, { x1: x0, y1: y1, x2: x0, y2: y0 }
  ];
}
// 两轴对齐边的共线重叠子段；tol 为共线容差，重叠过短(≤0.1)视为拐角不算共享墙
function edgeOverlap(a, b, tol) {
  const ha = Math.abs(a.y1 - a.y2) < 1e-6, va = Math.abs(a.x1 - a.x2) < 1e-6;
  const hb = Math.abs(b.y1 - b.y2) < 1e-6, vb = Math.abs(b.x1 - b.x2) < 1e-6;
  if (ha && hb) {
    if (Math.abs(a.y1 - b.y1) > tol) return null;
    const ax0 = Math.min(a.x1, a.x2), ax1 = Math.max(a.x1, a.x2), bx0 = Math.min(b.x1, b.x2), bx1 = Math.max(b.x1, b.x2);
    const lo = Math.max(ax0, bx0), hi = Math.min(ax1, bx1);
    if (hi - lo <= 0.1) return null;
    return { x1: lo, y1: a.y1, x2: hi, y2: a.y1 };
  }
  if (va && vb) {
    if (Math.abs(a.x1 - b.x1) > tol) return null;
    const ay0 = Math.min(a.y1, a.y2), ay1 = Math.max(a.y1, a.y2), by0 = Math.min(b.y1, b.y2), by1 = Math.max(b.y1, b.y2);
    const lo = Math.max(ay0, by0), hi = Math.min(ay1, by1);
    if (hi - lo <= 0.1) return null;
    return { x1: a.x1, y1: lo, x2: a.x1, y2: hi };
  }
  return null;
}
// 凸多边形带符号面积(用于判断顺/逆时针，决定半平面"内侧"方向)
function polySignedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
// 把一段线段按有向边 a->b 的"内侧"(ccw 时取左)裁剪，返回 [p1,p2] 或 null
function clipSegByLine(p1, p2, a, b, ccw) {
  const cross = (x1, y1, x2, y2) => x1 * y2 - y1 * x2;
  const d1 = cross(b.x - a.x, b.y - a.y, p1.x - a.x, p1.y - a.y);
  const d2 = cross(b.x - a.x, b.y - a.y, p2.x - a.x, p2.y - a.y);
  const inside = (d) => ccw ? d >= -1e-9 : d <= 1e-9;
  if (inside(d1) && inside(d2)) return [p1, p2];
  if (!inside(d1) && !inside(d2)) return null;
  const t = d1 / (d1 - d2);
  const ip = { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
  return inside(d1) ? [p1, ip] : [ip, p2];
}
// 线段与凸多边形的交子段(用于求"通道墙在多边形内的部分")；返回同形状的子段或 null
function clipSegToPoly(s, poly) {
  const area = polySignedArea(poly);
  if (Math.abs(area) < 1e-9) return null;
  const ccw = area > 0;
  let p1 = { x: s.x1, y: s.y1 }, p2 = { x: s.x2, y: s.y2 };
  if (Math.abs(p1.x - p2.x) < 1e-9 && Math.abs(p1.y - p2.y) < 1e-9) return null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const r = clipSegByLine(p1, p2, a, b, ccw);
    if (!r) return null;
    p1 = r[0]; p2 = r[1];
  }
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}
// 轴对齐边 e 在对象 z(矩形或多边形)内部的子段；用于把"穿进对象里的墙"也抠掉(斜多边形边也能自然接上)
function edgeInsideZone(e, z) {
  const horiz = Math.abs(e.y1 - e.y2) < 1e-6;
  if (z.shape === 'poly') {
    if (!Array.isArray(z.polygon) || z.polygon.length < 3) return null;
    return clipSegToPoly(e, z.polygon);
  }
  if (horiz) {
    const Y = e.y1;
    if (Y < z.y || Y > z.y + z.h) return null;
    const ax0 = Math.min(e.x1, e.x2), ax1 = Math.max(e.x1, e.x2);
    const lo = Math.max(ax0, z.x), hi = Math.min(ax1, z.x + z.w);
    if (hi - lo <= 1e-6) return null;
    return { x1: lo, y1: Y, x2: hi, y2: Y };
  } else {
    const X = e.x1;
    if (X < z.x || X > z.x + z.w) return null;
    const ay0 = Math.min(e.y1, e.y2), ay1 = Math.max(e.y1, e.y2);
    const lo = Math.max(ay0, z.y), hi = Math.min(ay1, z.y + z.h);
    if (hi - lo <= 1e-6) return null;
    return { x1: X, y1: lo, x2: X, y2: hi };
  }
}
// 在一条轴对齐边上，去掉若干区间(cuts)后描出剩余段
function drawEdgeMinusCuts(ctx, e, cuts) {
  const horiz = Math.abs(e.y1 - e.y2) < 1e-6;
  if (cuts.length) {
    cuts.sort((p, q) => p[0] - q[0]);
    const mg = [];
    for (const c of cuts) { if (mg.length && c[0] <= mg[mg.length - 1][1]) mg[mg.length - 1][1] = Math.max(mg[mg.length - 1][1], c[1]); else mg.push([c[0], c[1]]); }
    const s = horiz ? Math.min(e.x1, e.x2) : Math.min(e.y1, e.y2);
    const en = horiz ? Math.max(e.x1, e.x2) : Math.max(e.y1, e.y2);
    let cur = s;
    for (const [a, b] of mg) {
      if (a > cur) { ctx.beginPath(); if (horiz) { ctx.moveTo(rp(cur), rpY(e.y1)); ctx.lineTo(rp(Math.min(a, en)), rpY(e.y1)); } else { ctx.moveTo(rp(e.x1), rpY(cur)); ctx.lineTo(rp(e.x1), rpY(Math.min(a, en))); } ctx.stroke(); }
      cur = Math.max(cur, b);
      if (cur >= en) break;
    }
    if (cur < en) { ctx.beginPath(); if (horiz) { ctx.moveTo(rp(cur), rpY(e.y1)); ctx.lineTo(rp(en), rpY(e.y1)); } else { ctx.moveTo(rp(e.x1), rpY(cur)); ctx.lineTo(rp(e.x1), rpY(en)); } ctx.stroke(); }
  } else {
    ctx.beginPath(); ctx.moveTo(rp(e.x1), rpY(e.y1)); ctx.lineTo(rp(e.x2), rpY(e.y2)); ctx.stroke();
  }
}
// 描边：通道(走廊)与房间/通道相接的共享墙"抠掉"，合并成一体；房间↔房间之间保留墙
function strokeZoneMerged(ctx, z, kind, zones, kinds) {
  const st = zoneStyle(z, kind);
  ctx.strokeStyle = st.line; ctx.lineWidth = 2.5;
  const isP = kind === 'passage';
  for (const e of zoneEdges(z)) {
    const diag = Math.abs(e.x1 - e.x2) > 1e-6 && Math.abs(e.y1 - e.y2) > 1e-6;
    if (diag) { ctx.beginPath(); ctx.moveTo(rp(e.x1), rpY(e.y1)); ctx.lineTo(rp(e.x2), rpY(e.y2)); ctx.stroke(); continue; }
    // 共享墙一定由 snapDraft 取整到完全共线(误差=0)，故用极小阈值严格判定共线，
    // 避免与"平行但相距约 1 格的墙"误判为同一面墙而错误抠除(如通道底墙 vs 多边形顶墙)
    const cuts = []; const tol = 1e-6;
    for (const o of zones) {
      if (o === z) continue;
      const ok = kinds.get(o.id);
      if (kind === 'room' && ok === 'room') continue;   // 房间↔房间：保留墙
      // 规则：通道可以被切割以贴合房间的边，房间的边不行（房间边界为权威，绝不切房间的墙）
      if (!isP) continue;                              // 只对通道做共线/穿入裁剪；房间的墙完整保留
      for (const oe of zoneEdges(o)) {
        const ov = edgeOverlap(e, oe, tol);
        if (ov) cuts.push(Math.abs(e.y1 - e.y2) < 1e-6 ? [Math.min(ov.x1, ov.x2), Math.max(ov.x1, ov.x2)] : [Math.min(ov.y1, ov.y2), Math.max(ov.y1, ov.y2)]);
      }
      // 通道的墙：凡是"穿进"任何房间/多边形/另一通道内部的部分也抠掉(即使不共线，斜多边形边也能自然接上)
      if (ok === 'room' || ok === 'passage') {
        const ins = edgeInsideZone(e, o);
        if (ins) cuts.push(Math.abs(e.y1 - e.y2) < 1e-6 ? [Math.min(ins.x1, ins.x2), Math.max(ins.x1, ins.x2)] : [Math.min(ins.y1, ins.y2), Math.max(ins.y1, ins.y2)]);
      }
    }
    drawEdgeMinusCuts(ctx, e, cuts);
  }
}
function drawZones(ctx, zones, kinds) {
  const ordered = zones.slice().sort((a, b) => (kinds.get(a.id) === 'passage' ? 0 : 1) - (kinds.get(b.id) === 'passage' ? 0 : 1));
  for (const z of ordered) fillZone(ctx, z, kinds.get(z.id));   // 先通道后房间/多边形
  // 描边：通道一侧被切去贴合房间/通道的边（房间边为权威、保持完整；房间↔房间保留墙）
  for (const z of zones) strokeZoneMerged(ctx, z, kinds.get(z.id), zones, kinds);
  // 角标/名称/选中框（drawZone 此前未被调用，这里补上，使两位缩写真正显示在房间上）
  for (const z of zones) drawZone(ctx, z, kinds.get(z.id));
}
function drawZone(ctx, z, kind) {
  const c = CELL * MS.scale, sel = MS.sel && MS.selType !== 'door' && MS.sel === z.id;
  const isUnrevealed = zoneStyle(z, kind).isUnrevealed;
  const ec = zoneCenter(z), bb = zbox(z);
  const hw = (bb.x1 - bb.x0) / 2 * c, hh = (bb.y1 - bb.y0) / 2 * c;
  if (sel) { ctx.strokeStyle = '#ffd76a'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.strokeRect(rp(ec.x) - hw - 3, rpY(ec.y) - hh - 3, hw * 2 + 6, hh * 2 + 6); ctx.setLineDash([]); }
  // 设施短码(左上角徽标)：科幻风，深底亮字；编辑/显示均显示；仅房间，无 type 回退 RM
  if (kind === 'room') {
    const f = facInfo(z.type);
    const code = f ? f.code : 'RM';
    const codeCol = f ? f.line : '#ffffff';
    const fs = Math.max(10, c * 0.34);
    ctx.font = 'bold ' + fs + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const tx = rp(bb.x0) + 4, ty = rpY(bb.y0) + 4;
    const tw = ctx.measureText(code).width;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(tx - 3, ty - 2, tw + 8, fs + 7, 4);
    else ctx.rect(tx - 3, ty - 2, tw + 8, fs + 7);
    ctx.fillStyle = 'rgba(4,12,8,0.82)'; ctx.fill();
    ctx.fillStyle = codeCol; ctx.fillText(code, tx, ty);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  if (z.name) {
    const label = z.name + (isUnrevealed ? ' (未揭示)' : '');
    ctx.font = 'bold ' + Math.max(10, c * 0.4) + 'px system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = isUnrevealed ? 'rgba(205,215,225,0.8)' : '#ffffff';
    ctx.fillText(label, rp(ec.x), rpY(ec.y));
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  // 未开放(open=false)标记
  if (kind === 'room' && z.open === false) {
    ctx.font = 'bold ' + Math.max(10, c * 0.34) + 'px system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff9d9d';
    ctx.fillText('🔒 未开放', rp(ec.x), rpY(ec.y) + hh * 0.72);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
}
// 小地图：未揭晓的房间不画，所以连着它的门也要一并藏起来
function hiddenInMini(z) {
  if (!z) return true;
  if (!MS.__mini) return false;
  if (!z.shape) return false;                  // 通道永远可见
  if (z.explored) return false;               // 已揭晓：可见
  const d = MS.data;
  if (d && d.entryVisible && d.entry && z.id === d.entry) return false;   // 入口可见开关：强制显示入口
  return true;
}
function drawDoors(ctx) {
  const d = MS.data, myFloor = curFloor(); if (!d) return;
  for (const g of (d.doors || [])) {
    const a = zf(g.a), b = zf(g.b); if (!a || !b) continue;
    if (MS.__mini && (hiddenInMini(a) || hiddenInMini(b))) continue;
    const hereA = (a.floorId || 'F1') === myFloor, hereB = (b.floorId || 'F1') === myFloor;
    if (!hereA && !hereB) continue;                                  // 两端都不在本层
    const isSel = MS.sel && MS.selType === 'door' && MS.sel === g.id;
    drawDoor(ctx, g, isSel);                                          // 门/梯画在房间之上
  }
}
function drawDoor(ctx, g, isSel) {
  const a = zf(g.a), b = zf(g.b); if (!a || !b) return;
  const c = CELL * MS.scale;
  const cross = (a.floorId || 'F1') !== (b.floorId || 'F1');
  const aP = !a.shape, bP = !b.shape, passageRoom = !cross && (aP !== bP);
  // 门的锚/朝向/尺寸：跟着"链接点"走——锚在两区域连接点(doorAnchor)，
  // 方向由连接方向决定(oy>=ox => 竖直相接 => 杆竖放)，大小按连接类型固定(通道↔房间放大)
  const an = doorAnchor(g); if (!an) return;
  const px = rp(an.x), py = rpY(an.y);
  let vert = true;
  if (!cross) {
    const A = zbox(a), B = zbox(b);
    const ox = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
    const oy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
    vert = oy >= ox;
  }
  const sz = passageRoom ? Math.max(14, c * 1.0) : Math.max(8, c * 0.5);
  const col = cross ? '#e6c860' : '#ffffff';
  const lineCol = g.locked ? '#ff8f6b' : col;
  // 主体：门为一条横跨"缝"的短杆 + 端点；锁则加锁点；梯画 ↕
  ctx.save();
  ctx.strokeStyle = lineCol; ctx.lineWidth = passageRoom ? 3.5 : 2.5;
  ctx.beginPath();
  if (cross) { ctx.setLineDash([5, 4]); ctx.moveTo(px - sz * 0.5, py); ctx.lineTo(px + sz * 0.5, py); ctx.moveTo(px, py - sz * 0.5); ctx.lineTo(px, py + sz * 0.5); ctx.setLineDash([]); }
  else if (vert) { ctx.moveTo(px, py - sz / 2); ctx.lineTo(px, py + sz / 2); }
  else { ctx.moveTo(px - sz / 2, py); ctx.lineTo(px + sz / 2, py); }
  ctx.stroke();
  // 通道↔房间门：填充一块半透明"门扇"，让合并开口处读作门洞而非一根细线
  if (passageRoom) {
    const lw = vert ? Math.max(7, c * 0.5) : sz * 0.82;
    const lh = vert ? sz * 0.82 : Math.max(7, c * 0.5);
    ctx.fillStyle = g.locked ? 'rgba(255,143,107,0.20)' : 'rgba(255,255,255,0.16)';
    const rx = px - lw / 2, ry = py - lh / 2;
    if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(rx, ry, lw, lh, Math.min(4, lw / 2, lh / 2)); ctx.fill(); }
    else ctx.fillRect(rx, ry, lw, lh);
  }
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
  // 标签：用两位英文缩写(与房间角标一致)，等宽字体更科幻
  const la = zoneCode(a), lb = zoneCode(b);
  ctx.fillStyle = g.locked ? '#ffb28f' : (cross ? '#ffe9a8' : '#ffffff');
  ctx.font = 'bold ' + Math.max(9, c * 0.32) + 'px ui-monospace, Menlo, Consolas, monospace'; ctx.textAlign = 'center';
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
    if (MS.__mini && hiddenInMini(z)) continue;    // 小地图：未公开房间里的玩家不画
    for (const pl of d.players[zid]) {
      const cx = rp(pl.x + 0.5), cy = rpY(pl.y + 0.5), R = Math.max(6, c * 0.34);
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = colFor(pl.call); ctx.fill();
      if (pl.call === user) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke(); }
      ctx.fillStyle = '#08121a'; ctx.font = 'bold ' + Math.max(9, R) + 'px system-ui,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText((pl.call || '?').slice(0, 1), cx, cy + 0.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
  }
}
// 拖拽预览(矩形/多边形/通道): 虚线框 + 尺寸 + 状态色(绿=已连通/黄=需拉近/红=穿透过深)
function drawStroke(ctx) {
  const c = CELL * MS.scale; const myFloor = curFloor();
  // 多边形房间预览(逐点放置顶点)
  if (MS.polyPts && MS.polyPts.length) {
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(rp(MS.polyPts[0].x), rpY(MS.polyPts[0].y));
    for (let i = 1; i < MS.polyPts.length; i++) ctx.lineTo(rp(MS.polyPts[i].x), rpY(MS.polyPts[i].y));
    if (MS.aim) ctx.lineTo(rp(MS.aim.x), rpY(MS.aim.y));
    ctx.stroke(); ctx.setLineDash([]);
    for (const p of MS.polyPts) { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(rp(p.x), rpY(p.y), 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#ffffff'; ctx.font = '12px system-ui,sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('多边形房间：点击放顶点，双击/点首点闭合（已 ' + MS.polyPts.length + ' 点）', rp(MS.polyPts[0].x), rpY(MS.polyPts[0].y) - 8);
  }
  const s = MS.stroke; if (!s || !s.x1) return;
  const kindName = s.kind === 'passage' ? '通道' : '矩形房间';
  const x0 = Math.min(s.x0, s.x1), y0 = Math.min(s.y0, s.y1), w = Math.abs(s.x1 - s.x0), h = Math.abs(s.y1 - s.y0);
  const px = rp(x0), py = rpY(y0), pw = Math.max(1, w * c), ph = Math.max(1, h * c);
  const probe = { id: '__new__', floorId: myFloor, shape: 'rect', x: Math.round(x0), y: Math.round(y0), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  const info = draftInfo(probe, MS.data);
  const st = strokeState(info);
  ctx.strokeStyle = st.col; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(px, py, pw, ph); ctx.setLineDash([]);
  ctx.fillStyle = st.col === '#ff6b6b' ? 'rgba(255,107,107,0.14)' : (st.ok ? 'rgba(255,255,255,0.14)' : 'rgba(255,215,106,0.12)'); ctx.fillRect(px, py, pw, ph);
  ctx.fillStyle = st.col; ctx.font = '12px system-ui,sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(kindName + ' ' + Math.max(1, Math.round(w)) + '×' + Math.max(1, Math.round(h)) + st.txt, px, py - 6);
}
function strokeState(info) {
  if (!info) return { col: '#ffd76a', ok: false, txt: '' };
  if (info.deep) return { col: '#ff6b6b', ok: false, txt: ' ⚠穿入过深(' + zoneLabel1(info.deep.zone) + ')' };
  if (info.nearest && info.nearest.gap <= ADJ) return { col: '#ffffff', ok: true, txt: ' ✓连通 ' + zoneLabel1(info.nearest.zone) };
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
  renderLegend();
  renderRoomList();
  updateAimOverlay();
  updatePub();
  renderMini();                    // 大地图有改动时同步侧栏小地图
}
/* ---- 侧栏小地图：玩家视角（只画已揭晓 · 自动适应小窗 · 标出自己） ----
   实现要点：临时改 MS.mode / MS.floor / MS.ox / MS.oy / MS.scale 后调用 paint()，
   画完立刻还原，因此不会污染大地图弹窗的视图与编辑状态。            */
function miniOn() {
  const p = M('#sidePanel');
  if (!p || p.classList.contains('collapsed')) return false;
  // 手机版：侧栏是 position:fixed（offsetParent 恒为 null），改用标签类判断，只在雷达页绘制
  if (document.body.classList.contains('mobile')) return document.body.classList.contains('tab-radar');
  return p.offsetParent !== null;
}
function myZoneId() {
  const d = MS.data; if (!d) return null;
  const players = d.players || {};
  for (const zid in players) if (players[zid].some((pl) => pl.call === user)) return zid;
  return null;
}
function miniBBox() {
  const d = MS.data; if (!d) return null;
  const f = curFloor(), mine = myZoneId();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
  const addZ = (z) => {
    if (z.shape === 'poly' && Array.isArray(z.polygon) && z.polygon.length) { const bb = polyBBox(z.polygon); grow(bb.x0, bb.y0); grow(bb.x1, bb.y1); }
    else { grow(z.x, z.y); grow(z.x + z.w, z.y + z.h); }
  };
  (d.rooms || []).filter((r) => (r.floorId || 'F1') === f && (r.explored || r.id === mine || (d.entryVisible && r.id === d.entry))).forEach(addZ);
  (d.passages || []).filter((p) => (p.floorId || 'F1') === f).forEach(addZ);
  if (x0 === Infinity) return null;
  return { x0, y0, x1, y1 };
}
function drawMiniSelf(ctx) {
  const d = MS.data; if (!d) return;
  const zid = myZoneId(); if (!zid) return;
  const z = zoneAtFloor(d, zid); if (!z || (z.floorId || 'F1') !== curFloor() || hiddenInMini(z)) return;
  const pl = (d.players[zid] || []).find((p) => p.call === user); if (!pl) return;
  const c = CELL * MS.scale;
  const cx = rp(pl.x + 0.5), cy = rpY(pl.y + 0.5), R = Math.max(6, c * 0.34);
  ctx.save();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.arc(cx, cy, R + 5, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 9px system-ui,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('你', cx, cy - R - 8);
  ctx.textAlign = 'left';
  ctx.restore();
}
function renderMini() {
  const wrap = M('#miniMapWrap'), cvs = M('#miniMapCanvas');
  if (!wrap || !cvs) return;
  const info = M('#miniMapInfo');
  if (!miniOn()) return;                                  // 折叠或窄屏隐藏时不绘制
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (w <= 0 || h <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (cvs.width !== pw || cvs.height !== ph) { cvs.width = pw; cvs.height = ph; cvs.style.width = w + 'px'; cvs.style.height = h + 'px'; }
  const ctx = cvs.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const d = MS.data;
  if (!d) {
    ctx.clearRect(0, 0, w, h);
    if (info) info.textContent = '等待地图数据…';
    return;
  }
  // —— 保存大地图状态 ——
  const sv = { ox: MS.ox, oy: MS.oy, scale: MS.scale, mode: MS.mode, floor: MS.floor, sel: MS.sel, selType: MS.selType, aim: MS.aim, stroke: MS.stroke, mini: MS.__mini };
  MS.__mini = true; MS.mode = 'show';
  MS.sel = null; MS.selType = ''; MS.aim = null; MS.stroke = null;
  // 楼层跟随自己所在处
  const zid = myZoneId();
  let here = null;
  if (zid) { const z = zoneAtFloor(d, zid); if (z) { MS.floor = z.floorId || 'F1'; here = z; } }
  const floorTag = curFloor();
  // 自动缩放到已揭晓区域
  const bb = miniBBox();
  if (!bb) {
    MS.scale = 0.6; MS.ox = w / 2 - 6 * CELL * MS.scale; MS.oy = h / 2 - 4 * CELL * MS.scale;
  } else {
    const pad = 20, c = CELL;
    const bw = Math.max(1, (bb.x1 - bb.x0) * c), bh = Math.max(1, (bb.y1 - bb.y0) * c);
    const s = Math.max(0.15, Math.min(2.5, (w - pad) / bw, (h - pad) / bh));
    MS.scale = s;
    MS.ox = (w - (bb.x1 - bb.x0) * c * s) / 2 - bb.x0 * c * s;
    MS.oy = (h - (bb.y1 - bb.y0) * c * s) / 2 - bb.y0 * c * s;
  }
  paint(ctx, w, h);
  drawMiniSelf(ctx);
  // —— 还原大地图状态 ——
  MS.ox = sv.ox; MS.oy = sv.oy; MS.scale = sv.scale; MS.mode = sv.mode; MS.floor = sv.floor;
  MS.sel = sv.sel; MS.selType = sv.selType; MS.aim = sv.aim; MS.stroke = sv.stroke; MS.__mini = sv.mini;
  // 底部状态行
  if (info) {
    const nm = here ? (zoneName(here) || '未命名区域') : '';
    if (nm) info.innerHTML = '你在 <b>' + escapeHtml(nm) + '</b> · ' + escapeHtml(String(floorTag)) + ' 层 · !go 房间名 移动';
    else if (bb) info.textContent = floorTag + ' 层 · 尚未进入船内（!here / !go 房间名）';
    else info.textContent = d.entryVisible ? '本层已开启入口 · 等待玩家进入' : '本层还没有已公开的区域，请 GM 在地图里「公开本层」';
  }
  // 手机版雷达：角落读数 + 「可去」出口按钮
  updateMiniRadarReadout(floorTag);
  if (window.renderMobileExits) window.renderMobileExits();
}
// 手机版雷达：当前所在房间的可去处（供底部「可去」按钮，点一下发 !go）
window.mobileExits = function () {
  const d = MS.data; if (!d) return [];
  const mine = myZoneId(); if (!mine) return [];
  const me = zoneAtFloor(d, mine); if (!me) return [];
  const out = [];
  // 玩家视角可见性：与小地图绘制口径一致（通道恒可见；房间需已揭晓，或入口可见开关打开时的入口）
  const eid = d.entry, ev = !!d.entryVisible;
  const seen = (z) => {
    if (!z.shape) return true;
    if (z.explored) return true;
    return !!(ev && eid && z.id === eid);
  };
  const zones = (d.rooms || []).concat(d.passages || []);
  for (const z of zones) {
    if (z.id === mine) continue;
    if (!seen(z)) continue;
    const linked = touches(z, me) || !!doorBetween(mine, z.id);
    if (!linked) continue;
    const dr = doorBetween(mine, z.id);
    out.push({
      id: z.id,
      name: zoneName(z) || '未命名区域',
      locked: !!(dr && dr.locked),
      stair: (z.floorId || 'F1') !== (me.floorId || 'F1')
    });
  }
  return out;
};
// 手机版雷达：更新角落读数（楼层 / 扫描状态）
function updateMiniRadarReadout(floorTag) {
  const fl = M('#mRadarFloor'); if (fl) fl.textContent = String(floorTag || '-');
  const sw = M('#mRadarSweepTxt');
  if (sw) {
    const on = MS.data ? (MS.data.radar !== false) : true;
    sw.textContent = on ? '○ ACTIVE' : '× OFFLINE';
    sw.style.color = on ? 'rgba(255,255,255,.42)' : 'rgba(255,140,90,.7)';
  }
}
// 供 app.js 在登录 / 切换频道时调用：丢弃旧数据重新拉当前频道的地图
window.reloadMap = function () { MS.data = null; MS.v = -1; MS.__needFit = true; loadMap(); };
(function bindSidePanel() {
  const p = M('#sidePanel'); if (!p) return;
  const rail = M('#sideRail');
  if (rail) rail.addEventListener('click', () => { p.classList.remove('collapsed'); renderMini(); });
  const col = M('#sideCollapse');
  if (col) col.addEventListener('click', () => {
    p.classList.add('collapsed');
    try { localStorage.setItem('mothership_side', 'collapsed'); } catch (e) {}
  });
  try { if (localStorage.getItem('mothership_side') === 'collapsed') p.classList.add('collapsed'); } catch (e) {}
  window.addEventListener('resize', () => { clearTimeout(MS.__miniTimer); MS.__miniTimer = setTimeout(renderMini, 120); });
})();

function renderLegend() {
  const el = M('#mapLegend'); if (!el) return;
  const items = FACILITIES.map((f) => '<span class="lg-item"><span class="lg-dot" style="background:' + f.line + '"></span><b class="lg-code">' + f.code + '</b> ' + f.name + '</span>');
  const cust = (MS.data && MS.data.customTypes) || [];
  if (cust.length) { items.push('<span class="lg-cap">自定义类型</span>'); cust.forEach((f) => items.push('<span class="lg-item"><span class="lg-dot" style="background:' + f.line + '"></span><b class="lg-code">' + f.code + '</b> ' + f.name + '</span>')); }
  items.unshift('<span class="lg-cap">设施对照（房间角标缩写）</span>');
  items.push('<span class="lg-item"><span class="lg-dot" style="background:#ffffff"></span>通道</span>');
  el.innerHTML = items.join('');
}

// ---- 房间列表（按楼层分组，每行 打开/关闭）----
function hexToRgba(hex, a) {
  const h = (hex || '#ffffff').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
function escapeHtml(s) { return ('' + (s || '')).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function centerOnZone(z) {
  const cvs = M('#mapCanvas'); if (!cvs) return; const W = cvs.clientWidth || 600, H = cvs.clientHeight || 400; const c = CELL * MS.scale; const ctr = zoneCenter(z);
  MS.ox = W / 2 - ctr.x * c; MS.oy = H / 2 - ctr.y * c;
}
function setRoomOpen(id, open) {
  const op = { t: 'room.open', id, v: open }; pushUndo(op); applyLocal([op]); sendOps([op]); render();
}
function renderRoomList() {
  const el = M('#mapRoomList'); if (!el) return; const d = MS.data; if (!d) { el.innerHTML = ''; return; }
  const floors = (d.floors || []), rooms = (d.rooms || []);
  let html = '';
  for (const f of floors) {
    const rs = rooms.filter((r) => (r.floorId || 'F1') === f.id);
    if (!rs.length) continue;
    html += '<div class="rl-floor">' + escapeHtml(f.name) + '</div>';
    for (const r of rs) {
      const fi = facInfo(r.type); const code = fi ? fi.code : (r.type || 'RM'); const closed = r.open === false;
      html += '<div class="room-row' + (MS.sel === r.id ? ' sel' : '') + '">'
        + '<span class="room-name" data-id="' + r.id + '"><b class="rl-code">' + escapeHtml(code) + '</b> ' + escapeHtml(r.name || '未命名') + '</span>'
        + '<span class="room-acts">'
        + '<button class="mini rbtn ' + (!closed ? 'on' : '') + '" data-id="' + r.id + '" data-open="1">打开</button>'
        + '<button class="mini rbtn ' + (closed ? 'on' : '') + '" data-id="' + r.id + '" data-open="0">关闭</button>'
        + '</span></div>';
    }
  }
  if (!html) html = '<div class="rl-empty dim">本层暂无房间</div>';
  el.innerHTML = html;
  const cnt = M('#roomListCount'); if (cnt) cnt.textContent = '(' + rooms.length + ')';
  el.querySelectorAll('.room-name').forEach((s) => s.addEventListener('click', () => { const id = s.dataset.id; const z = zf(id); if (z) { MS.sel = id; MS.selType = 'room'; centerOnZone(z); render(); } }));
  el.querySelectorAll('.rbtn').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); setRoomOpen(b.dataset.id, b.dataset.open === '1'); }));
}

function bbox() {
  const d = MS.data; if (!d) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
  const addZ = (z) => { if (z.shape === 'poly' && Array.isArray(z.polygon) && z.polygon.length) { const bb = polyBBox(z.polygon); grow(bb.x0, bb.y0); grow(bb.x1, bb.y1); } else { grow(z.x, z.y); grow(z.x + z.w, z.y + z.h); } };
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
  const p = pos(e), lg = toLog(p); MS.lastPtr = { x: p.x, y: p.y };
  const isEdit = MS.mode === 'edit' && isGM;
  hideCtx();
  // 右键(2)/中键(1)按住拖拽=平移地图（编辑与显示模式均可）
  if (e.button === 2 || e.button === 1) {
    // 编辑模式右键点中部件 -> 交给 contextmenu 弹删除菜单，不平移
    if (e.button === 2 && isEdit && pickComponent(lg)) return;
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
    const TOL = 1.2; // 容差放大，便于点在房间之间/边缘附近也能命中
    // 直接用真实鼠标逻辑坐标(lg)选端：不再强制吸附整数格点，所见即所点；整数准星仅作辅助标记
    const sl = { x: lg.x, y: lg.y };
    let zh = zoneAt(sl);
    // 若直接点中的就是已选第一端（贴边墙线落在它内部），优先就近改选"另一端"
    if (zh && MS.linkA && zh.z.id === MS.linkA) {
      const other = zoneAtNear(sl, TOL, MS.linkA);
      if (other) zh = other;
    }
    if (!zh) zh = zoneAtNear(sl, TOL, MS.linkA || null) || zoneAtNear(sl, TOL, null);
    if (!zh) { tip(MS.linkA ? '再点第二个房间/通道（点对象内部或边缘附近即可）' : '请先点一个房间或通道（点对象内部或边缘附近）'); return; }
    if (!MS.linkA) { MS.linkA = zh.z.id; tip('已选「' + (zoneName(zh.z) || (zh.kind === 'passage' ? '通道' : '房间')) + '」，再点另一个（同层需相邻；跨层自动成梯）'); render(); return; }
    if (zh.z.id === MS.linkA) { tip('两个端不能相同'); return; }
    const a = zf(MS.linkA), b = zh.z; MS.linkA = null;
    const cross = (a.floorId || 'F1') !== (b.floorId || 'F1');
    if (!cross && !touches(a, b)) { tip('这两个不挨着，走不过去。请先用「通道」把两处连到相邻（相贴即算），再在这对之间安门。'); render(); return; }
    if (doorBetween(a.id, b.id)) { tip('这对之间已经有门了，可点选后用「锁/开锁」。'); render(); return; }
    const did = uid('D'); const op = { t: 'door.set', door: { id: did, a: a.id, b: b.id, type: cross ? 'ladder' : 'door', locked: false } }; op.__new = true;
    pushUndo(op); applyLocal([op]); sendOps([op]);
    tip(cross ? '已放一扇「梯」（跨层）。' : '已放一扇门（未锁）。可点选后「锁/开锁」。'); render(); return;
  }
  if (MS.tool === 'poly') {
    // 多边形房间：逐点点击放置顶点(吸附格点)；点回首点(≤1格)自动闭合
    const pt = { x: Math.round(lg.x), y: Math.round(lg.y) };
    if (!MS.polyPts) MS.polyPts = [];
    if (MS.polyPts.length >= 3) {
      const f0 = MS.polyPts[0];
      if (Math.hypot(pt.x - f0.x, pt.y - f0.y) <= 1) { finishPoly(); return; }
    }
    MS.polyPts.push(pt); MS.aim = pt; render(); return;
  }
  if (MS.tool === 'rect' || MS.tool === 'passage') {
    // 起终点均吸附到最近整数格点，保证房间/通道边界贴齐网格（落点以画内准星为准）
    const sx = MS.aim ? MS.aim.x : Math.round(lg.x), sy = MS.aim ? MS.aim.y : Math.round(lg.y);
    MS.stroke = { kind: MS.tool, x0: sx, y0: sy, name: '' }; render(); return;
  }
}
function onMove(e) {
  if (!MS.data) return;
  const p = pos(e), lg = toLog(p); MS.lastPtr = { x: p.x, y: p.y };
  if (MS.stroke) { MS.stroke.x1 = Math.round(lg.x); MS.stroke.y1 = Math.round(lg.y); MS.aim = { x: MS.stroke.x1, y: MS.stroke.y1 }; render(); return; }
  if (MS.drag && MS.drag.kind === 'pan') { MS.aim = null; MS.ox = MS.drag.ox + (p.x - MS.drag.sx); MS.oy = MS.drag.oy + (p.y - MS.drag.sy); render(); return; }
  if (isDrawTool()) { MS.aim = { x: Math.round(lg.x), y: Math.round(lg.y) }; render(); return; }
  // 门/梯工具：整数准星仅作辅助标记(显示最近格点)，真实选端用自由鼠标坐标(lg)
  if (isGM && MS.mode === 'edit' && MS.tool === 'door') { MS.aim = { x: Math.round(lg.x), y: Math.round(lg.y) }; render(); return; }
  if (MS.aim) { MS.aim = null; render(); }
}
// 松开：不再直接创建，弹出网页内"确认+命名"对话框
function onUp(e) {
  const s = MS.stroke;
  if (s) {
    const x0 = Math.min(s.x0, s.x1 || s.x0), y0 = Math.min(s.y0, s.y1 || s.y0);
    const x1 = Math.max(s.x0, s.x1 || s.x0), y1 = Math.max(s.y0, s.y1 || s.y0);
    const w = x1 - x0, h = y1 - y0;
    MS.stroke = null;
    if (w > 0.5 || h > 0.5) {
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
  hideCtx();
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
  tip(hit ? ('已画通道，连上「' + zoneName(info.nearest.zone) + '」（贴边即通）。') : '已画一段通道。伸到房间/通道边 1 格内即连通。');
}
function finishPoly() {
  if (!MS.polyPts || MS.polyPts.length < 3) { tip('多边形至少需要 3 个顶点'); return; }
  const polygon = MS.polyPts.map((p) => ({ x: p.x, y: p.y }));
  MS.polyPts = null;
  openCreateDialog({ kind: 'poly', polygon, floorId: curFloor(), label: '多边形房间' });
}
function openCreateDialog(shape) {
  const d = MS.data; if (!d) return;
  const isPoly = shape.kind === 'poly';
  const probe = isPoly
    ? { id: '__new__', floorId: shape.floorId, shape: 'poly', polygon: shape.polygon }
    : { id: '__new__', floorId: shape.floorId, shape: 'rect', x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  const clash = draftInfo(probe, d).deep;
  let sizeTxt;
  if (isPoly) { const bb = polyBBox(shape.polygon); sizeTxt = Math.max(1, Math.round(bb.x1 - bb.x0)) + ' × ' + Math.max(1, Math.round(bb.y1 - bb.y0)) + ' 格（多边形）'; }
  else sizeTxt = Math.max(1, shape.w) + ' × ' + Math.max(1, shape.h) + ' 格';
  const title = shape.label || (isPoly ? '多边形房间' : '矩形房间');
  const dlg = M('#createDlg'); if (!dlg) return;
  M('#createTitle').textContent = '新建' + title;
  M('#createType').textContent = title + '（' + (shape.floorId ? (floorName(shape.floorId) || shape.floorId) : '') + '）';
  M('#createSize').textContent = '尺寸：' + sizeTxt;
  M('#createName').value = '';
  const sel = M('#createFac');
  if (sel) {
    const cust = (MS.data && MS.data.customTypes) || [];
    let html = FACILITIES.map((f) => '<option value="' + f.code + '">' + f.code + ' · ' + f.name + '</option>').join('');
    html += cust.map((f) => '<option value="' + f.code + '">' + f.code + ' · ' + f.name + '（自定义）</option>').join('');
    html += '<option value="__custom__">＋ 自定义类型…</option>';
    sel.innerHTML = html; sel.value = '';
    const syncCustom = () => { const row = M('#createCustomRow'); if (row) row.style.display = sel.value === '__custom__' ? 'flex' : 'none'; };
    sel.onchange = syncCustom; syncCustom();
  }
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
  const type = (M('#createFac') ? M('#createFac').value : '') || '';
  if (type === '__custom__') { mapAlert('请先填写名称与缩写，点「添加」创建自定义类型'); return; }
  const myFloor = s.floorId;
  const roomOk = (probe) => { const i = draftInfo(probe, d); if (i.deep) { mapAlert('与「' + zoneName(i.deep.zone) + '」穿插过深，无法创建'); return false; } return true; };
  if (s.kind === 'poly') {
    const probe = { id: uid('R'), shape: 'poly', floorId: myFloor, polygon: s.polygon };
    if (!roomOk(probe)) return;
    const room = { id: probe.id, shape: 'poly', floorId: myFloor, polygon: s.polygon, type, name, explored: false };
    const op = { t: 'room.upsert', room }; pushUndo(op, true); applyLocal([op]); sendOps([op]);
  } else if (s.kind === 'passage') {
    const probe = { id: uid('P'), floorId: myFloor, shape: 'rect', x: s.x, y: s.y, w: s.w, h: s.h };
    const i = draftInfo(probe, d); if (i.deep) { mapAlert('与「' + zoneName(i.deep.zone) + '」穿插过深，无法创建'); return; }
    const passage = { id: probe.id, x: s.x, y: s.y, w: s.w, h: s.h, floorId: myFloor, name };
    const op = { t: 'passage.upsert', passage }; pushUndo(op, true); applyLocal([op]); sendOps([op]);
  } else {
    const probe = { id: uid('R'), shape: 'rect', floorId: myFloor, x: s.x, y: s.y, w: s.w, h: s.h };
    if (!roomOk(probe)) return;
    const room = { id: probe.id, shape: 'rect', floorId: myFloor, x: s.x, y: s.y, w: s.w, h: s.h, type, name, explored: false };
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
    if (fx) fx.addEventListener('click', async (ev) => { ev.stopPropagation(); const fid = tab.dataset.fid; if (floors.length <= 1) { mapAlert('至少保留一层'); return; } if (!(await mapConfirm('删除该层及其所有房间？'))) return; const op = { t: 'floor.del', id: fid }; pushUndo(op); applyLocal([op]); sendOps([op]); if (MS.floor === fid) { MS.floor = (d.floors || [])[0] ? (d.floors || [])[0].id : null; } renderFloorTabs(); render(); });
    tab.addEventListener('click', () => { MS.floor = tab.dataset.fid; MS.sel = null; MS.stroke = null; renderFloorTabs(); render(); fit(); });
  });
  const add = M('#mapFloorAdd');
  if (add) add.addEventListener('click', async () => { const name = (await mapPrompt('楼层名（如 2F）', '', '如 2F')) || ''; const fid = uid('F'); const op = { t: 'floor.add', floor: { id: fid, name: (name || '').slice(0, 12) } }; pushUndo(op); applyLocal([op]); sendOps([op]); MS.floor = fid; renderFloorTabs(); render(); });
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

/* ---- 通用内部弹窗：替代原生 confirm / alert / prompt（所有弹窗都在地图内显示） ---- */
let _dlgResolver = null;
function mapDialog(opts) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('mapConfirmDlg');
    if (!dlg) { resolve(opts.input ? null : false); return; }
    document.getElementById('dlgTitle').textContent = opts.title || '请确认';
    document.getElementById('dlgMsg').textContent = opts.msg || '';
    const iw = document.getElementById('dlgInputWrap');
    const inp = document.getElementById('dlgInput');
    if (opts.input) {
      iw.classList.remove('hidden');
      inp.value = (opts.value != null ? opts.value : '');
      inp.placeholder = opts.placeholder || '';
      inp.maxLength = opts.maxLength || 60;
      document.getElementById('dlgInputLabel').textContent = opts.label || '输入';
    } else {
      iw.classList.add('hidden');
    }
    const ok = document.getElementById('dlgConfirm');
    const cx = document.getElementById('dlgCancel');
    ok.textContent = opts.confirmText || '确定';
    cx.textContent = opts.cancelText || '取消';
    ok.classList.toggle('danger', !!opts.danger);
    if (opts.cancelText === false) cx.classList.add('hidden'); else cx.classList.remove('hidden');
    _dlgResolver = (val) => { dlg.classList.add('hidden'); _dlgResolver = null; resolve(val); };
    dlg.classList.remove('hidden');
    if (opts.input) setTimeout(() => { inp.focus(); inp.select(); }, 20);
    else setTimeout(() => ok.focus(), 20);
  });
}
function mapConfirm(msg, title) { return mapDialog({ title: title || '请确认', msg, confirmText: '确定', cancelText: '取消' }); }
function mapAlert(msg, title) { return mapDialog({ title: title || '提示', msg, confirmText: '知道了', cancelText: false }); }
function mapPrompt(msg, value, placeholder, title) { return mapDialog({ title: title || '输入', msg, input: true, value: value || '', placeholder: placeholder || '', confirmText: '确定', cancelText: '取消' }); }
(function bindDlg() {
  const dlg = document.getElementById('mapConfirmDlg');
  if (!dlg) return;
  const ok = document.getElementById('dlgConfirm');
  const cx = document.getElementById('dlgCancel');
  ok.addEventListener('click', () => { if (!_dlgResolver) return; const iw = document.getElementById('dlgInputWrap'); const inp = document.getElementById('dlgInput'); _dlgResolver(iw.classList.contains('hidden') ? true : inp.value); });
  cx.addEventListener('click', () => { if (_dlgResolver) _dlgResolver(false); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg && _dlgResolver) _dlgResolver(false); });
  document.addEventListener('keydown', (e) => {
    if (!_dlgResolver) return;
    const iw = document.getElementById('dlgInputWrap');
    if (e.key === 'Escape') { e.preventDefault(); _dlgResolver(false); }
    else if (e.key === 'Enter') { e.preventDefault(); const inp = document.getElementById('dlgInput'); _dlgResolver(iw.classList.contains('hidden') ? true : inp.value); }
  });
})();

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
      // 首次载入：大地图已打开就 fit；否则先记下来（视图尚未布局），等真正打开时再 fit
      if (first) {
        if (isOpen()) setTimeout(fit, 40);
        else MS.__needFit = true;
      } else if (isOpen()) {
        if (MS.__needFit) { MS.__needFit = false; setTimeout(fit, 40); }
        else render();
      }
      modeInfo();
      renderMini();                      // 同步侧栏小地图
    }).catch(() => {});
}
let mapReloadTimer = null;
// 侧栏小地图常驻，因此地图变更事件不再要求大地图弹窗处于打开状态
function onMapEvent(m) {
  if (!m || m.room !== mapRoomId()) return;
  // 雷达开关触发的广播：先播扫描动画，再 reload
  if (m.reason === 'radar') {
    playRadarFx(!!m.radar, function () { afterRadarReload(); });
    return;
  }
  // 入口可见开关：不播动画，直接刷新（数据轻，视觉变化小）
  if (m.reason === 'entry') {
    afterRadarReload();
    return;
  }
  clearTimeout(mapReloadTimer);
  mapReloadTimer = setTimeout(loadMap, 200);
}
function afterRadarReload() {
  clearTimeout(mapReloadTimer);
  mapReloadTimer = setTimeout(function () { loadMap(); if (typeof applyMapStates === 'function') applyMapStates(); else if (typeof applyRadarState === 'function') applyRadarState(); }, 80);
}

// ---- 雷达开关：全屏「电视故障」覆盖层（纯 CSS keyframes） ----
// on=true 开雷达（绿色屏 / 较少黑屏）   on=false 关雷达（红色屏 / 多重黑屏抖动）
// onDone: 动画结束后的回调（用于 reload + 应用新状态）
const RADAR_FX_MS = 1000;
let _radarFxTimer = null, _radarFxOnDone = null;
function playRadarFx(on, onDone) {
  const fx = M('#radarFx');
  if (!fx) { if (onDone) onDone(); return; }
  // 取消上一次（如果还在播）
  if (_radarFxTimer) { clearTimeout(_radarFxTimer); _radarFxTimer = null; }
  if (_radarFxOnDone) { try { _radarFxOnDone(); } catch (e) {} _radarFxOnDone = null; }

  // 重置/重启动画：先强制 reflow 再切换 class，确保 keyframes 重新跑
  fx.classList.remove('on', 'off');
  // force reflow
  void fx.offsetWidth;
  fx.classList.add(on ? 'on' : 'off');
  fx.classList.remove('hidden');

  // 文字
  const txt = M('#radarFxText');
  const tag = M('#radarFxTag');
  const sub = M('#radarFxSub');
  const time = M('#radarFxTime');
  if (txt) txt.textContent = on ? 'SCANNING…' : 'SIGNAL OFFLINE…';
  if (tag) tag.textContent = on ? 'SCAN · BOOT' : 'SCAN · SHUTDOWN';
  if (sub) sub.textContent = on ? 'CH 04 · DECODE 0%' : 'CH 04 · DECODE LOST';
  if (time) time.textContent = 'T+ 00:00:0' + (on ? '1' : '0');

  _radarFxOnDone = onDone || null;
  _radarFxTimer = setTimeout(function () {
    fx.classList.add('hidden');
    fx.classList.remove('on', 'off');
    _radarFxTimer = null;
    const cb = _radarFxOnDone; _radarFxOnDone = null;
    if (cb) cb();
  }, RADAR_FX_MS + 60);                       // 多 60ms 等动画收尾
}
function openMap() {
  const d0 = MS.data;
  M('#mapModal').classList.remove('hidden');
  M('#mapScope').textContent = (typeof roomNames !== 'undefined' && roomNames[mapRoomId()]) || mapRoomId();
  // 初始化模式
  if (isGM) { MS.mode = 'edit'; } else { MS.mode = 'show'; }
  if (MS.data && MS.room !== mapRoomId()) MS.data = null;
  M('#mapDel').classList.add('hidden'); M('#mapExploreBtn').classList.add('hidden'); M('#mapOpenBtn').classList.add('hidden');
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
// 导出 / 导入地图 JSON
M('#mapExport').addEventListener('click', () => {
  if (!MS.data) return;
  const payload = { version: 1, exportedAt: new Date().toISOString(), map: MS.data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'map-' + (MS.room || 'general') + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  tip('已导出地图 JSON');
});
M('#mapImport').addEventListener('click', () => { const fi = M('#mapFileInput'); if (fi) fi.click(); });
M('#mapFileInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (!(await mapConfirm('导入将覆盖当前地图的全部楼层、房间、通道、门与自定义类型，确定继续？', '导入地图'))) return;
  let text;
  try { text = await file.text(); } catch (err) { mapAlert('读取文件失败'); return; }
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) { mapAlert('导入失败：文件不是合法的 JSON'); return; }
  const src = parsed.map || parsed;                       // 兼容「带封装的导出文件」与「纯 map 对象」
  if (!src || typeof src !== 'object') { mapAlert('导入失败：文件中没有可用的地图数据'); return; }
  try {
    const res = await fetch('/api/map', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: MS.room, user, gm: gmCode, map: src })
    });
    const j = await res.json().catch(() => ({}));
    if (j && j.ok) { tip('已导入地图，正在刷新…'); loadMap(); }
    else { mapAlert('导入失败：' + ((j && j.error) || ('HTTP ' + res.status))); }
  } catch (err) { mapAlert('导入失败：网络错误'); }
});
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
M('#mapDel').addEventListener('click', async () => {
  if (!MS.sel || !(await mapConfirm('删除所选元素？'))) return;
  doDelete(MS.selType, MS.sel);
});
// 右键部件弹出小菜单：在光标右侧显示"删除"
function pickComponent(lg) {
  const d = MS.data; if (!d) return null;
  const dh = doorNear(lg, 1.4);                 // 门优先(贴墙处)：先判门，再判房间/通道
  if (dh) return { kind: 'door', id: dh.d.id };
  const zh = zoneAt(lg);
  if (zh) return { kind: zh.kind, id: zh.z.id };
  return null;
}
function showCtxMenu(clientX, clientY, target) {
  const m = M('#mapCtx'); if (!m) return;
  MS.ctxTarget = target;
  m.classList.remove('hidden');
  const w = m.offsetWidth || 110, h = m.offsetHeight || 36;
  let x = clientX + 8, y = clientY;             // 默认在光标右侧
  if (x + w > window.innerWidth - 6) x = clientX - w - 8;   // 右侧放不下则翻到左侧
  if (y + h > window.innerHeight - 6) y = window.innerHeight - h - 6;
  if (y < 6) y = 6;
  m.style.left = x + 'px'; m.style.top = y + 'px';
}
function hideCtx() { const m = M('#mapCtx'); if (m) m.classList.add('hidden'); MS.ctxTarget = null; }
function onCtxMenu(e) {
  e.preventDefault();
  if (!(MS.mode === 'edit' && isGM) || !MS.data) { hideCtx(); return; }
  const hit = pickComponent(toLog(pos(e)));
  if (!hit) { hideCtx(); return; }
  // 菜单定位到"整数准星"位置(吸附后的格点)而非裸的系统鼠标位置，让系统鼠标和准星对齐，便于点击
  const entryBtn = M('#ctxEntry');
  if (entryBtn) entryBtn.classList.toggle('hidden', hit.kind !== 'room');   // 入口仅对房间可设
  const lockBtn = M('#ctxLock');
  if (lockBtn) {
    if (hit.kind === 'door') {
      const g = (MS.data.doors || []).find(x => x.id === hit.id);
      lockBtn.textContent = g && g.locked ? '🔓 开锁' : '🔒 锁门';
      lockBtn.classList.remove('hidden');
    } else {
      lockBtn.classList.add('hidden');
    }
  }
  const r = M('#mapCanvas').getBoundingClientRect();
  const lg = toLog(pos(e));
  const sx = Math.round(lg.x), sy = Math.round(lg.y);
  showCtxMenu(r.left + rp(sx), r.top + rpY(sy), hit);
}
// 真正执行删除（工具栏按钮 / 右键菜单共用），支持撤销
function doDelete(type, id) {
  if (!id) return;
  const d = MS.data;
  if (type === 'door') { const g = (d.doors || []).find(x => x.id === id); const op = { t: 'door.del', id, door: g }; pushUndo(op); applyLocal([op]); sendOps([op]); }
  else if (type === 'room') { const z = zf(id); const op = { t: 'room.del', id, room: z }; pushUndo(op); applyLocal([op]); sendOps([op]); }
  else if (type === 'passage') { const z = zf(id); const op = { t: 'passage.del', id, passage: z }; pushUndo(op); applyLocal([op]); sendOps([op]); }
  if (MS.sel === id) { MS.sel = null; updateAct(); }
  render();
}
const ctxDel = M('#ctxDel');
if (ctxDel) ctxDel.addEventListener('click', (e) => { e.stopPropagation(); const t = MS.ctxTarget; hideCtx(); if (t) doDelete(t.kind, t.id); });
// 右键菜单"切换锁"：门专属
const ctxLockBtn = M('#ctxLock');
if (ctxLockBtn) ctxLockBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const t = MS.ctxTarget; hideCtx();
  if (!t || t.kind !== 'door') return;
  const g = (MS.data.doors || []).find(x => x.id === t.id); if (!g) return;
  const op = { t: 'door.lock', id: g.id, a: g.a, b: g.b, v: !g.locked };
  pushUndo(op); applyLocal([op]); sendOps([op]); updateAct(); render();
  tip(g.locked ? '已开锁' : '已锁门');
});
M('#mapLockBtn').addEventListener('click', () => {
  if (!MS.sel || MS.selType !== 'door') return;
  const g = (MS.data.doors || []).find(x => x.id === MS.sel); if (!g) return;
  const op = { t: 'door.lock', id: g.id, a: g.a, b: g.b, v: !g.locked };
  pushUndo(op); applyLocal([op]); sendOps([op]); updateAct(); render();
});
// 右键菜单"设为入口"：房间专属；地图上已有入口且不是本房间时询问是否重设
async function doSetEntry(id) {
  if (!id) return;
  const r = zf(id); if (!r) return;
  const cur = MS.data.entry;
  if (cur && cur === id) { tip('该房间已是入口'); return; }
  if (cur && cur !== id && !(await mapConfirm('地图上已有入口「' + (zoneName(zf(cur)) || '房间') + '」，是否将入口重设为当前房间「' + (zoneName(r) || '房间') + '」？'))) return;
  const op = { t: 'entry', id }; op.__prev = cur || null;
  pushUndo(op); applyLocal([op]); sendOps([op]); tip('已设为入口'); render();
}
const ctxEntry = M('#ctxEntry');
if (ctxEntry) ctxEntry.addEventListener('click', (e) => { e.stopPropagation(); const t = MS.ctxTarget; hideCtx(); if (t && t.kind === 'room') doSetEntry(t.id); });
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
// 公开 / 隐藏：两个按钮，文案随各自状态联动翻转（公开↔隐藏）。
// 范围互不替代：隐藏本层只隐藏当前层、隐藏全部才隐藏所有层，二者的状态各自独立计算。
function floorPublic(floorId) {
  const rs = (MS.data.rooms || []).filter(r => (r.floorId || 'F1') === floorId);
  return rs.length > 0 && rs.every(r => r.explored);
}
function allPublic() {
  const rs = MS.data.rooms || [];
  return rs.length > 0 && rs.every(r => r.explored);
}
function updatePub() {
  if (!MS.data) return;
  const pf = M('#mapPublishFloor'), pa = M('#mapPublishAll');
  if (pf) { const p = floorPublic(curFloor()); pf.textContent = p ? '隐藏本层' : '公开本层'; pf.title = p ? '把当前楼层的房间对玩家隐藏' : '把当前楼层的房间全部对玩家公开'; pf.classList.toggle('amber', !p); }
  if (pa) { const p = allPublic(); pa.textContent = p ? '隐藏全部' : '公开全部'; pa.title = p ? '把全部楼层的房间对玩家隐藏' : '把全部楼层的房间全部对玩家公开'; pa.classList.toggle('amber', !p); }
}
const pubCur = M('#mapPublishFloor'), pubAllBtn = M('#mapPublishAll');
if (pubCur) pubCur.addEventListener('click', () => { if (!isGM) return; const f = curFloor(); const p = floorPublic(f); const op = { t: 'explore.floor', floor: f, v: !p }; pushUndo(op); applyLocal([op]); sendOps([op]); tip(p ? '已隐藏当前楼层' : '已公开当前楼层'); updatePub(); render(); });
if (pubAllBtn) pubAllBtn.addEventListener('click', () => { if (!isGM) return; const p = allPublic(); const op = { t: 'explore.all', v: !p }; pushUndo(op); applyLocal([op]); sendOps([op]); tip(p ? '已隐藏全部楼层' : '已公开全部楼层'); updatePub(); render(); });
document.querySelectorAll('button.tool').forEach((b) => {
  b.addEventListener('click', () => {
    MS.tool = b.dataset.tool; MS.linkA = null; MS.stroke = null; MS.polyPts = null;
    document.querySelectorAll('button.tool').forEach(x => x.classList.toggle('active', x === b));
    hideCtx();
    syncCursor();
    if (isDrawTool() || MS.tool === 'door') { if (MS.lastPtr) { const lg = toLog(MS.lastPtr); MS.aim = { x: Math.round(lg.x), y: Math.round(lg.y) }; } }
    else MS.aim = null;
    render();
    if (MS.tool === 'rect') tip('按住拖出矩形房间；准星自动吸格点');
    else if (MS.tool === 'poly') tip('依次点击放顶点(吸附格点)，点首点闭合；Enter 闭合 / Esc 取消');
    else if (MS.tool === 'passage') tip('拖出通道，伸到房间/通道 1 格内即连通（绿框=已连通）');
    else if (MS.tool === 'door') tip('点两个相邻(贴边即算)对象放门；跨层自动成“梯”，可锁/开锁');
    else if (MS.tool === 'select') tip('点选房间/通道/门；门可锁/开锁，右键房间设入口/拖拽平移');
    else tip('');
  });
});
// 多边形绘制中：Enter 闭合 / Esc 取消
window.addEventListener('keydown', (e) => {
  if (MS.polyPts && MS.polyPts.length) {
    if (e.key === 'Enter') { e.preventDefault(); finishPoly(); }
    else if (e.key === 'Escape') { MS.polyPts = null; tip('已取消多边形绘制'); render(); }
  }
});
// 新建对话框
const cd = M('#createDlg');
if (cd) {
  M('#createCancel').addEventListener('click', closeCreateDialog);
  M('#createConfirm').addEventListener('click', commitCreate);
  // GM 自定义房间类型（名称+缩写+颜色），随地图持久化
  const cAdd = M('#createCustomAdd');
  if (cAdd) cAdd.addEventListener('click', () => {
    const name = (M('#createCustomName').value || '').trim();
    const codeRaw = (M('#createCustomCode').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const color = M('#createCustomColor').value || '#7fb0ff';
    const err = M('#createCustomErr');
    if (!name) { err.style.display = 'block'; err.textContent = '请填写名称'; return; }
    if (!codeRaw) { err.style.display = 'block'; err.textContent = '请填写缩写（字母/数字）'; return; }
    const code = codeRaw.slice(0, 5);
    const dup = (MS.data.customTypes || []).concat(FACILITIES).find((f) => f.code === code);
    if (dup) { err.style.display = 'block'; err.textContent = '缩写 ' + code + ' 已被「' + (dup.name || '') + '」占用'; return; }
    const nt = { code, name, fill: hexToRgba(color, 0.92), line: color };
    const next = (MS.data.customTypes || []).concat([nt]);
    const op = { t: 'types.set', types: next, __prev: (MS.data.customTypes || []).slice() };
    MS.data.customTypes = next;
    pushUndo(op); sendOps([op]); render();
    const sel = M('#createFac');
    if (sel) {
      let html = FACILITIES.map((f) => '<option value="' + f.code + '">' + f.code + ' · ' + f.name + '</option>').join('');
      html += (MS.data.customTypes || []).map((f) => '<option value="' + f.code + '">' + f.code + ' · ' + f.name + '（自定义）</option>').join('');
      html += '<option value="__custom__">＋ 自定义类型…</option>';
      sel.innerHTML = html; sel.value = code;
      M('#createCustomRow').style.display = 'none'; M('#createCustomName').value = ''; M('#createCustomCode').value = ''; err.style.display = 'none';
    }
  });
  M('#createName').addEventListener('keydown', (e) => { if (e.key === 'Enter') commitCreate(); if (e.key === 'Escape') closeCreateDialog(); });
}
const cvs = M('#mapCanvas');
cvs.addEventListener('pointerdown', onDown);
cvs.addEventListener('pointermove', onMove);
cvs.addEventListener('pointerup', onUp);
cvs.addEventListener('pointercancel', onUp);
cvs.addEventListener('wheel', onWheel, { passive: false });
cvs.addEventListener('contextmenu', onCtxMenu);
// 点击地图外任意处关闭右键菜单（菜单自身与画布内的点击已在各自处理中关闭）
document.addEventListener('mousedown', (e) => {
  const m = M('#mapCtx');
  if (!m || m.classList.contains('hidden')) return;
  if (!m.contains(e.target) && e.target !== M('#mapCanvas')) hideCtx();
});
cvs.addEventListener('pointerleave', () => { if (!MS.stroke && !MS.drag) { MS.aim = null; render(); } });
window.addEventListener('resize', () => { if (isOpen()) render(); });
document.addEventListener('keydown', (e) => {
  if (!isOpen()) return;
  if (e.key === 'Escape') { hideCtx(); const cd2 = M('#createDlg'); if (cd2 && !cd2.classList.contains('hidden')) { closeCreateDialog(); return; } MS.linkA = null; MS.stroke = null; MS.tool = 'select'; document.querySelectorAll('button.tool').forEach(x => x.classList.toggle('active', x.dataset.tool === 'select')); render(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redoMap() : undoMap(); }
  if (e.key === 'Delete' || e.key === 'Backspace') { const b = M('#mapDel'); if (b && !b.classList.contains('hidden')) b.click(); }
});

// node 冒烟测试导出
if (typeof module !== 'undefined' && module.exports) { module.exports = { MS, paint, render, fit, applyLocal, doLocal, sendOps, undoMap, redoMap, exportPng, zoneAt, rp, curZones, shapeGap, touches, draftInfo, snapDraft, conflictZone, ADJ }; }
// 浏览器调试钩子
if (typeof window !== 'undefined') { window.__map = { MS, paint, render, fit, openMap, loadMap, applyLocal }; }
