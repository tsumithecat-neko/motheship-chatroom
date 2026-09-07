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
    return { type: 'system', text: '指令 → !roll 2d10+5 [adv|dis] · !d100 · !d20 · !check 55 [adv|dis] · !stress [n] · !panic [adv|dis] · !help ｜ !panic 触发母舰 d20 恐慌表，自动读取你本频道角色卡的职业创伤反应' };
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
        addMessage(room, { type: 'msg', user, text });
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
