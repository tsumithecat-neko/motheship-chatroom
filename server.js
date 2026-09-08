'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';
const GM_CODE = process.env.GM_CODE || 'warden';
const isPkg = (typeof process.pkg !== 'undefined');
const EXE_DIR = path.dirname(process.execPath); // real, writable dir the exe lives in
const ROOT = __dirname;                          // project root (or snapshot root when packaged)
const PUBLIC = path.join(ROOT, 'public');
// When packaged, data must live next to the exe (snapshot is read-only); otherwise beside the script.
const DATA = isPkg ? path.join(EXE_DIR, 'data') : path.join(ROOT, 'data');
const CHARFILE = path.join(DATA, 'characters.json');
const MSGLOG = path.join(DATA, 'messages.json');
const ROOMFILE = path.join(DATA, 'rooms.json');
const BOOT = Date.now(); // 服务启动时刻（状态读数用）

fs.mkdirSync(DATA, { recursive: true });

// Inlined static assets (base64) — only generated for the packaged single-file exe.
// Normal `node server.js` ignores this (file simply absent). Packaged exe serves from memory.
let INLINE_ASSETS = {};
try { INLINE_ASSETS = require('./inline-assets'); } catch (e) {}

// ---- persistence ----
let messages = {};
try {
  const raw = JSON.parse(fs.readFileSync(MSGLOG, 'utf8'));
  messages = Array.isArray(raw) ? { general: raw } : raw;
} catch (e) { messages = {}; }

let characters = {};
try { characters = JSON.parse(fs.readFileSync(CHARFILE, 'utf8')); } catch (e) {}

let rooms = [];
try { rooms = JSON.parse(fs.readFileSync(ROOMFILE, 'utf8')); } catch (e) {}
if (!Array.isArray(rooms) || !rooms.length) {
  rooms = [{ id: 'general', name: '主频道', allowed: [], muted: [] }];
  saveRooms();
}

function saveMessages() {
  for (const k in messages) if (messages[k].length > 500) messages[k] = messages[k].slice(-500);
  fs.writeFile(MSGLOG, JSON.stringify(messages), () => {});
}
function saveChars() { fs.writeFile(CHARFILE, JSON.stringify(characters), () => {}); }
function saveRooms() { fs.writeFile(ROOMFILE, JSON.stringify(rooms), () => {}); }


// ---- tactical map v4 (多楼层对象模型, 每频道一份) ----
// map.json per channel: { floors:[], rooms:[], passages:[], doors:[], entry:null }
//  - floor : { id, name }，楼层。zone 通过 floorId 归属楼层。
//  - room  : 可站、可命名、受房间级迷雾(explored)控制；{ id, floorId, shape, x,y,w,h|cx,cy,r, name, explored }
//  - passage: 通道(走廊)，无需命名、恒可见、可站；{ id, floorId, x,y,w,h }
//  - door  : 门/梯。绑定一对 zone { a, b }。移动可达 = 几何相邻(同层相贴/相交)，
//            或该对有跨层梯门(ladder)。相邻即默认可走；若这对上面有 locked 门则被阻断。
//            { id, a, b, type:'door'|'ladder', locked:bool }
const MAPFILE = path.join(DATA, 'map.json');
let maps = {};
try { maps = JSON.parse(fs.readFileSync(MAPFILE, 'utf8')); } catch (e) { maps = {}; }
const mapVer = {};                                   // channelId -> version, bump on any change
function saveMaps() { fs.writeFile(MAPFILE, JSON.stringify(maps), () => {}); }
function mapUid(p) { return (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function emptyMap() { return { floors: [{ id: 'F1', name: '1F' }], rooms: [], passages: [], doors: [], entry: null, radar: true, entryVisible: false }; }
// 兼容旧结构(v3: links 连接线 / 通道带 name)：links 升级为 door(旧线=未锁门/跨层=梯)；
// 通道名弃用(通道不取名)。新结构只认 doors。
function migrateMap(m) {
  if (Array.isArray(m.links) && m.links.length && !Array.isArray(m.doors)) {
    m.doors = m.links.map((l) => ({ id: l.id, a: l.a, b: l.b, type: l.type === 'ladder' ? 'ladder' : 'door', locked: false }));
    delete m.links;
  }
  if (!Array.isArray(m.doors)) m.doors = [];
  if (Array.isArray(m.passages)) m.passages.forEach((p) => { delete p.name; });
  return m;
}
function getMap(ch) {
  if (!maps[ch] || !Array.isArray(maps[ch].rooms)) { maps[ch] = emptyMap(); saveMaps(); }
  migrateMap(maps[ch]);
  if (!Array.isArray(maps[ch].floors) || !maps[ch].floors.length) maps[ch].floors = [{ id: 'F1', name: '1F' }];
  return maps[ch];
}
function findZone(m, id) {
  return (m.rooms || []).find((r) => r.id === id) || (m.passages || []).find((p) => p.id === id) || null;
}
function zoneFloor(z) { return (z && z.floorId) || 'F1'; }
function bumpMap(ch) { mapVer[ch] = (mapVer[ch] || 0) + 1; }

// 房间/通道内部的整数站格(逻辑格, 每格 1 单位)。rect: x..x+w-1/y..y+h-1；poly: 用点in多边形判定。
function zoneCells(z) {
  const out = [];
  if (z.shape === 'poly' && Array.isArray(z.polygon) && z.polygon.length) {
    const bb = polyBBox(z.polygon);
    for (let y = Math.floor(bb.y0); y <= Math.ceil(bb.y1); y++)
      for (let x = Math.floor(bb.x0); x <= Math.ceil(bb.x1); x++)
        if (pointInPoly({ x, y }, z.polygon)) out.push({ x, y });
    return out;
  }
  const w = Math.max(1, Math.round(z.w || 1)), h = Math.max(1, Math.round(z.h || 1));
  for (let y = Math.round(z.y); y < Math.round(z.y) + h; y++) for (let x = Math.round(z.x); x < Math.round(z.x) + w; x++) out.push({ x, y });
  return out;
}

// ---- 门/可达：真实几何相邻 + 门判定 ----
// 相邻定义：同层两对象(房间/通道，含多边形)的真实最短距离 ≤ ADJ(容差1格) 即可走。
// 这样：贴边(gap≈0)可走；通道轻微切入对象(≤ADJ)也算可走。
// 创建时只禁止"过度穿透"(gap < -ADJ)，即允许最多轻切1格。
const ADJ = 1;                                                        // 相邻/轻切容差(格)
function zoneBox(z) {
  if (z.shape === 'poly' && Array.isArray(z.polygon) && z.polygon.length) return polyBBox(z.polygon);
  return { x0: z.x, y0: z.y, x1: z.x + (z.w || 1), y1: z.y + (z.h || 1) };
}
// 点到轴对齐矩形最近距离(≥0)
function distPtRect(x, y, rc) { const dx = Math.max(rc.x0 - x, 0, x - rc.x1), dy = Math.max(rc.y0 - y, 0, y - rc.y1); return Math.hypot(dx, dy); }
function rectRectGap(a, b) {                                          // 负=重叠深度
  const xov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const yov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (xov < 0 && yov < 0) return Math.hypot(-xov, -yov);              // 斜向分离
  if (xov >= 0 && yov >= 0) return -Math.min(xov, yov);               // 双向重叠 => 切入深度
  return xov < 0 ? -xov : -yov;                                       // 仅单轴重叠 => 另一边间距
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
  if(rectRectGap(ba,bb) > ADJ*2) return rectRectGap(ba,bb); // 包围盒远隔，快速返回
  let minD=Infinity;
  for(let i=0;i<pa.length;i++){ const a1=pa[i],a2=pa[(i+1)%pa.length];
    for(let j=0;j<pb.length;j++){ const b1=pb[j],b2=pb[(j+1)%pb.length];
      if(segIntersect(a1,a2,b1,b2)) return 0;               // 边相交/重叠 => 真实相邻
      const dd=segPointSeg(a1,a2,b1,b2); if(dd<minD)minD=dd;
    }
  }
  let inside=false;
  for(const p of pa) if(pointInPoly(p,pb)){inside=true;break;}
  if(!inside) for(const p of pb) if(pointInPoly(p,pa)){inside=true;break;}
  if(inside) return -Math.min(minD,1);                      // 包含 => 负(重叠)
  return minD;
}
// 两 zone 真实最短间隙(≤0 表示已相交/切入)。调用方须先确保同层。
function shapeGap(a, b) {
  const ap = a.shape === 'poly', bp = b.shape === 'poly';
  if (!ap && !bp) return rectRectGap(zoneBox(a), zoneBox(b));
  const pa = ap ? a.polygon : rectPoly(a), pb = bp ? b.polygon : rectPoly(b);
  return polyPolyGap(pa, pb);
}
// 同层几何相邻(贴边或轻切≤ADJ)即"可走"
function touches(a, b) { if (!a || !b || zoneFloor(a) !== zoneFloor(b)) return false; return shapeGap(a, b) <= ADJ; }
function doorKey(idA, idB) { return idA < idB ? idA + '::' + idB : idB + '::' + idA; }
// 两 zone 间的门对象(不分方向)
function doorBetween(m, a, b) { return (m.doors || []).find((d) => d.a === a && d.b === b || d.b === a && d.a === b) || null; }
// 从某 zone 判定能否走到目标 zone：
//  同层相邻(真实距离≤ADJ)：若该对有门且 locked => 阻断；否则可走。
//  跨层：仅当存在 type=ladder 且未锁的门(视为两楼对应位置打通)才可走。
function canWalk(m, fromId, toId) {
  const a = findZone(m, fromId), b = findZone(m, toId); if (!a || !b) return false;
  // 走进"未开放"房间(open===false)：即便有通道/门(含未锁)也一律不可入。房间有 shape 字段，通道没有。
  if (b.shape && b.open === false) return false;
  const d = doorBetween(m, fromId, toId);
  if (zoneFloor(a) === zoneFloor(b)) {
    if (!touches(a, b)) return false;                                  // 同层不相邻 => 不可达
    return !(d && d.locked);                                           // 相邻且无锁门 => 可走
  }
  return !!(d && d.type === 'ladder' && !d.locked);                   // 跨层必须显式建梯
}
// 沿"未锁相邻/梯"可达的所有 zone（BFS）。返回 Set<id>；路径上遇锁门即断。
function reachSet(m, fromId) {
  const seen = new Set([fromId]); const q = [fromId];
  while (q.length) {
    const cur = q.pop();
    for (const z of (m.rooms || []).concat(m.passages || [])) {
      if (seen.has(z.id) || !canWalk(m, cur, z.id)) continue;
      seen.add(z.id); q.push(z.id);
    }
  }
  return seen;
}

// ---- 玩家位置(内存, 重启清零)。key = channel::呼号 -> { roomId, x, y } ----
const ppos = {};
function pkey(call, ch) { return ch + '::' + call; }
function occupiedByOthers(m, zoneId, excludeCall) {
  const s = new Set();
  for (const k in ppos) { const p = ppos[k]; if (p.roomId === zoneId && k.split('::')[1] !== excludeCall) s.add(p.x + ',' + p.y); }
  return s;
}
function freeSlot(m, zone, call) {
  const occ = occupiedByOthers(m, zone.id, call);
  for (const c of zoneCells(zone)) if (!occ.has(c.x + ',' + c.y)) return { x: c.x, y: c.y };
  return { x: 0, y: 0 };                                // 满了就落到(0,0)附近，极少发生
}
function placeAt(ch, call, zoneId, optOut) {
  const m = getMap(ch), z = findZone(m, zoneId);
  if (!z) return false;
  const s = freeSlot(m, z, call);
  ppos[pkey(call, ch)] = { roomId: zoneId, x: s.x, y: s.y };
  if (optOut) optOut();
  return true;
}
// 玩家首次出现在某频道：若有地图且有入口，出生到入口。
function ensurePlayer(ch, call) {
  const m = maps[ch];
  if (!m || !Array.isArray(m.rooms)) return false;
  if (ppos[pkey(call, ch)]) return true;
  if (!m.entry || !findZone(m, m.entry)) return false;
  return placeAt(ch, call, m.entry);
}

// ---- 房间级迷雾 + 视图过滤 ----
function isExploredRoom(r) { return !!r.explored; }
function collectPlayers(m) {
  const byZone = {};
  for (const k in ppos) {
    const sep = k.indexOf('::'); if (sep < 0) continue;
    const p = ppos[k];
    (byZone[p.roomId] = byZone[p.roomId] || []).push({ call: k.slice(sep + 2), x: p.x, y: p.y });
  }
  return byZone;
}
// 返回某频道某玩家可见的视图副本；GM 恒全量。
function viewMap(ch, call, gmFlag) {
  const m = getMap(ch);
  if (gmFlag) {
    return {
      entry: m.entry || null,
      floors: JSON.parse(JSON.stringify(m.floors || [])),
      rooms: JSON.parse(JSON.stringify(m.rooms || [])),
      passages: JSON.parse(JSON.stringify(m.passages || [])),
      doors: JSON.parse(JSON.stringify(m.doors || [])),
      customTypes: JSON.parse(JSON.stringify(m.customTypes || [])),
      players: collectPlayers(m),
      radar: m.radar !== false,
      entryVisible: !!m.entryVisible
    };
  }
  const my = ppos[pkey(call, ch)];
  const myZone = my ? findZone(m, my.roomId) : null;
  // 玩家视角所在层 = 其所在 zone 的楼层；未出生/无入口则取入口层，仍无则 F1
  const myFloor = myZone ? zoneFloor(myZone) : (m.entry ? zoneFloor(findZone(m, m.entry)) : 'F1');
  // 该层内可见房间：已探索 或 我正身处其中
  const visRoom = new Set((m.rooms || []).filter((r) => zoneFloor(r) === myFloor && (isExploredRoom(r) || (my && r.id === my.roomId))).map((r) => r.id));
  // 该层通道恒可见
  const visPass = new Set((m.passages || []).filter((p) => zoneFloor(p) === myFloor).map((p) => p.id));
  const roomVisible = (id) => visRoom.has(id) || visPass.has(id);
  const rooms = (m.rooms || []).filter((r) => visRoom.has(r.id)).map((r) => ({ id: r.id, shape: r.shape, x: r.x, y: r.y, w: r.w, h: r.h, polygon: r.shape === 'poly' ? r.polygon : undefined, type: r.type || '', name: r.name, floorId: zoneFloor(r), explored: true, open: r.open !== false }));
  const passages = (m.passages || []).filter((p) => visPass.has(p.id)).map((p) => ({ id: p.id, x: p.x, y: p.y, w: p.w, h: p.h, floorId: zoneFloor(p) }));
  // 门/梯：同层两 zone 都在本层可见才显示；跨层梯本层那端可见即显示(标注去向)。locked 不隐藏(玩家需看到"锁着的门")
  const doors = (m.doors || []).filter((d) => {
    const a = findZone(m, d.a), b = findZone(m, d.b); if (!a || !b) return false;
    const af = zoneFloor(a), bf = zoneFloor(b);
    if (af === bf) return af === myFloor && roomVisible(d.a) && roomVisible(d.b);
    if (af === myFloor) return roomVisible(d.a);
    if (bf === myFloor) return roomVisible(d.b);
    return false;
  }).map((d) => ({ id: d.id, a: d.a, b: d.b, type: d.type || 'door', locked: !!d.locked }));
  const byZone = collectPlayers(m), players = {};
  for (const zid in byZone) { const z = findZone(m, zid); if (z && zoneFloor(z) === myFloor && roomVisible(zid)) players[zid] = byZone[zid]; }
  return { entry: m.entry || null, floors: JSON.parse(JSON.stringify(m.floors || [])), curFloor: myFloor, rooms, passages, doors, players, customTypes: JSON.parse(JSON.stringify(m.customTypes || [])), radar: m.radar !== false, entryVisible: !!m.entryVisible };
}

// ---- 地图 op 应用（绘图权限仅 GM；位置类移动走 doGo，不由 op 处理）----
function applyMapOps(m, ops, user, gmFlag) {
  if (!Array.isArray(ops) || !gmFlag) return false;
  let changed = false;
  for (const op of ops) {
    if (!op || !op.t) continue;
    if (op.t === 'room.upsert') {
      const r = op.room || {};
      const fid = ('' + (r.floorId || 'F1')).slice(0, 12) || 'F1';
      let clean;
      if (r.shape === 'poly' && Array.isArray(r.polygon) && r.polygon.length >= 3) {
        const bb = polyBBox(r.polygon);
        clean = { id: r.id || mapUid('R'), floorId: fid, shape: 'poly',
          x: Math.round(bb.x0), y: Math.round(bb.y0), w: Math.max(1, Math.round(bb.x1 - bb.x0)), h: Math.max(1, Math.round(bb.y1 - bb.y0)),
          polygon: r.polygon.map((p) => ({ x: Math.round(+p.x), y: Math.round(+p.y) })),
          type: (r.type || '').slice(0, 8), name: (r.name || '').slice(0, 20), explored: !!r.explored };
      } else {
        clean = { id: r.id || mapUid('R'), floorId: fid, shape: 'rect',
          x: Math.round(+r.x), y: Math.round(+r.y), w: Math.max(1, Math.round(+r.w || 3)), h: Math.max(1, Math.round(+r.h || 3)),
          type: (r.type || '').slice(0, 8), name: (r.name || '').slice(0, 20), explored: !!r.explored };
      }
      const i = (m.rooms || []).findIndex((z) => z.id === clean.id);
      if (i >= 0) m.rooms[i] = Object.assign({}, m.rooms[i], clean); else (m.rooms = m.rooms || []).push(clean);
      changed = true;
    } else if (op.t === 'room.del') {
      const i = (m.rooms || []).findIndex((r) => r.id === op.id); if (i >= 0) { m.rooms.splice(i, 1); changed = true; }
      if (m.entry === op.id) m.entry = null;              // 删掉入口房间时一并清除残留入口
    } else if (op.t === 'passage.upsert') {
      const p = op.passage || {};
      const fid = ('' + (p.floorId || 'F1')).slice(0, 12) || 'F1';
      const clean = { id: p.id || mapUid('P'), floorId: fid, x: Math.round(+p.x), y: Math.round(+p.y), w: Math.max(1, Math.round(+p.w || 2)), h: Math.max(1, Math.round(+p.h || 2)) };
      const i = (m.passages || []).findIndex((z) => z.id === clean.id);
      if (i >= 0) m.passages[i] = Object.assign({}, m.passages[i], clean); else (m.passages = m.passages || []).push(clean);
      changed = true;
    } else if (op.t === 'passage.del') {
      const i = (m.passages || []).findIndex((p) => p.id === op.id); if (i >= 0) { m.passages.splice(i, 1); changed = true; }
    } else if (op.t === 'door.set') {
      // 安放一扇门/梯：绑定两 zone。同层须几何相邻；跨层自动视为梯(ladder)。同对去重。
      const d = op.door || {};
      const a = findZone(m, d.a), b = findZone(m, d.b);
      if (!a || !b || d.a === d.b) continue;
      const cross = zoneFloor(a) !== zoneFloor(b);
      if (!cross && !touches(a, b)) continue;                  // 同层不相邻不能安普通门
      const clean = { id: d.id || mapUid('D'), a: d.a, b: d.b, type: d.type === 'ladder' || cross ? 'ladder' : 'door', locked: !!d.locked };
      const key = doorKey(d.a, d.b); let i = -1;
      for (let z = 0; z < (m.doors || []).length; z++) if (doorKey(m.doors[z].a, m.doors[z].b) === key) { i = z; break; }
      if (i >= 0) m.doors[i] = Object.assign({}, m.doors[i], clean); else (m.doors = m.doors || []).push(clean);
      changed = true;
    } else if (op.t === 'door.del') {
      const i = (m.doors || []).findIndex((x) => x.id === op.id || (x.a === op.a && x.b === op.b) || (x.b === op.a && x.a === op.b)); if (i >= 0) { m.doors.splice(i, 1); changed = true; }
    } else if (op.t === 'door.lock') {
      const i = (m.doors || []).findIndex((x) => x.id === op.id || doorKey(x.a, x.b) === doorKey(op.a || '', op.b || '')); if (i >= 0) { m.doors[i].locked = !!op.v; changed = true; }
    } else if (op.t === 'entry') {
      if (findZone(m, op.id)) { m.entry = op.id; changed = true; }
    } else if (op.t === 'room.open') {
      // 开放/关闭某房间：open===false 的房间玩家走不进去（不影响迷雾 explored 决定的可见性）。
      const r = (m.rooms || []).find((x) => x.id === op.id); if (r && r.open !== !!op.v) { if (op.v) delete r.open; else r.open = false; changed = true; }
    } else if (op.t === 'explore') {
      const r = (m.rooms || []).find((x) => x.id === op.id); if (r) { r.explored = !!op.v; changed = true; }
    } else if (op.t === 'explore.floor') {
      const fid = op.floor || 'F1'; let any = false; (m.rooms || []).forEach((x) => { if (zoneFloor(x) === fid && x.explored !== !!op.v) { x.explored = !!op.v; any = true; } }); if (any) changed = true;
    } else if (op.t === 'explore.all') {
      let any = false; (m.rooms || []).forEach((x) => { if (x.explored !== !!op.v) { x.explored = !!op.v; any = true; } }); if (any) changed = true;
    } else if (op.t === 'floor.add') {
      const f = op.floor || {}; const fid = f.id || mapUid('F');
      if (!(m.floors || []).some(x => x.id === fid)) { (m.floors = m.floors || []).push({ id: fid, name: (f.name || ('层' + (m.floors.length + 1))).slice(0, 12) }); changed = true; }
    } else if (op.t === 'floor.del') {
      const fid = op.id; const i = (m.floors || []).findIndex((f) => f.id === fid); if (i >= 0 && m.floors.length > 1) {
        m.floors.splice(i, 1);
        const gone = new Set(); (m.rooms || []).forEach((x) => { if (zoneFloor(x) === fid) gone.add(x.id); }); (m.passages || []).forEach((x) => { if (zoneFloor(x) === fid) gone.add(x.id); });
        m.rooms = (m.rooms || []).filter((x) => !gone.has(x.id)); m.passages = (m.passages || []).filter((x) => !gone.has(x.id));
        m.doors = (m.doors || []).filter((d) => !gone.has(d.a) && !gone.has(d.b));
        if (m.entry && gone.has(m.entry)) m.entry = null;
        changed = true;
      }
    } else if (op.t === 'types.set') {
      // 自定义房间类型(设施)：GM 自定义名称+缩写(+颜色)，随地图持久化并同步给玩家
      const arr = Array.isArray(op.types) ? op.types : [];
      m.customTypes = arr.map((t) => ({ code: ('' + (t.code || '')).slice(0, 8), name: ('' + (t.name || '')).slice(0, 20), fill: ('' + (t.fill || 'rgba(40,90,60,0.92)')).slice(0, 40), line: ('' + (t.line || '#41e58f')).slice(0, 40) })).filter((t) => t.code);
      changed = true;
    } else if (op.t === 'radar.set') {
      // 雷达开关：控制侧栏小地图的显示（关闭时所有客户端的小地图都画上"信号丢失"）
      m.radar = !!op.v;
      changed = true;
    } else if (op.t === 'entry.toggle') {
      // 入口可见开关：玩家端小地图强制显示入口房间（不依赖已探索）
      m.entryVisible = !!op.v;
      changed = true;
    }
  }
  return changed;
}

// ---- !go 移动 ----
// 可达 = 沿"未锁相邻/梯"连续走通（房间与通道都算可经过）。锁着的门把路断开。
function doGo(ch, call, targetName) {
  const m = getMap(ch);
  if (!m.entry || !findZone(m, m.entry)) return { ok: false, msg: '这张地图还没有「入口房间」，请 GM 先把一个房间设为入口。' };
  // 先确保自己已出生
  if (!ppos[pkey(call, ch)]) { placeAt(ch, call, m.entry); }
  const cur = ppos[pkey(call, ch)];
  const name = (targetName || '').trim();
  const target = (m.rooms || []).find((r) => r.name === name || r.id === name)
    || (m.passages || []).find((p) => p.id === name);
  if (!target) return { ok: false, msg: '没找到名为「' + (name || '?') + '」的房间。可用 !here 查看当前所在与可去之处。' };
  if (target.id === cur.roomId) return { ok: true, moved: false, msg: '你已经在「' + zoneLabel(target) + '」了。' };
  if (target.shape && target.open === false) return { ok: false, msg: '「' + zoneLabel(target) + '」尚未开放，进不去。' };
  const reach = reachSet(m, cur.roomId);
  if (!reach.has(target.id)) {
    const direct = doorBetween(m, cur.roomId, target.id);
    if (direct && direct.locked) return { ok: false, msg: '通往「' + zoneLabel(target) + '」的门是锁着的，打不开。' };
    return { ok: false, msg: '「' + zoneLabel(target) + '」暂时走不过去（通道未接通，或有锁着的门挡路）。可用 !here 查看可去之处。' };
  }
  const s = freeSlot(m, target, call);
  cur.roomId = target.id; cur.x = s.x; cur.y = s.y;
  let revealed = false;
  const r = (m.rooms || []).find((x) => x.id === target.id);
  if (r && !r.explored) { r.explored = true; revealed = true; }
  const d = doorBetween(m, cur.roomId, target.id);
  return { ok: true, moved: true, revealed, via: (d && d.type === 'ladder' ? 'ladder' : 'walk'), msg: call + ' → ' + zoneLabel(target) };
}
function zoneLabel(z) { return (z.name || (z.shape ? '房间' : '通道')) || (z.id || ''); }
// !here：列出沿未锁通道/梯能到达的房间（含走廊，标注去向）
function here(ch, call) {
  const m = getMap(ch);
  if (!m || !Array.isArray(m.rooms) || !m.rooms.length) return '这张频道还没有地图。';
  if (!m.entry) return '地图还没有入口，等 GM 把某个房间设为入口。';
  if (!ppos[pkey(call, ch)]) placeAt(ch, call, m.entry);
  const cur = ppos[pkey(call, ch)];
  const cz = findZone(m, cur.roomId);
  if (!cz) return '你目前不在任何房间。';
  const curFloor = zoneFloor(cz);
  const reach = reachSet(m, cur.roomId);
  const can = [];
  // 列出可达且能作为 !go 目标的"房间"；走廊仅作通道不计为去处名。
  for (const z of m.rooms || []) {
    if (z.id === cur.roomId || !reach.has(z.id)) continue;
    const d = doorBetween(m, cur.roomId, z.id);
    const cross = zoneFloor(z) !== curFloor;
    const mark = cross ? '（梯）' : (d && d.locked ? '🔒' : '');
    can.push(zoneLabel(z) + mark);
  }
  return '你在「' + zoneLabel(cz) + '」' + (can.length ? '。可去：' + can.join('、') : '。这里没有出口。') + ' ｜ 用法：!go 房间名';
}


// ---- clients / broadcast ----
const clients = [];
const stress = {};

function isGM(gm) { return gm === GM_CODE; }
function canAccess(user, gm, room) {
  if (isGM(gm)) return true;
  if (!room.allowed || !room.allowed.length) return true;
  return room.allowed.includes(user);
}
function findRoom(id) { return rooms.find((r) => r.id === id); }

function broadcast(roomId, obj) {
  const data = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const c of clients) {
    try {
      if (c.isGM) c.res.write(data);
      else if (c.room === roomId) c.res.write(data);
    } catch (e) {}
  }
}

function kickFromRoom(roomId, text, onlyUsers) {
  for (let i = clients.length - 1; i >= 0; i--) {
    const c = clients[i];
    if (c.isGM) continue;            // GM 看所有频道，不被踢
    if (c.room !== roomId) continue;
    if (onlyUsers && onlyUsers.length && !onlyUsers.includes(c.user)) continue;
    try { c.res.write('data: ' + JSON.stringify({ type: 'system', text, kick: true }) + '\n\n'); } catch (e) {}
    try { clearInterval(c.hb); c.res.end(); } catch (e) {}
    clients.splice(i, 1);
  }
}

function addMessage(roomId, obj) {
  obj.id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  obj.ts = Date.now();
  obj.room = roomId;
  (messages[roomId] = messages[roomId] || []).push(obj);
  saveMessages();
  broadcast(roomId, obj);
}

// Mothership 1e Panic Table (d20): 1=FOCUS, 20=最坏
const PANIC_TABLE = {
  1:  'FOCUS：你稳住心神，下一次检定/豁免获得优势(Advantage)。',
  2:  'FREEZE：你僵住了，直到通过一次 Fear 检定才能行动。',
  3:  'SCREAM：你尖叫，附近所有人立即做一次 Fear 检定。',
  4:  'RAGE：你陷入杀意狂怒，下一次攻击 +20。',
  5:  'COWER：你抱头蜷缩，所有行动 -20 直到冷静。',
  6:  'FAINT：你当场昏厥倒地。',
  7:  'HIDE：你仓皇找掩体并 HIDE。',
  8:  'FLEE：你惊恐逃窜，拼命远离威胁。',
  9:  'SOB：你崩溃抽泣，无法言语。',
  10: 'HYPERVENTILATE：你喘不过气，下次行动 -10。',
  11: 'SHAKE：你双手止不住发抖，下次检定 -10。',
  12: 'PARANOIA：你认定身边某人就是威胁。',
  13: 'PANIC ATTACK：恐慌发作，额外损失 1 点 Stress。',
  14: 'BLACKOUT：你短暂黑视，跳过下一回合。',
  15: 'THROW UP：你呕吐，失去本次行动并脱手所握之物。',
  16: 'CLOSE EYES：你紧闭双眼捂住耳朵。',
  17: 'DROP：你丢下所有手持物品。',
  18: 'WHIMPER：你呜咽求饶，存在感 -10。',
  19: 'COLLAPSE：你瘫跪在地。',
  20: 'HEART ATTACK：你捂住胸口——立即做一次 Body 检定，否则受到 1 点 Wound（甚至更糟）。'
};
// 四职业 Trauma Response（母舰 1e）
function traumaResponse(cls) {
  const c = (cls || '').toLowerCase();
  if (c.includes('scientist') || c.includes('科学家')) return '【创伤反应·Scientist】恐慌时可重掷一次 Panic Die。';
  if (c.includes('teamster') || c.includes('机械师') || c.includes('驾驶员')) return '【创伤反应·Teamster】恐慌时可改为承受比结果严重一级的效果。';
  if (c.includes('android') || c.includes('机器人') || c.includes('仿生') || c.includes('安卓')) return '【创伤反应·Android】恐慌时可改为系统过载——承受 1 点 Stress 而非触发恐慌表。';
  if (c.includes('marine') || c.includes('陆战队') || c.includes('海军')) return '【创伤反应·Marine】恐慌时附近所有盟友必须立即做一次 Fear 检定。';
  return '';
}

function rnd(n) { return Math.floor(Math.random() * n) + 1; }

function rollPool(expr) {
  const parts = expr.split(/(?=[+\-])/);
  const rolls = [];
  let total = 0;
  let ok = true;
  for (const p of parts) {
    if (p.indexOf('d') >= 0) {
      const mm = p.match(/(\d*)d(\d+)/);
      if (!mm) { ok = false; break; }
      const count = mm[1] ? +mm[1] : 1;
      const sides = +mm[2];
      for (let i = 0; i < count; i++) { const d = rnd(sides); rolls.push(d); total += d; }
    } else {
      total += +p;
    }
  }
  return { ok, rolls, total };
}

// returns dice/result object or null; `user` is the roller (sender), re-attributed to a proxy target if GM uses @name
function parseDice(text, user, room, gm) {
  const roller = user;
  let t = text.trim();
  if (!t.startsWith('!')) return null;
  let cmd = t.slice(1).trim();

  // advantage / disadvantage flag
  let adv = false, dis = false;
  const am = cmd.match(/\s+(adv|advantage|dis|disadvantage)$/i);
  if (am) {
    const w = am[1].toLowerCase();
    if (w.startsWith('adv')) adv = true; else dis = true;
    cmd = cmd.slice(0, am.index).trim();
  }

  // 代投目标: 末尾 @呼号（仅 GM 可代投，结果归属到该呼号）
  let proxy = false;
  const tm = cmd.match(/@([^\s@，。、,.;:!?]+)\s*$/);
  if (tm) {
    cmd = cmd.slice(0, tm.index).trim();
    if (isGM(gm)) { user = tm[1]; proxy = true; }
    else return { type: 'system', text: '只有 GM 可代投他人骰子（' + roller + '）' };
  }

  // 从当前房间(回退 general)角色卡读取职业，用于 Trauma Response（按被代投者）
  const card = characters[(room || 'general') + '::' + user] || characters['general::' + user];
  const userCls = card ? (card.cls || '') : '';

  if (/^(help|\?)$/i.test(cmd)) {
    return { type: 'system', text: '指令 → !roll 2d10+5 [adv|dis] · !d100 · !check 55 [adv|dis] · !stress [n] · !panic [adv|dis] · !go 房间名 · !here · !help ｜ !go 沿地图通道移动到房间，!here 看当前所在与可去之处；!panic 触发母舰 d20 恐慌表并读取你本频道角色卡职业的创伤反应' };
  }

  // 地图移动：!go 房间名 / !here
  const gom = cmd.match(/^go\s+(.+)$/i);
  if (gom) {
    const rr = doGo(room || 'general', user, gom[1]);
    if (rr.ok && rr.moved) {
      mapVer[room] = (mapVer[room] || 0) + 1;
      broadcast(room, { type: 'map', room, v: mapVer[room] });
      return { type: 'msg', user, text: rr.msg + (rr.revealed ? '（首次进入，房间已被你揭示）' : '') };
    }
    return { type: 'system', text: rr.msg };
  }
  if (/^here$/i.test(cmd)) {
    return { type: 'system', text: here(room || 'general', user) };
  }

  let m = cmd.match(/^stress\s*(\d+)?$/i);
  if (m) {
    if (m[1]) {
      stress[user] = Math.max(0, Math.min(99, +m[1]));
      return { type: 'system', text: user + ' 的 Stress 设为 ' + stress[user] };
    }
    return { type: 'system', text: user + ' 当前 Stress = ' + (stress[user] || 2) };
  }

  if (/^panic$/i.test(cmd)) {
    const s = stress[user] || 2;
    const d1 = rnd(20);
    let rolls = [d1], chosen = d1;
    if (adv || dis) { const d2 = rnd(20); rolls = [d1, d2]; chosen = adv ? Math.min(d1, d2) : Math.max(d1, d2); }
    let res, trauma = '';
    if (chosen === 1) {
      res = PANIC_TABLE[1];
    } else if (chosen < s) {
      res = '【恐慌 d' + chosen + '】' + PANIC_TABLE[chosen];
      trauma = traumaResponse(userCls);
    } else {
      res = '保持冷静，Stress -1';
    }
    return { type: 'dice', user, sub: 'panic', proxy, proxyBy: roller, formula: 'd20<' + s, adv, dis, rolls, chosen, note: res, trauma, cls: userCls };
  }

  m = cmd.match(/^check\s+(\d+)$/i);
  if (m) {
    const target = +m[1];
    const r1 = rnd(100);
    if (adv || dis) {
      const r2 = rnd(100);
      const chosen = adv ? Math.min(r1, r2) : Math.max(r1, r2);
      return { type: 'dice', user, sub: 'check', proxy, proxyBy: roller, formula: 'd100≤' + target, adv, dis, rolls: [r1, r2], chosen, success: chosen <= target, target };
    }
    return { type: 'dice', user, sub: 'check', proxy, proxyBy: roller, formula: 'd100≤' + target, rolls: [r1], chosen: r1, success: r1 <= target, target };
  }

  m = cmd.match(/^(?:roll|r)\s+([\ddD+ \-]+)$/i);
  if (m) {
    const expr = m[1].replace(/\s+/g, '').toLowerCase();
    const a = rollPool(expr);
    if (!a.ok) return { type: 'system', text: '骰子语法错误，例: !roll 2d10+5 [adv|dis]' };
    if (adv || dis) {
      const b = rollPool(expr);
      const chosen = adv ? (a.total >= b.total ? a : b) : (a.total <= b.total ? a : b);
      const other = chosen === a ? b : a;
      return { type: 'dice', user, sub: 'roll', proxy, proxyBy: roller, formula: expr, adv, dis, rolls: chosen.rolls, total: chosen.total, alt: { rolls: other.rolls, total: other.total } };
    }
    return { type: 'dice', user, sub: 'roll', proxy, proxyBy: roller, formula: expr, rolls: a.rolls, total: a.total };
  }

  m = cmd.match(/^d(\d+)$/i);
  if (m) {
    const sides = +m[1];
    const d1 = rnd(sides);
    if (adv || dis) {
      const d2 = rnd(sides);
      const chosen = adv ? Math.min(d1, d2) : Math.max(d1, d2);
      return { type: 'dice', user, sub: 'roll', proxy, proxyBy: roller, formula: 'd' + sides, adv, dis, rolls: [d1, d2], total: chosen, alt: { rolls: [chosen === d1 ? d2 : d1], total: chosen === d1 ? d2 : d1 } };
    }
    return { type: 'dice', user, sub: 'roll', proxy, proxyBy: roller, formula: 'd' + sides, rolls: [d1], total: d1 };
  }

  return { type: 'system', text: '未知指令，输入 !help 查看。' };
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function serveStatic(p, res) {
  const rel = p === '/' ? '/index.html' : p;
  // Packaged exe: serve from inlined base64 assets (no filesystem dependency).
  if (isPkg && INLINE_ASSETS[rel]) {
    const ext = path.extname(rel).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(Buffer.from(INLINE_ASSETS[rel], 'base64'));
    return;
  }
  const fp = path.join(PUBLIC, path.normalize(rel));
  if (fp !== PUBLIC && !fp.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end('no'); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function sendJSON(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 5e6) req.destroy(); });
  req.on('end', () => cb(b));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ---- SSE ----
  if (req.method === 'GET' && p === '/events') {
    const room = url.searchParams.get('room') || 'general';
    const gm = url.searchParams.get('gm') || '';
    const user = (url.searchParams.get('user') || '').slice(0, 20);
    const gmFlag = isGM(gm);
    const roomObj = findRoom(room);
    if (room !== '*' && !roomObj) { res.writeHead(404); res.end('no room'); return; }
    if (room !== '*' && roomObj && !canAccess(user, gm, roomObj)) { res.writeHead(403); res.end('denied'); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 3000\n\n');

    // backlog
    if (gmFlag) {
      const all = [];
      for (const k in messages) for (const m of (messages[k] || [])) all.push(m);
      all.sort((a, b) => a.ts - b.ts);
      for (const m of all.slice(-80)) res.write('data: ' + JSON.stringify(m) + '\n\n');
    } else {
      for (const m of ((messages[room] || []).slice(-50))) res.write('data: ' + JSON.stringify(m) + '\n\n');
    }

    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 25000);
    const client = { res, room, user, isGM: gmFlag, hb };
    clients.push(client);
    const cleanup = () => { clearInterval(hb); const i = clients.indexOf(client); if (i >= 0) clients.splice(i, 1); };
    req.on('close', cleanup);
    return;
  }

  // ---- send message ----
  if (req.method === 'POST' && p === '/api/send') {
    readBody(req, (b) => {
      let parsed; try { parsed = JSON.parse(b); } catch (e) { res.writeHead(400); res.end('bad'); return; }
      const user = (parsed.user || '匿名').slice(0, 20);
      const gm = parsed.gm || '';
      const room = parsed.room || 'general';
      const roomObj = findRoom(room);
      const text = (parsed.text || '').slice(0, 1000);

      if (!roomObj || !canAccess(user, gm, roomObj)) {
        sendJSON(res, { ok: 0, error: 'no_access' });
        return;
      }
      // 单频道静音：被静音的非 GM 用户不能发，但能看
      if (!isGM(gm) && (roomObj.muted || []).map((x) => ('' + x).trim()).includes(user)) {
        sendJSON(res, { ok: 0, error: 'muted' });
        return;
      }
      if (parsed.type === 'join') {
        addMessage(room, { type: 'system', text: user + ' 接入「' + roomObj.name + '」' });
      } else if (text.startsWith('!')) {
        const r = parseDice(text, user, room, gm);
        if (r) { if (!r.user) r.user = user; addMessage(room, r); }
      } else if (text.trim()) {
        // 发言身份：player（默认）/ character（用角色卡 name）/ scene（场景/旁白）
        let as = parsed.as;
        if (as !== 'character' && as !== 'scene') as = 'player';
        const msg = { type: 'msg', user, text, as };
        if (as === 'character') {
          // charId 必须是当前 user 在该 room 的角色卡 key，否则降级为 player
          const key = room + '::' + user;
          if (characters[key] && (!parsed.charId || parsed.charId === key)) msg.charId = key;
          else { msg.as = 'player'; delete msg.charId; }
        }
        addMessage(room, msg);
      }
      sendJSON(res, { ok: 1 });
    });
    return;
  }

  // ---- rooms list ----
  if (req.method === 'GET' && p === '/api/rooms') {
    const user = (url.searchParams.get('user') || '').slice(0, 20);
    const gm = url.searchParams.get('gm') || '';
    const gmFlag = isGM(gm);
    if (gmFlag) {
      const list = rooms.map((r) => ({
        id: r.id, name: r.name, allowed: r.allowed || [], muted: r.muted || [],
        locked: !!(r.allowed && r.allowed.length && !(r.allowed || []).includes(user))
      }));
      sendJSON(res, { gm: true, rooms: list });
    } else {
      const list = rooms.filter((r) => canAccess(user, '', r)).map((r) => ({ id: r.id, name: r.name, allowed: r.allowed || [] }));
      sendJSON(res, { gm: false, rooms: list });
    }
    return;
  }

  // ---- create room ----
  if (req.method === 'POST' && p === '/api/rooms') {
    readBody(req, (b) => {
      let d; try { d = JSON.parse(b); } catch (e) { res.writeHead(400); res.end('bad'); return; }
      if (!isGM(d.gm)) { res.writeHead(403); res.end('forbidden'); return; }
      const name = (d.name || '').trim().slice(0, 30);
      if (!name) { res.writeHead(400); res.end('no name'); return; }
      const allowed = Array.isArray(d.allowed) ? d.allowed.map((x) => ('' + x).trim()).filter(Boolean).slice(0, 50) : [];
      const room = { id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, allowed, muted: [] };
      rooms.push(room);
      saveRooms();
      sendJSON(res, { ok: 1, room });
    });
    return;
  }

  // ---- update / delete room ----
  const um = p.match(/^\/api\/rooms\/([\w-]+)$/);
  if (um) {
    const id = um[1];
    if (req.method === 'PUT') {
      readBody(req, (b) => {
        let d; try { d = JSON.parse(b); } catch (e) { res.writeHead(400); res.end('bad'); return; }
        if (!isGM(d.gm)) { res.writeHead(403); res.end('forbidden'); return; }
        const room = findRoom(id);
        if (!room) { res.writeHead(404); res.end('no room'); return; }
        const oldAllowed = room.allowed || [];
        if (typeof d.name === 'string') room.name = d.name.trim().slice(0, 30);
        if (Array.isArray(d.allowed)) room.allowed = d.allowed.map((x) => ('' + x).trim()).filter(Boolean).slice(0, 50);
        const removed = oldAllowed.filter((u) => !(room.allowed || []).includes(u));
        saveRooms();
        if (removed.length) kickFromRoom(id, '【GM】你已被移出频道「' + room.name + '」', removed);
        sendJSON(res, { ok: 1, room });
      });
      return;
    }
    if (req.method === 'DELETE') {
      readBody(req, (b) => {
        let d; try { d = JSON.parse(b); } catch (e) {}
        if (!isGM(d && d.gm)) { res.writeHead(403); res.end('forbidden'); return; }
        const room = findRoom(id);
        if (!room) { res.writeHead(404); res.end('no room'); return; }
        if (room.id === 'general') { res.writeHead(400); res.end('keep general'); return; }
        addMessage(id, { type: 'system', text: '【GM】频道「' + room.name + '」已关闭' });
        kickFromRoom(id, '【GM】频道「' + room.name + '」已关闭，你已被移出', null);
        rooms = rooms.filter((r) => r.id !== id);
        delete messages[id];
        saveRooms(); saveMessages();
        sendJSON(res, { ok: 1 });
      });
      return;
    }
  }

  // ---- mute toggle (GM only, per room) ----
  if (req.method === 'POST' && p === '/api/mute') {
    readBody(req, (b) => {
      let d; try { d = JSON.parse(b); } catch (e) { res.writeHead(400); res.end('bad'); return; }
      if (!isGM(d.gm)) { res.writeHead(403); res.end('forbidden'); return; }
      const room = findRoom(d.room);
      if (!room) { res.writeHead(404); res.end('no room'); return; }
      const u = ('' + (d.user || '')).trim().slice(0, 20);
      if (!u) { res.writeHead(400); res.end('no user'); return; }
      room.muted = (room.muted || []).map((x) => ('' + x).trim()).filter(Boolean);
      const i = room.muted.indexOf(u);
      if (d.mute && i < 0) room.muted.push(u);
      if (!d.mute && i >= 0) room.muted.splice(i, 1);
      saveRooms();
      sendJSON(res, { ok: 1, room });
    });
    return;
  }

  // ---- characters (scoped per room: key = room + '::' + owner) ----
  if (req.method === 'GET' && p === '/api/characters') {
    const qUser = (url.searchParams.get('user') || '').slice(0, 20);
    const qGm = url.searchParams.get('gm') || '';
    const qRoom = url.searchParams.get('room');
    let out;
    if (qRoom === '*') {
      if (!isGM(qGm)) { res.writeHead(403); res.end('denied'); return; }
      out = Object.values(characters);
    } else if (qRoom) {
      const ro = findRoom(qRoom);
      if (!ro || !canAccess(qUser, qGm, ro)) { res.writeHead(403); res.end('denied'); return; }
      out = Object.values(characters).filter((c) => c.room === qRoom);
    } else {
      // 默认：返回请求者可访问房间内的卡
      const allowedRooms = isGM(qGm) ? rooms.map((r) => r.id)
        : rooms.filter((r) => canAccess(qUser, qGm, r)).map((r) => r.id);
      out = Object.values(characters).filter((c) => allowedRooms.includes(c.room));
    }
    sendJSON(res, out);
    return;
  }
  if (req.method === 'POST' && p === '/api/characters') {
    readBody(req, (b) => {
      let d; try { d = JSON.parse(b); } catch (e) { res.writeHead(400); res.end('bad'); return; }
      const owner = (d.owner || '匿名').slice(0, 20);
      const room = findRoom(d.room) ? d.room : 'general';
      characters[room + '::' + owner] = {
        owner, room,
        name: d.name || owner,
        cls: d.cls || '',
        str: +d.str || 0, spd: +d.spd || 0, int: +d.int || 0, com: +d.com || 0,
        san: +d.san || 0, fea: +d.fea || 0, bod: +d.bod || 0, arm: +d.arm || 0,
        stress: +d.stress || 0, wounds: +d.wounds || 0,
        notes: (d.notes || '').slice(0, 2000),
        items: Array.isArray(d.items) ? d.items.map((x) => ('' + x).slice(0, 80)).filter(Boolean).slice(0, 60) : [],
        image: (d.image || '').slice(0, 3e6),
        updated: Date.now()
      };
      saveChars();
      sendJSON(res, { ok: 1 });
    });
    return;
  }
  if (req.method === 'DELETE' && p === '/api/characters') {
    readBody(req, (b) => {
      let d; try { d = JSON.parse(b); } catch (e) {}
      const owner = d && d.owner;
      const room = d && d.room ? d.room : 'general';
      const key = room + '::' + owner;
      if (owner && characters[key]) { delete characters[key]; saveChars(); }
      sendJSON(res, { ok: 1 });
    });
    return;
  }

  // ---- room log export ----
  if (req.method === 'GET' && p === '/api/roomlog') {
    const user = (url.searchParams.get('user') || '').slice(0, 20);
    const gm = url.searchParams.get('gm') || '';
    const room = url.searchParams.get('room') || 'general';
    if (room === '*') {
      if (!isGM(gm)) { res.writeHead(403); res.end('denied'); return; }
      const out = rooms.map((r) => ({ id: r.id, name: r.name, messages: messages[r.id] || [] }));
      sendJSON(res, { all: true, rooms: out });
      return;
    }
    const roomObj = findRoom(room);
    if (!roomObj || !canAccess(user, gm, roomObj)) { res.writeHead(403); res.end('denied'); return; }
    sendJSON(res, { room, name: roomObj.name, messages: messages[room] || [] });
    return;
  }

  // ---- tactical map (room/passage/link object model) ----
  if (req.method === 'GET' && p === '/api/map') {
    const user = (url.searchParams.get('user') || '').slice(0, 20);
    const gm = url.searchParams.get('gm') || '';
    const gmFlag = isGM(gm);
    const room = url.searchParams.get('room') || 'general';
    if (room === '*') {
      if (!gmFlag) { res.writeHead(403); res.end('denied'); return; }
      const out = {};
      for (const r of rooms) if (maps[r.id]) out[r.id] = { v: mapVer[r.id] || 0, map: maps[r.id] };
      sendJSON(res, { all: true, maps: out });
      return;
    }
    const roomObj = findRoom(room);
    if (!roomObj || !canAccess(user, gm, roomObj)) { res.writeHead(403); res.end('denied'); return; }
    sendJSON(res, { room, v: mapVer[room] || 0, gm: gmFlag, map: viewMap(room, user, gmFlag) });
    return;
  }

  if (req.method === 'POST' && p === '/api/map/op') {
    readBody(req, (b) => {
      let d; try { d = JSON.parse(b); } catch (e) { res.writeHead(400); res.end('bad'); return; }
      const room = d.room || 'general';
      const roomObj = findRoom(room);
      if (!roomObj) { sendJSON(res, { ok: 0, error: 'no_room' }); return; }
      const user = ((d.user || '') + '').slice(0, 20) || '匿名';
      const gm = d.gm || '';
      const gmFlag = isGM(gm);
      if (!canAccess(user, gm, roomObj)) { sendJSON(res, { ok: 0, error: 'no_access' }); return; }
      if (!gmFlag && (roomObj.muted || []).map((x) => ('' + x).trim()).includes(user)) {
        sendJSON(res, { ok: 0, error: 'muted' }); return;
      }
      const m = getMap(room);
      if (applyMapOps(m, d.ops || [], user, gmFlag)) {
        saveMaps();
        mapVer[room] = (mapVer[room] || 0) + 1;
        // 只广播版本号：玩家侧重新拉取（服务端已做房间级过滤）
        // 雷达开关特殊处理：广播 reason 让客户端知道要播扫描动画
        const isRadar = Array.isArray(d.ops) && d.ops.some((o) => o && o.t === 'radar.set');
        const isEntry = Array.isArray(d.ops) && d.ops.some((o) => o && o.t === 'entry.toggle');
        broadcast(room, { type: 'map', room, v: mapVer[room], reason: isRadar ? 'radar' : (isEntry ? 'entry' : undefined), radar: m.radar !== false, entryVisible: !!m.entryVisible });
      }
      sendJSON(res, { ok: 1, v: mapVer[room] || 0 });
    });
    return;
  }

  // 整体替换地图（GM 专用）：导入 JSON 用。body: { room, user, gm, map }
  if (req.method === 'POST' && p === '/api/map') {
    readBody(req, (b) => {
      let d; try { d = JSON.parse(b); } catch (e) { res.writeHead(400); res.end('bad'); return; }
      const room = d.room || 'general';
      const roomObj = findRoom(room);
      if (!roomObj) { sendJSON(res, { ok: 0, error: 'no_room' }); return; }
      const gm = d.gm || '';
      if (!isGM(gm)) { res.writeHead(403); res.end('denied'); return; }
      if (!canAccess(((d.user || '') + '').slice(0, 20) || '匿名', gm, roomObj)) { sendJSON(res, { ok: 0, error: 'no_access' }); return; }
      const src = d.map || {};
      const next = {
        entry: src.entry || null,
        floors: Array.isArray(src.floors) ? src.floors : [{ id: 'F1', name: '1F' }],
        rooms: Array.isArray(src.rooms) ? src.rooms : [],
        passages: Array.isArray(src.passages) ? src.passages : [],
        doors: Array.isArray(src.doors) ? src.doors : [],
        customTypes: Array.isArray(src.customTypes) ? src.customTypes : []
      };
      maps[room] = migrateMap(next);
      if (!Array.isArray(maps[room].floors) || !maps[room].floors.length) maps[room].floors = [{ id: 'F1', name: '1F' }];
      saveMaps();
      bumpMap(room);
      broadcast(room, { type: 'map', room, v: mapVer[room] });
      sendJSON(res, { ok: 1, v: mapVer[room] || 0 });
    });
    return;
  }

  // ---- 终端状态读数（真实数据）：运行时长 / 在线连接 / 今日消息数 ----
  if (req.method === 'GET' && p === '/api/status') {
    let today = 0;
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    for (const k in messages) for (const m of (messages[k] || [])) if ((m.ts || 0) >= day0.getTime()) today++;
    sendJSON(res, {
      ok: 1,
      uptime: Math.floor((Date.now() - BOOT) / 1000),
      online: clients.length,
      today
    });
    return;
  }

  serveStatic(p, res);
});

server.listen(PORT, HOST, () => {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const k in ifaces) for (const i of ifaces[k]) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  console.log('=== 母舰通讯终端已上线 ===');
  console.log('GM 口令 : ' + GM_CODE);
  console.log('本机访问 : http://localhost:' + PORT);
  ips.forEach((ip) => console.log('局域网访问: http://' + ip + ':' + PORT));
  console.log('在同网段设备上用上面的局域网地址打开即可。');
});
