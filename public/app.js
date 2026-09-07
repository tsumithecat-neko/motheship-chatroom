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
  d.innerHTML = '<span class="u">' + escapeHtml(m.user) + '</span><span class="t">' + renderMentions(m.text) + '</span>';
  if (user && m.text && m.user !== user && new RegExp('@' + escapeRegExp(user)).test(m.text)) {
    d.classList.add('mentioned');
    showToast('📡 ' + m.user + ' 在频道 @ 了你');
  }
  logEl.appendChild(d);
  scroll();
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
  if (m.kick) {
    appendSystem(m.text);
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
  fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, text, room, gm: gmCode })
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
  document.querySelectorAll('.room-item').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  $('#roomName').textContent = (id === '__all__' ? '全部频道' : (roomNames[id] || id));
  if (!isGM) { connectSSE(); }   // non-GM must reconnect to new room
  else { renderView(); }          // GM already has all messages cached
  if (!$('#charModal').classList.contains('hidden')) loadChars();
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
  b.addEventListener('click', () => send(decorate(b.dataset.cmd)));
});

// ---- log export ----
function fmtMsg(m) {
  const t = new Date(m.ts || Date.now()).toLocaleString();
  if (m.type === 'system') return '[' + t + '] ' + m.text;
  if (m.type === 'msg') return '[' + t + '] ' + m.user + ': ' + m.text;
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
  }).catch(() => {});
}
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
    }).then(() => { appendSystem(user + ' 的角色卡已归档至「' + (roomNames[saveRoom] || saveRoom) + '」'); loadChars(); });
  });
});
$('#charDelete').addEventListener('click', () => {
  if (!confirm('删除你在本频道的角色卡？')) return;
  const delRoom = (viewRoom === '__all__') ? 'general' : viewRoom;
  fetch('/api/characters', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: user, room: delRoom })
  }).then(() => { loadChars(); fillForm({ owner: user }); });
});
$('#charBtn').addEventListener('click', openChars);
$('#charClose').addEventListener('click', closeChars);

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

// restore
$('#nameInput').value = localStorage.getItem('mothership_user') || '';
$('#gmInput').value = localStorage.getItem('mothership_gm') || '';
