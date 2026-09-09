'use strict';

const $ = (s) => document.querySelector(s);
const logEl = $('#log');
let user = '';
let gmCode = '';
let isGM = false;
let es = null;
let joined = false;
let viewRoom = 'general';      // what the user is currently viewing
const roomMsgs = {};           // roomId -> [messages]
let roomNames = {};            // roomId -> name
let sendAs = 'player';          // 'player' | 'character' | 'scene'
const _charCache = {};          // charId -> card object (用于渲染历史角色消息)

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function enc(s) { return encodeURIComponent(s || ''); }
function scroll() { logEl.scrollTop = logEl.scrollHeight; }

function appendSystem(text) {
  const d = document.createElement('div');
  d.className = 'system';
  d.textContent = text;
  logEl.appendChild(d);
  scroll();
  if (/【记录】/.test(text)) updateLogBadge(text);
}
function updateLogBadge(text) {
  const el = document.getElementById('logState');
  if (!el) return;
  let st = '未开始';
  if (/记录已开始|记录已继续/.test(text)) st = '记录中';
  else if (/记录已暂停/.test(text)) st = '已暂停';
  else if (/记录已结束/.test(text)) st = '未开始';
  else if (/记录状态：([^。]+)/.test(text)) st = RegExp.$1;
  el.textContent = isGM ? ('记录：' + st) : '';
  el.className = 'log-state' + (st === '记录中' ? ' on' : st === '已暂停' ? ' paused' : '');
  el.style.display = isGM ? '' : 'none';
  const wrap = document.getElementById('logWrap');
  if (wrap) wrap.style.display = isGM ? '' : 'none';
}
// 记录控制用法弹层：GM 点击「记录」徽标展开 !log 指令清单，点命令可直接发送
function setupLogHelp() {
  const badge = document.getElementById('logState');
  const wrap = document.getElementById('logWrap');
  const help = document.getElementById('logHelp');
  if (!badge || !help) return;
  const toggle = (e) => { if (!isGM) return; e.stopPropagation(); help.hidden = !help.hidden; };
  badge.addEventListener('click', toggle);
  const close = document.getElementById('logHelpClose');
  if (close) close.addEventListener('click', (e) => { e.stopPropagation(); help.hidden = true; });
  help.querySelectorAll('.lh-cmds li').forEach((li) => {
    li.addEventListener('click', () => {
      const cmd = li.getAttribute('data-cmd');
      if (cmd) send(cmd);
      help.hidden = true;
    });
  });
  document.addEventListener('click', (e) => { if (!help.hidden && !wrap.contains(e.target)) help.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') help.hidden = true; });
}
function escapeRegExp(s) { return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
let toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
function renderMentions(text) {
  const esc = escapeHtml(text || '');
  return esc.replace(/@([^\s@，。、！？,.;:!?（）()\[\]"'`]+)/g, '<span class="mention">@$1</span>');
}
function appendMsg(m) {
  const d = document.createElement('div');
  d.className = 'msg';
  // 三类消息分发（顺序：scene > character > player）
  const as = (typeof m.as === 'string') ? m.as : 'player';
  if (as === 'scene') {
    d.classList.add('msg-scene');
    d.innerHTML = '<div class="scene-tag">⌘ SCENE</div><div class="t">' + renderMentions(m.text) + '</div>';
  } else if (as === 'character') {
    const charId = m.charId || '';
    const card = charId ? _charCache[charId] : null;
    const charName = card && card.name ? card.name : user;
    const charCls = card && card.cls ? card.cls : '';
    const hue = charHashHue(charId || ('fallback::' + user));
    d.classList.add('msg-char');
    d.style.setProperty('--char-hue', hue);
    const clsSpan = charCls ? '<span class="cls">[' + escapeHtml(charCls) + ']</span>' : '';
    d.innerHTML = '<span class="u">' + escapeHtml(charName) + clsSpan +
      '<span class="ch-arrow">·</span><span class="who-player">' + escapeHtml(m.user) + '</span></span>' +
      '<span class="t">' + renderMentions(m.text) + '</span>';
  } else {
    // player（默认 + 兼容历史消息）
    d.classList.add('msg-player');
    d.innerHTML = '<span class="u">' + escapeHtml(m.user) + '</span><span class="t">' + renderMentions(m.text) + '</span>';
  }
  if (user && m.text && m.user !== user && new RegExp('@' + escapeRegExp(user)).test(m.text)) {
    d.classList.add('mentioned');
    showToast('📡 ' + m.user + ' 在频道 @ 了你');
  }
  logEl.appendChild(d);
  scroll();
}
// 稳定 hash hue（角色卡 id → 0-359）
function charHashHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h * 31) + id.charCodeAt(i)) & 0xffff;
  return h % 360;
}
function whoHTML(m, suffix) {
  const tag = m.proxy ? '<span class="proxy-tag">代投</span>' : '';
  const by = m.proxy ? '（' + escapeHtml(m.proxyBy || 'GM') + ' 代）' : '';
  return tag + escapeHtml(m.user) + by + suffix;
}
function appendDice(m) {
  const d = document.createElement('div');
  let cls = 'dice', inner = '';
  if (m.sub === 'roll') {
    inner = '<div class="who">' + whoHTML(m, ' 投骰</div>') +
      '<div class="formula">[' + escapeHtml(m.formula) + ']</div>' +
      '<div class="result">' + m.total + '</div>' +
      '<div class="rolls">明细: [' + (m.rolls || []).join(', ') + ']</div>';
    if (m.adv || m.dis) {
      inner += '<div class="advtag ' + (m.adv ? 'adv' : 'dis') + '">' + (m.adv ? '优势·取高' : '劣势·取低') +
        ' ｜ 另一组 [' + (m.alt ? m.alt.rolls.join(', ') : '') + '] = ' + (m.alt ? m.alt.total : '') + '</div>';
    }
  } else if (m.sub === 'check') {
    cls += m.success ? '' : ' fail';
    const chosen = (m.chosen !== undefined ? m.chosen : m.roll);
    inner = '<div class="who">' + whoHTML(m, ' 检定 ' + escapeHtml(m.formula) + '</div>');
    if (m.adv || m.dis) inner += '<div class="rolls">[' + (m.rolls || []).join(', ') + '] 取 ' + chosen + '</div>';
    inner += '<div class="result">' + chosen + ' → ' + (m.success ? '成功' : '失败') + '</div>';
    if (m.adv || m.dis) inner += '<div class="advtag ' + (m.adv ? 'adv' : 'dis') + '">' + (m.adv ? '优势·取低' : '劣势·取高') + '</div>';
  } else if (m.sub === 'panic') {
    cls += ' panic';
    const chosen = (m.chosen !== undefined ? m.chosen : m.roll);
    inner = '<div class="who">' + whoHTML(m, ' Panic Check ' + escapeHtml(m.formula) + '</div>');
    if (m.adv || m.dis) inner += '<div class="rolls">[' + (m.rolls || []).join(', ') + '] 取 ' + chosen + '</div>';
    inner += '<div class="result">d20 = ' + chosen + '</div>' +
      '<div class="note">' + renderMentions(m.note) + '</div>';
    if (m.trauma) inner += '<div class="trauma">' + escapeHtml(m.trauma) + '</div>';
  }
  d.className = cls;
  d.innerHTML = inner;
  logEl.appendChild(d);
  scroll();
}

function handleEvent(m) {
  if (m.type === 'map') { if (window.onMapEvent) window.onMapEvent(m); return; }
  if (m.kick) {
    appendSystem(m.text);
    if (window.closeMap) closeMap();
    if (!isGM) {
      viewRoom = 'general';
      document.querySelectorAll('.room-item').forEach((el) => el.classList.toggle('active', el.dataset.id === 'general'));
      $('#roomName').textContent = '主频道';
      connectSSE();
      loadRooms();
    }
    return;
  }
  if (!m.room) m.room = 'general';
  (roomMsgs[m.room] = roomMsgs[m.room] || []).push(m);
  const show = (isGM && viewRoom === '__all__') || m.room === viewRoom;
  if (show) {
    if (m.type === 'system') appendSystem(m.text);
    else if (m.type === 'msg') appendMsg(m);
    else if (m.type === 'dice') appendDice(m);
  }
}

function renderView() {
  logEl.innerHTML = '';
  const list = roomMsgs[viewRoom] || [];
  for (const m of list) {
    if (m.type === 'system') appendSystem(m.text);
    else if (m.type === 'msg') appendMsg(m);
    else if (m.type === 'dice') appendDice(m);
  }
  $('#roomName').textContent = (viewRoom === '__all__' ? '全部频道' : (roomNames[viewRoom] || viewRoom));
}

function send(text) {
  let room = viewRoom;
  if (isGM && viewRoom === '__all__') room = 'general';
  const payload = { user, text, room, gm: gmCode };
  // 消息体附 as；character 时附 charId
  if (sendAs === 'character') {
    payload.as = 'character';
    const card = myCurrentCard();
    if (card) payload.charId = card.room + '::' + card.owner;
  } else if (sendAs === 'scene') {
    payload.as = 'scene';
  }
  fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then((r) => r.json()).then((j) => {
    if (j && j.ok === 0 && j.error === 'muted') appendSystem('⚠ 你在该频道已被 GM 静音，无法发言（仍可查看）');
  }).catch(() => {});
}
function sendJoin() {
  let room = viewRoom;
  if (isGM && viewRoom === '__all__') room = 'general';
  fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, type: 'join', room, gm: gmCode })
  }).catch(() => {});
}

function decorate(cmd) {
  const mode = $('#advMode').value;
  if (!mode) return cmd;
  if (/^!(roll|r|d\d+|check|panic)\b/.test(cmd.trim())) return cmd.trim() + ' ' + mode;
  return cmd;
}

function connectSSE() {
  if (es) es.close();
  for (const k in roomMsgs) delete roomMsgs[k];
  logEl.innerHTML = '';
  const param = isGM ? '*' : viewRoom;
  es = new EventSource('/events?room=' + enc(param) + '&user=' + enc(user) + '&gm=' + enc(gmCode));
  es.onopen = () => {
    $('#connDot').className = 'dot on';
    $('#connText').textContent = '在线';
    if (!joined) { sendJoin(); joined = true; }
  };
  es.onerror = () => {
    $('#connDot').className = 'dot off';
    $('#connText').textContent = '重连中';
  };
  es.onmessage = (ev) => { try { handleEvent(JSON.parse(ev.data)); } catch (e) {} };
}

function loadRooms() {
  fetch('/api/rooms?user=' + enc(user) + '&gm=' + enc(gmCode)).then((r) => r.json()).then((data) => {
    const wasGM = isGM;
    isGM = !!data.gm;
    if (!isGM) { const _ls = document.getElementById('logState'); if (_ls) _ls.style.display = 'none'; const _lw = document.getElementById('logWrap'); if (_lw) _lw.style.display = 'none'; }
    $('#gmBadge').classList.toggle('hidden', !isGM);
    $('#roomManageBtn').classList.toggle('hidden', !isGM);
    const list = data.rooms || [];
    roomNames = {};
    list.forEach((r) => { roomNames[r.id] = r.name; });
    renderRooms(list);
    // if we just learned we're GM, reconnect to receive all channels
    if (isGM && !wasGM) { if (viewRoom === 'general') { /* keep */ } connectSSE(); }
  }).catch(() => {});
}

function renderRooms(list) {
  const wrap = $('#roomList');
  wrap.innerHTML = '';
  if (isGM) {
    const all = mkRoomItem('__all__', '全部频道', false);
    wrap.appendChild(all);
  }
  list.forEach((r) => {
    const item = mkRoomItem(r.id, r.name, !!(isGM && r.locked));
    wrap.appendChild(item);
  });
}
function mkRoomItem(id, name, locked) {
  const el = document.createElement('div');
  el.className = 'room-item' + (id === viewRoom ? ' active' : '');
  el.dataset.id = id;
  el.innerHTML = '<span class="rn">' + escapeHtml(name) + '</span>' + (locked ? '<span class="lock">🔒</span>' : '');
  el.addEventListener('click', () => switchRoom(id));
  return el;
}
function switchRoom(id) {
  if (id === viewRoom) return;
  viewRoom = id;
  if (window.closeMap) closeMap();
  document.querySelectorAll('.room-item').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  $('#roomName').textContent = (id === '__all__' ? '全部频道' : (roomNames[id] || id));
  if (!isGM) { connectSSE(); }   // non-GM must reconnect to new room
  else { renderView(); }          // GM already has all messages cached
  if (!$('#charModal').classList.contains('hidden')) loadChars();
  bootSide();                     // 右栏：重载当前频道的地图与角色卡
  refreshSendbarMode();
}

function connect() {
  user = ($('#nameInput').value || '').trim().slice(0, 20) || ('船员' + Math.floor(Math.random() * 900 + 100));
  gmCode = ($('#gmInput').value || '').trim();
  localStorage.setItem('mothership_user', user);
  localStorage.setItem('mothership_gm', gmCode);
  $('#whoami').textContent = user;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  viewRoom = 'general';
  connectSSE();
  loadRooms();
  bootSide();                     // 右栏：甲板图 + 角色信息
  refreshSendbarMode();
}

// ---- login ----
$('#connectBtn').addEventListener('click', connect);
$('#nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
$('#gmInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

// ---- send ----
$('#sendForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#msgInput').value;
  if (!v.trim()) return;
  send(decorate(v));
  $('#msgInput').value = '';
});

// ---- quick dice ----
document.querySelectorAll('.quickbar button').forEach((b) => {
  b.addEventListener('click', () => {
    const cmd = b.dataset.cmd || '';
    if (cmd === '!check') { askCheckTarget(); return; }   // 检定：弹输入框填 target
    send(decorate(cmd));
  });
});

// 检定按钮：弹输入框让用户填目标值（不限范围）。空白/取消 = 不发。
function askCheckTarget() {
  const raw = window.prompt('检定目标值（d100 ≤ 该值 = 成功）', '55');
  if (raw == null) return;                                  // 取消
  const t = String(raw).trim();
  if (!t) return;
  if (!/^\d+$/.test(t)) { alert('目标值必须是正整数'); return; }
  send(decorate('!check ' + t));
}

// ---- log export ----
function fmtMsg(m) {
  const t = new Date(m.ts || Date.now()).toLocaleString();
  if (m.type === 'system') return '[' + t + '] ' + m.text;
  if (m.type === 'msg') {
    if (m.as === 'scene') return '[' + t + '] [SCENE] ' + m.text;
    if (m.as === 'character' && m.charId) {
      const card = _charCache[m.charId];
      const nm = card && card.name ? card.name : m.user;
      return '[' + t + '] ' + nm + '（' + m.user + '）: ' + m.text;
    }
    return '[' + t + '] ' + m.user + ': ' + m.text;
  }
  if (m.type === 'dice') {
    if (m.sub === 'roll') return '[' + t + '] ' + m.user + ' 投骰 ' + m.formula + ' = ' + m.total +
      (m.adv ? ' [优势]' : m.dis ? ' [劣势]' : '') + (m.alt ? ' (另一组 ' + m.alt.total + ')' : '');
    if (m.sub === 'check') return '[' + t + '] ' + m.user + ' 检定 ' + m.formula + ' = ' + (m.chosen !== undefined ? m.chosen : m.roll) +
      ' ' + (m.success ? '成功' : '失败') + (m.adv || m.dis ? ' [优/劣]' : '');
    if (m.sub === 'panic') return '[' + t + '] ' + m.user + ' Panic ' + m.formula + ' = ' + (m.chosen !== undefined ? m.chosen : m.roll) + ' ' + m.note;
  }
  return '';
}
function exportLog() {
  let room = viewRoom;
  if (isGM && viewRoom === '__all__') room = '*';
  fetch('/api/roomlog?room=' + enc(room) + '&user=' + enc(user) + '&gm=' + enc(gmCode))
    .then((r) => { if (!r.ok) throw new Error('denied'); return r.json(); })
    .then((data) => {
      let text = '';
      if (data.all) {
        data.rooms.forEach((r) => { text += '=== ' + r.name + ' ===\n' + (r.messages || []).map(fmtMsg).join('\n') + '\n\n'; });
      } else {
        text = '=== ' + (data.name || data.room) + ' ===\n' + (data.messages || []).map(fmtMsg).join('\n') + '\n';
      }
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'mothership-log-' + (data.all ? 'all' : (data.room || 'room')) + '.txt';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(a.href);
      appendSystem('已导出频道日志');
    })
    .catch(() => appendSystem('导出失败：无权限或网络错误'));
}
$('#exportBtn').addEventListener('click', exportLog);

// ---- settings ----
function openSettings() { $('#setName').value = user; $('#settingsModal').classList.remove('hidden'); }
function closeSettings() { $('#settingsModal').classList.add('hidden'); }
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsClose').addEventListener('click', closeSettings);
$('#settingsModal').addEventListener('click', (e) => { if (e.target === $('#settingsModal')) closeSettings(); });
$('#saveNameBtn').addEventListener('click', () => {
  const v = ($('#setName').value || '').trim().slice(0, 20);
  if (!v) { appendSystem('名字不能为空'); return; }
  user = v;
  localStorage.setItem('mothership_user', user);
  $('#whoami').textContent = user;
  $('#nameInput').value = user;
  appendSystem('已更新呼号为「' + user + '」（仅影响之后的消息）');
  closeSettings();
});
$('#clearLogBtn').addEventListener('click', () => {
  mapConfirm('确定要清除你本端显示的日志吗？\n仅影响你自己的屏幕，服务器与其他人不受影响。', '清除本端日志').then((ok) => {
    if (!ok) return;
    roomMsgs[viewRoom] = [];
    logEl.innerHTML = '';
    appendSystem('已清除本端日志显示');
    closeSettings();
  });
});
$('#exportLogBtn2').addEventListener('click', () => { closeSettings(); exportLog(); });

// ---- 终端读数（顶栏）：时钟 + 真实状态（延迟/运行时长/在线/今日消息） ----
function pad2(n) { return String(n).padStart(2, '0'); }
function tickClock() {
  const el = document.getElementById('roClock'); if (!el) return;
  const d = new Date();
  el.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
tickClock(); setInterval(tickClock, 1000);

function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d > 0 ? d + 'd ' : '') + pad2(h) + ':' + pad2(m);
}
function roSet(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function pollStatus() {
  const t0 = performance.now();
  fetch('/api/status').then((r) => r.json()).then((j) => {
    if (!j || j.ok !== 1) return;
    roSet('roLat', Math.max(1, Math.round(performance.now() - t0)) + 'ms');
    roSet('roUp', fmtUptime(j.uptime || 0));
    roSet('roCrew', String(j.online || 0));
    roSet('roMsg', String(j.today || 0));
  }).catch(() => roSet('roLat', '--'));
}
pollStatus(); setInterval(pollStatus, 5000);


// ---- help ----
$('#helpBtn').addEventListener('click', () => {
  appendSystem('指令 → !roll 2d10+5 [adv|dis] · !d100 · !d20 · !check 55 [adv|dis] · !stress [n] · !panic [adv|dis] · !help ｜ 切换房间看左侧，GM 可见全部');
  scroll();
});

// ---- char sheet ----
let myChars = {};
function openChars() { $('#charModal').classList.remove('hidden'); loadChars(); }
function closeChars() { $('#charModal').classList.add('hidden'); }

function loadChars() {
  // GM 全视(__all__) 拉全部；否则按当前房间
  const q = (viewRoom === '__all__') ? ('room=*&gm=' + encodeURIComponent(gmCode)) : ('room=' + encodeURIComponent(viewRoom));
  fetch('/api/characters?' + q).then((r) => r.json()).then((list) => {
    const wrap = $('#charList');
    wrap.innerHTML = '';
    const scope = (viewRoom === '__all__') ? '全部频道' : (roomNames[viewRoom] || viewRoom);
    $('#charScope').textContent = scope;
    list.forEach((c) => {
      // 同步缓存：charId = room + '::' + owner，供 appendMsg 渲染历史角色消息
      if (c.room && c.owner) _charCache[c.room + '::' + c.owner] = c;
      const el = document.createElement('div');
      el.className = 'char-chip';
      const rtag = (viewRoom === '__all__' && c.room && roomNames[c.room]) ? (' · ' + escapeHtml(roomNames[c.room])) : '';
      const inv = (c.items && c.items.length) ? ' · 🎒' + c.items.length : '';
      el.innerHTML = '<div class="nm">' + escapeHtml(c.name || c.owner) + '</div><div class="cl">' +
        escapeHtml(c.cls || '') + ' · ' + escapeHtml(c.owner) + rtag + inv + '</div>';
      el.addEventListener('click', () => fillForm(c));
      wrap.appendChild(el);
    });
    const mine = list.find((c) => c.owner === user);
    if (mine) fillForm(mine);
    refreshSendbarMode();
  }).catch(() => {});
}

// ---- 发言身份切换条：玩家 / 角色 / 场景 ----
function myCurrentCard() {
  // 当前房间（GM __all__ 视为 general）；优先使用 _charCache 中的最新卡
  const r = (viewRoom === '__all__') ? 'general' : viewRoom;
  const key = r + '::' + user;
  if (_charCache[key]) return _charCache[key];
  return null;
}
function refreshSendbarMode() {
  const seg = $('#sbmSeg'); if (!seg) return;
  const whoP = $('#sbmWhoPlayer');
  const whoC = $('#sbmWhoChar');
  if (whoP) whoP.textContent = user ? ('「' + user + '」') : '';
  const card = myCurrentCard();
  if (whoC) whoC.textContent = card && card.name ? ('「' + card.name + '」') : '';
  // 角色按钮在无卡时禁用
  const charBtn = seg.querySelector('[data-as="character"]');
  if (charBtn) charBtn.classList.toggle('disabled', !card);
  // 若当前 sendAs=character 但卡没了，回退到 player
  if (sendAs === 'character' && !card) sendAs = 'player';
  seg.querySelectorAll('button').forEach((b) => {
    const isActive = b.dataset.as === sendAs;
    b.classList.toggle('active', isActive);
    b.classList.toggle('scene-active', b.dataset.as === 'scene' && sendAs === 'scene');
  });
  // 输入框 placeholder 跟随
  const input = $('#msgInput');
  if (input) {
    if (sendAs === 'scene') input.placeholder = '⌘ 场景 / 环境描写（不带署名）…';
    else if (sendAs === 'character') input.placeholder = card && card.name ? '以「' + card.name + '」发言…' : '以角色身份发言（请先在右侧「编辑」建立角色卡）…';
    else input.placeholder = '输入消息，或 !roll 2d10+5 投骰…';
  }
}
document.querySelectorAll('#sbmSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    const as = b.dataset.as;
    if (!as) return;
    if (as === 'character' && !myCurrentCard()) {
      appendSystem('当前频道还没有你的角色卡，请先在右侧「编辑」建立');
      openChars();
      return;
    }
    sendAs = as;
    refreshSendbarMode();
    appendSystem('✦ 发言身份 → ' + (as === 'character' ? '角色：' + ((myCurrentCard() && myCurrentCard().name) || '?') : as === 'scene' ? '场景 / 旁白' : '玩家：' + user));
  });
});
function fillForm(c) {
  $('#cOwner').value = c.owner || user;
  $('#cName').value = c.name || '';
  $('#cCls').value = c.cls || '';
  $('#cStr').value = c.str || ''; $('#cSpd').value = c.spd || '';
  $('#cInt').value = c.int || ''; $('#cCom').value = c.com || '';
  $('#cSan').value = c.san || ''; $('#cFea').value = c.fea || '';
  $('#cBod').value = c.bod || ''; $('#cArm').value = c.arm || '';
  $('#cStress').value = c.stress || ''; $('#cWounds').value = c.wounds || '';
  $('#cNotes').value = c.notes || '';
  $('#cItems').value = (c.items && c.items.length) ? c.items.join('\n') : '';
  $('#cImage').value = '';
  $('#charDelete').classList.toggle('hidden', c.owner !== user);
}
function readImage(file) {
  return new Promise((resolve) => {
    if (!file) return resolve('');
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => resolve('');
    fr.readAsDataURL(file);
  });
}
$('#charForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const file = $('#cImage').files[0];
  readImage(file).then((img) => {
    const saveRoom = (viewRoom === '__all__') ? 'general' : viewRoom;
    const payload = {
      owner: user, room: saveRoom, name: $('#cName').value, cls: $('#cCls').value,
      str: $('#cStr').value, spd: $('#cSpd').value, int: $('#cInt').value, com: $('#cCom').value,
      san: $('#cSan').value, fea: $('#cFea').value, bod: $('#cBod').value, arm: $('#cArm').value,
      stress: $('#cStress').value, wounds: $('#cWounds').value, notes: $('#cNotes').value,
      items: $('#cItems').value.split('\n').map((s) => s.trim()).filter(Boolean), image: img
    };
    fetch('/api/characters', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }).then(() => { appendSystem(user + ' 的角色卡已归档至「' + (roomNames[saveRoom] || saveRoom) + '」'); loadChars(); loadSideChar(); });
  });
});
$('#charDelete').addEventListener('click', () => {
  if (!confirm('删除你在本频道的角色卡？')) return;
  const delRoom = (viewRoom === '__all__') ? 'general' : viewRoom;
  fetch('/api/characters', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: user, room: delRoom })
  }).then(() => { loadChars(); fillForm({ owner: user }); loadSideChar(); });
});
$('#charBtn').addEventListener('click', openChars);
$('#charClose').addEventListener('click', closeChars);

// ---- 右侧栏：角色信息（自己的卡，只读摘要） ----
const STAT_KEYS = [['STR', 'str'], ['SPD', 'spd'], ['INT', 'int'], ['COM', 'com'], ['SAN', 'san'], ['FEA', 'fea'], ['BOD', 'bod'], ['ARM', 'arm']];
function loadSideChar() {
  const wrap = $('#sideChar'); if (!wrap) return;
  const q = (viewRoom === '__all__') ? ('room=*&gm=' + encodeURIComponent(gmCode)) : ('room=' + encodeURIComponent(viewRoom));
  fetch('/api/characters?' + q).then((r) => r.json()).then((list) => {
    list.forEach((c) => { if (c.room && c.owner) _charCache[c.room + '::' + c.owner] = c; });
    renderSideChar((list || []).find((c) => c.owner === user));
    refreshSendbarMode();
  }).catch(() => {});
}
function renderSideChar(c) {
  const wrap = $('#sideChar'); if (!wrap) return;
  if (!c) { wrap.innerHTML = '<div class="side-empty">尚未建立角色卡<br><span style="font-size:11px">点右上角「编辑」创建</span></div>'; return; }
  const stats = STAT_KEYS.map(function (p) {
    const v = (c[p[1]] != null && c[p[1]] !== '') ? escapeHtml(String(c[p[1]])) : '–';
    return '<div class="sc-stat"><span class="k">' + p[0] + '</span><span class="v">' + v + '</span></div>';
  }).join('');
  const stress = Number(c.stress) || 0, wounds = Number(c.wounds) || 0;
  const items = (c.items && c.items.length)
    ? ('<ul class="sc-items">' + c.items.map((s) => '<li>' + escapeHtml(s) + '</li>').join('') + '</ul>')
    : '<div class="side-empty" style="padding:6px">无装备记录</div>';
  const notes = c.notes ? ('<div class="sc-notes">' + escapeHtml(c.notes) + '</div>') : '<div class="side-empty" style="padding:6px">无备注</div>';
  wrap.innerHTML =
    '<div class="sc-head"><span class="sc-name">' + escapeHtml(c.name || c.owner) + '</span>' +
    '<span class="sc-cls">' + escapeHtml(c.cls || '未设定职业') + '</span></div>' +
    '<div class="sc-stats">' + stats + '</div>' +
    '<div class="sc-vitals">' +
      '<div class="sc-vital' + (stress >= 5 ? ' warn' : '') + '"><span class="k">STRESS</span><span class="v">' + stress + '</span></div>' +
      '<div class="sc-vital' + (wounds > 0 ? ' warn' : '') + '"><span class="k">WOUNDS</span><span class="v">' + wounds + '</span></div>' +
    '</div>' +
    '<div class="sc-sec-t">装备 / 物品</div>' + items +
    '<div class="sc-sec-t">备注</div>' + notes;
}
// 侧栏内容刷新（地图 + 角色），登录后与切换频道时调用
function bootSide() {
  if (window.reloadMap) reloadMap();
  loadSideChar();
  applyMapStates();
}
$('#sideCharEdit').addEventListener('click', openChars);

// ---- 雷达开关（GM 专用） ----
function setRadar(on) {
  if (!isGM) return;
  const ops = [{ t: 'radar.set', v: !!on }];
  fetch('/api/map/op', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: viewRoom, user, gm: gmCode, ops })
  }).then((r) => r.json()).then((j) => {
    if (j && j.ok) {
      // 本端立即应用，不等服务端广播回弹
      if (MS.data) MS.data.radar = !!on;
      applyMapStates();
    }
  }).catch(() => {});
}
$('#radarOnBtn').addEventListener('click', () => setRadar(true));
$('#radarOffBtn').addEventListener('click', () => setRadar(false));

// ---- 入口可见开关（GM 专用，玩家端小地图强制显示入口房间） ----
function setEntryVisible(on) {
  if (!isGM) return;
  const ops = [{ t: 'entry.toggle', v: !!on }];
  fetch('/api/map/op', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: viewRoom, user, gm: gmCode, ops })
  }).then((r) => r.json()).then((j) => {
    if (j && j.ok) {
      if (MS.data) MS.data.entryVisible = !!on;
      applyMapStates();
    }
  }).catch(() => {});
}
const _entryBtn = document.getElementById('entryToggleBtn');
if (_entryBtn) _entryBtn.addEventListener('click', () => {
  if (!MS.data) return;
  setEntryVisible(!MS.data.entryVisible);
});

function applyMapStates() {
  const wrap = document.getElementById('miniMapWrap');
  const state = document.getElementById('radarState');
  const on = MS.data ? (MS.data.radar !== false) : true;
  if (wrap) wrap.classList.toggle('radaroff', !on);
  if (state) { state.textContent = on ? 'ON' : 'OFF'; state.style.color = on ? 'var(--green)' : 'var(--amber)'; }
  // 雷达按钮高亮
  const onBtn = document.getElementById('radarOnBtn'), offBtn = document.getElementById('radarOffBtn');
  if (onBtn) onBtn.classList.toggle('active', on);
  if (offBtn) offBtn.classList.toggle('active', !on);
  // 入口按钮高亮
  const entryBtn = document.getElementById('entryToggleBtn');
  if (entryBtn) {
    const ev = !!(MS.data && MS.data.entryVisible);
    entryBtn.classList.toggle('active', ev);
    entryBtn.innerHTML = ev ? 'ENTRY <i class="eb-dot"></i>' : 'ENTRY';
  }
  if (typeof renderMini === 'function') renderMini();
}

// ---- room management (GM) ----
function openRoomAdmin() { $('#roomModal').classList.remove('hidden'); loadRoomAdmin(); }
function closeRoomAdmin() { $('#roomModal').classList.add('hidden'); }
function loadRoomAdmin() {
  fetch('/api/rooms?user=' + enc(user) + '&gm=' + enc(gmCode)).then((r) => r.json()).then((data) => {
    const wrap = $('#roomAdminList');
    wrap.innerHTML = '';
    (data.rooms || []).forEach((r) => {
      const el = document.createElement('div');
      el.className = 'room-admin-item';
      const allowTxt = (r.allowed && r.allowed.length) ? r.allowed.join('、') : '所有人';
      const muteTxt = (r.muted && r.muted.length) ? ' · 已静音: ' + r.muted.join('、') : '';
      el.innerHTML = '<div class="rai-main"><b>' + escapeHtml(r.name) + '</b> <span class="dim">[' + allowTxt + ']</span><span class="mute-tag">' + escapeHtml(muteTxt) + '</span></div>';
      const actions = document.createElement('div');
      actions.className = 'rai-actions';
      const edit = document.createElement('button'); edit.textContent = '编辑'; edit.className = 'mini';
      edit.addEventListener('click', () => {
        $('#rEditId').value = r.id; $('#rName').value = r.name;
        $('#rAllowed').value = (r.allowed || []).join(', ');
        $('#roomFormTitle').textContent = '编辑频道：' + r.name;
        $('#roomCancel').classList.remove('hidden');
      });
      const mute = document.createElement('button'); mute.textContent = '静音'; mute.className = 'mini';
      mute.addEventListener('click', () => {
        const u = (prompt('静音/解除——输入用户呼号（留空取消）：') || '').trim();
        if (!u) return;
        const on = !((r.muted || []).includes(u));
        fetch('/api/mute', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gm: gmCode, room: r.id, user: u, mute: on }) })
          .then((rr) => rr.json()).then((j) => { if (j.ok) loadRoomAdmin(); });
      });
      const del = document.createElement('button'); del.textContent = '删除'; del.className = 'mini danger';
      del.addEventListener('click', () => {
        if (r.id === 'general') { alert('主频道不可删除'); return; }
        if (!confirm('删除频道「' + r.name + '」？该频道消息一并清除。')) return;
        fetch('/api/rooms/' + r.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gm: gmCode }) })
          .then(() => { loadRoomAdmin(); loadRooms(); });
      });
      actions.appendChild(edit); actions.appendChild(mute); actions.appendChild(del);
      el.appendChild(actions);
      wrap.appendChild(el);
    });
  }).catch(() => {});
}
$('#roomForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#rEditId').value;
  const name = $('#rName').value.trim();
  const allowed = $('#rAllowed').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!name) { alert('请填写频道名'); return; }
  const body = JSON.stringify({ gm: gmCode, name, allowed });
  const done = () => { $('#rEditId').value = ''; $('#rName').value = ''; $('#rAllowed').value = ''; $('#roomFormTitle').textContent = '新建频道'; $('#roomCancel').classList.add('hidden'); loadRoomAdmin(); loadRooms(); };
  if (id) {
    fetch('/api/rooms/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
      .then(() => done());
  } else {
    fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then(() => done());
  }
});
$('#roomCancel').addEventListener('click', () => {
  $('#rEditId').value = ''; $('#rName').value = ''; $('#rAllowed').value = '';
  $('#roomFormTitle').textContent = '新建频道'; $('#roomCancel').classList.add('hidden');
});
$('#roomManageBtn').addEventListener('click', openRoomAdmin);
$('#roomClose').addEventListener('click', closeRoomAdmin);
setupLogHelp();

// restore + 自动登录（记住登录状态）
$('#nameInput').value = localStorage.getItem('mothership_user') || '';
$('#gmInput').value = localStorage.getItem('mothership_gm') || '';
if (($('#nameInput').value || '').trim()) connect();

// ---- logout ----
$('#logoutBtn').addEventListener('click', () => {
  if (es) { es.close(); es = null; }
  localStorage.removeItem('mothership_user');
  localStorage.removeItem('mothership_gm');
  user = ''; gmCode = ''; isGM = false;
  $('#nameInput').value = ''; $('#gmInput').value = '';
  $('#whoami').textContent = '';
  $('#gmBadge').classList.add('hidden');
  $('#connDot').className = 'dot off'; $('#connText').textContent = '离线';
  $('#log').innerHTML = '';
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#nameInput').focus();
});
