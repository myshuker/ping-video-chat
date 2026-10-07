/* ============================================================
   Ping — client app: auth, contacts, groups, WebRTC calling
   ============================================================ */
const $ = s => document.querySelector(s);

const state = {
  token: localStorage.getItem('ping_token'),
  me: null,
  socket: null,
  localStream: null,
  callId: null,
  callTitle: '',
  callType: null,        // 'user' | 'group'
  mods: [],              // user ids allowed to mute/remove people in this call
  names: new Map(),      // userId -> display name (people in the call)
  peers: new Map(),      // userId -> RTCPeerConnection
  pendingInvite: null,
  micOn: true,
  camOn: true,
  facing: 'user',        // which camera is in use: 'user' (front) or 'environment' (back)
  camTrack: null,        // the real camera track (the outgoing track is a filtered copy while a filter is on)
  filter: 'none',        // active camera filter id
  filterEngine: null,
  filterReq: 0,
  swapped: false,         // true when my video is the big one and the other person floats small
  media: new Map(),      // userId -> { mic, cam } for everyone in the call
  forcedBy: null,        // name of the person who muted me (until I unmute)
  callChat: null,        // { type, id }: the chat that belongs to this call
  callUnread: 0,
  game: null,            // shared game session in this call { game, seed, startedBy, byName, scores }
  gameRun: null,         // my running game
  gameScores: [],
  groups: [],            // my groups (with memberIds)
  groupModal: null,      // { groupId|null, slots }
  chat: null,            // active chat: { type: 'user'|'group', id, name, sub }
  chats: new Map(),      // 'user:ID' | 'group:ID' -> messages[]
  unread: new Map(),     // chat key -> unread count
};
const chatKey = (type, id) => type + ':' + id;
const MAX_FILE = 10 * 1024 * 1024; // 10 MB

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    // Add a TURN server here for production (symmetric NAT):
    // { urls: 'turn:your-turn-server.com:3478', username: 'user', credential: 'pass' }
  ],
};

/* ---------------- API helper ---------------- */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const esc = s => String(s).replace(/[&<>"']/g,
  m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

/* ---------------- Views ---------------- */
function show(view) {
  for (const v of ['#auth-view', '#app-view', '#call-view']) $(v).hidden = true;
  $(view).hidden = false;
}

async function enterApp() {
  state.me = await api('/me');
  $('#me-name').textContent = state.me.displayName;
  $('#me-identifier').textContent = fmtId(state.me.identifier);
  connectSocket();
  await Promise.all([refreshContacts(), refreshGroups()]);
  show('#app-view');
}

function logout() {
  state.token = null;
  localStorage.removeItem('ping_token');
  state.socket?.disconnect();
  state.socket = null;
  state.chats.clear(); state.unread.clear(); closeChat();
  show('#auth-view');
  document.querySelector('.tab[data-tab="login"]').click();     // always come back to the Log in tab
}

/* ---------------- Email-or-phone field with a country-code picker ---------------- */
const CC = window.PingCountries;
const fmtId = id => (/^\+\d{8,15}$/.test(id || '') ? CC.pretty(id) : id);      // +4512345678 -> +45 12345678

// Type an email and nothing changes. Type a number and a country picker appears next to it.
// A number typed with + (or 00) and its country code is understood as it is.
function makeIdField(input) {
  const wrap = document.createElement('div');
  wrap.className = 'id-wrap';
  const row = document.createElement('div');
  row.className = 'id-row';
  const picker = document.createElement('label');
  picker.className = 'cc-picker'; picker.hidden = true; picker.title = 'Country code';
  picker.innerHTML = '<span class="cc-view"></span><select class="cc-select" aria-label="Country code"></select>';
  const view = picker.querySelector('.cc-view'), sel = picker.querySelector('select');
  const dialText = d => (d.length === 4 && d[0] === '1' ? '1 ' + d.slice(1) : d);
  sel.innerHTML = CC.list.map(c => `<option value="${c.iso}">${CC.flag(c.iso)} ${esc(c.name)} (+${dialText(c.dial)})</option>`).join('');
  const hint = document.createElement('div');
  hint.className = 'id-hint'; hint.hidden = true;
  input.replaceWith(wrap);
  row.append(picker, input);
  wrap.append(row, hint);

  let iso = CC.guess();
  let typedDial = null;                                // set while the person types "+45…" themselves
  const isPhoneText = v => !!v && !v.includes('@') && /^[+\d(]/.test(v);
  const intl = v => v.startsWith('+') || v.startsWith('00');

  function result() {
    const v = input.value.trim();
    if (!isPhoneText(v)) return { kind: 'email', id: v };
    const r = CC.toE164(v, iso);
    return r.ok ? { kind: 'phone', id: r.e164 } : { kind: 'phone', id: null, error: r.error };
  }

  function refresh() {
    const v = input.value.trim();
    const phone = isPhoneText(v);
    picker.hidden = !phone;
    if (!phone) { hint.hidden = true; typedDial = null; return; }
    typedDial = null;
    if (intl(v)) {
      const m = CC.matchDial(v.replace(/\D/g, '').slice(v.startsWith('00') ? 2 : 0));
      if (m) { iso = m.iso; typedDial = m.dial; }
    }
    sel.value = iso;
    view.textContent = `${CC.flag(iso)} +${CC.byIso[iso].dial}`;
    const r = result();
    hint.hidden = false;
    hint.classList.toggle('bad', r.error === 'This number is too long');
    hint.textContent = r.id ? '📞 ' + CC.pretty(r.id) : (r.error || '');
  }

  sel.addEventListener('change', () => {
    iso = sel.value;
    try { localStorage.setItem('ping_cc', iso); } catch { /* private mode */ }
    if (typedDial) {                                   // they picked a country by hand: keep only the local number
      const d = input.value.replace(/\D/g, '');
      input.value = d.slice(input.value.trim().startsWith('00') ? 2 : 0).slice(typedDial.length);
      typedDial = null;
    }
    refresh();
    input.focus();
  });
  ['input', 'change', 'blur'].forEach(ev => input.addEventListener(ev, refresh));
  refresh();

  return {
    get: result,
    // returns a message to show if the number is not complete, otherwise ''
    check() {
      const r = result();
      if (r.kind === 'phone') return r.id ? '' : (r.error || 'Enter your phone number');
      return r.id ? '' : 'Enter your email or phone number';
    },
    clear() { input.value = ''; refresh(); },
  };
}

const idFields = {
  login: makeIdField($('#login-identifier')),
  reg: makeIdField($('#reg-identifier')),
  contact: makeIdField($('#add-contact-input')),
};

/* ---------------- Auth ---------------- */
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
  $('#login-form').hidden = tab.dataset.tab !== 'login';
  $('#register-form').hidden = tab.dataset.tab !== 'register';
  $('#auth-error').textContent = '';
}));

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const bad = idFields.login.check();
  if (bad) { $('#auth-error').textContent = bad; return; }
  try {
    const data = await api('/login', {
      method: 'POST',
      body: { identifier: idFields.login.get().id, password: $('#login-password').value },
    });
    state.token = data.token;
    localStorage.setItem('ping_token', data.token);
    await enterApp();
  } catch (err) { $('#auth-error').textContent = err.message; }
});

$('#register-form').addEventListener('submit', async e => {
  e.preventDefault();
  const bad = idFields.reg.check();
  if (bad) { $('#auth-error').textContent = bad; return; }
  try {
    const data = await api('/register', {
      method: 'POST',
      body: {
        displayName: $('#reg-name').value.trim(),
        identifier: idFields.reg.get().id,
        password: $('#reg-password').value,
      },
    });
    state.token = data.token;
    localStorage.setItem('ping_token', data.token);
    await enterApp();
  } catch (err) { $('#auth-error').textContent = err.message; }
});

$('#logout-btn').addEventListener('click', logout);

/* ---------------- Contacts ---------------- */
async function refreshContacts() {
  const contacts = await api('/contacts');
  const ul = $('#contact-list');
  ul.innerHTML = '';
  if (!contacts.length) ul.innerHTML = '<li class="empty-item muted">No contacts yet</li>';
  for (const c of contacts) {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <div class="item-main" data-chat-type="user" data-chat-id="${c.id}" data-chat-name="${esc(c.displayName)}" data-chat-sub="${esc(fmtId(c.identifier))}">
        <div class="avatar">${esc(c.displayName[0] || '?')}</div>
        <div class="item-text">
          <div class="item-name">${esc(c.displayName)}</div>
          <div class="item-sub muted">${esc(fmtId(c.identifier))}</div>
        </div>
        <span class="badge" data-badge="user:${c.id}" hidden></span>
      </div>
      <button class="btn primary small" data-call-user="${c.id}" data-name="${esc(c.displayName)}">Video call</button>`;
    ul.appendChild(li);
  }
  renderBadges();
}

$('#add-contact-form').addEventListener('submit', async e => {
  e.preventDefault();
  const bad = idFields.contact.check();
  if (bad) return alert(bad);
  try {
    await api('/contacts', { method: 'POST', body: { identifier: idFields.contact.get().id } });
    idFields.contact.clear();
    await refreshContacts();
  } catch (err) { alert(err.message); }
});

/* ---------------- Groups ---------------- */
async function refreshGroups() {
  const groups = await api('/groups');
  state.groups = groups;
  const ul = $('#group-list');
  ul.innerHTML = '';
  if (!groups.length) ul.innerHTML = '<li class="empty-item muted">No groups yet</li>';
  for (const g of groups) {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <div class="item-main" data-chat-type="group" data-chat-id="${g.id}" data-chat-name="${esc(g.name)}" data-chat-sub="${esc(g.members.map(m => m.displayName).join(', '))}">
        <div class="avatar group">👥</div>
        <div class="item-text">
          <div class="item-name">${esc(g.name)}</div>
          <div class="item-sub muted">${g.members.map(m => esc(m.displayName)).join(', ')}</div>
        </div>
        <span class="badge" data-badge="group:${g.id}" hidden></span>
      </div>
      <div class="item-actions">
        ${g.ownerId === state.me.id ? `<button class="btn ghost small" data-add-members="${g.id}" title="Add people" aria-label="Add people">＋</button>` : ''}
        <button class="btn primary small" data-call-group="${g.id}" data-name="${esc(g.name)}">Group call</button>
      </div>`;
    ul.appendChild(li);
  }
  renderBadges();
}

const MAX_GROUP = 10; // members including you

// group = undefined → create a new group; group = {…} → add people to it
async function openGroupModal(group) {
  const contacts = await api('/contacts');
  const existing = new Set(group ? group.memberIds : []);
  const candidates = contacts.filter(c => !existing.has(c.id));
  const slots = MAX_GROUP - (group ? group.memberIds.length : 1);
  state.groupModal = { groupId: group ? group.id : null, slots };

  $('#group-title').textContent = group ? `Add people to ${group.name}` : 'Create group';
  $('#group-name').hidden = !!group;
  $('#group-create').textContent = group ? 'Add' : 'Create';
  const box = $('#group-members');
  box.innerHTML = '';
  if (!candidates.length) {
    box.innerHTML = `<p class="muted">${contacts.length ? 'All your contacts are already in this group.' : 'Add some contacts first.'}</p>`;
  }
  for (const c of candidates) {
    const label = document.createElement('label');
    label.className = 'check';
    label.innerHTML = `<input type="checkbox" value="${c.id}" /> ${esc(c.displayName)} <span class="muted">(${esc(fmtId(c.identifier))})</span>`;
    box.appendChild(label);
  }
  updateGroupCounter();
  $('#group-modal').hidden = false;
}

function updateGroupCounter() {
  const boxes = [...document.querySelectorAll('#group-members input')];
  const n = boxes.filter(b => b.checked).length;
  const slots = state.groupModal.slots;
  boxes.forEach(b => { b.disabled = !b.checked && n >= slots; });   // stop at the limit
  $('#group-counter').textContent = slots <= 0
    ? `This group is full (max ${MAX_GROUP} members)`
    : `Selected ${n} of ${slots} possible · max ${MAX_GROUP} members including you`;
}

$('#new-group-btn').addEventListener('click', () => openGroupModal().catch(err => alert(err.message)));
$('#group-members').addEventListener('change', updateGroupCounter);
$('#group-cancel').addEventListener('click', () => { $('#group-modal').hidden = true; });
$('#group-create').addEventListener('click', async () => {
  const memberIds = [...document.querySelectorAll('#group-members input:checked')].map(i => i.value);
  const { groupId } = state.groupModal;
  try {
    if (groupId) {
      await api(`/groups/${groupId}/members`, { method: 'POST', body: { memberIds } });
    } else {
      await api('/groups', { method: 'POST', body: { name: $('#group-name').value.trim(), memberIds } });
    }
    $('#group-modal').hidden = true;
    $('#group-name').value = '';
    await refreshGroups();
  } catch (err) { alert(err.message); }
});

document.body.addEventListener('click', e => {
  const btn = e.target.closest('[data-add-members]');
  if (!btn) return;
  const group = state.groups.find(g => g.id === btn.dataset.addMembers);
  if (group) openGroupModal(group).catch(err => alert(err.message));
});

/* ============================================================
   Text chat (1:1 and groups)
   ============================================================ */
function renderBadges() {
  document.querySelectorAll('[data-badge]').forEach(el => {
    const n = state.unread.get(el.dataset.badge) || 0;
    el.hidden = n === 0;
    el.textContent = n > 99 ? '99+' : n;
  });
}

const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function renderMessages(box, msgs, isGroup) {
  box.innerHTML = '';
  if (!msgs.length) {
    box.innerHTML = '<div class="chat-empty">No messages yet. Say hi 👋</div>';
    return;
  }
  box.dataset.stick = '1';
  for (const m of msgs) box.appendChild(messageEl(m, isGroup, box));
  box.scrollTop = box.scrollHeight;
}

function renderChat() {
  if (!state.chat) return;
  renderMessages($('#chat-messages'), state.chats.get(chatKey(state.chat.type, state.chat.id)) || [], state.chat.type === 'group');
}

// add one new message to a chat box (keeps the view pinned to the bottom if you were there)
function appendMessage(box, m, isGroup) {
  if (box.querySelector('.chat-empty')) box.innerHTML = '';
  if (box.querySelector(`[data-id="${m.id}"]`)) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.appendChild(messageEl(m, isGroup, box));
  box.dataset.stick = nearBottom || m.from === state.me.id ? '1' : '0';
  if (box.dataset.stick === '1') box.scrollTop = box.scrollHeight;
}

// fetch saved messages and merge them with any live ones that arrived meanwhile
async function loadHistory(type, id) {
  const key = chatKey(type, id);
  if (!state.chats.has(key)) state.chats.set(key, []);
  const history = await api(`/messages?type=${type}&id=${encodeURIComponent(id)}`);
  const live = state.chats.get(key) || [];
  const byId = new Map([...history, ...live].map(m => [m.id, m]));
  state.chats.set(key, [...byId.values()].sort((a, b) => a.ts - b.ts));
}

const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

function messageEl(m, isGroup, box) {
  const mine = m.from === state.me.id;
  const div = document.createElement('div');
  div.className = 'msg' + (mine ? ' mine' : '') + (m.file ? ' has-file' : '') + (m.location ? ' has-loc' : '');
  div.dataset.id = m.id;
  let body = '';
  if (m.file) {
    const url = `/files/${m.file.id}/${encodeURIComponent(m.file.name)}`;
    body = m.file.image
      ? `<a href="${url}" target="_blank" rel="noopener"><img class="msg-img" loading="lazy" src="${url}" alt="${esc(m.file.name)}" /></a>`
      : `<a class="msg-file" href="${url}?download=1" download="${esc(m.file.name)}">
           <span class="file-ico">📄</span>
           <span class="file-info"><span class="file-name">${esc(m.file.name)}</span><span class="file-size">${fmtSize(m.file.size)} · tap to download</span></span>
         </a>`;
  } else if (m.location) {
    const lat = Number(m.location.lat), lng = Number(m.location.lng);
    const acc = m.location.acc ? ` · ±${m.location.acc} m` : '';
    body = `<a class="msg-loc" href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener">
        <span class="loc-pin">📍</span>
        <span class="loc-info"><span class="loc-title">${mine ? 'My location' : 'Location'}</span>
        <span class="loc-coords">${lat.toFixed(5)}, ${lng.toFixed(5)}${acc}</span>
        <span class="loc-open">Tap to open in Maps</span></span></a>`;
  } else {
    body = `<span class="msg-text">${esc(m.text)}</span>`;
  }
  div.innerHTML =
    (isGroup && !mine ? `<span class="who">${esc(m.fromName)}</span>` : '') +
    body + `<time>${fmtTime(m.ts)}</time>`;
  // pictures load after the message is added: keep the chat scrolled to the bottom if it was
  div.querySelector('img')?.addEventListener('load', () => {
    if (box.dataset.stick === '1') box.scrollTop = box.scrollHeight;
  });
  return div;
}

async function openChat(type, id, name, sub) {
  state.chat = { type, id, name, sub };
  const key = chatKey(type, id);
  state.unread.delete(key);
  renderBadges();
  $('#chat-name').textContent = name;
  $('#chat-sub').textContent = sub || '';
  $('#welcome').hidden = true;
  $('#chat-panel').hidden = false;
  $('#app-view').classList.add('chat-open');
  state.chats.set(key, []);              // live messages arriving during the fetch land here
  renderChat();
  try {
    await loadHistory(type, id);
  } catch (err) {
    $('#chat-messages').innerHTML = `<div class="chat-empty">${esc(err.message)}</div>`;
    return;
  }
  if (state.chat && chatKey(state.chat.type, state.chat.id) === key) renderChat();
}

function closeChat() {
  state.chat = null;
  $('#chat-panel').hidden = true;
  $('#welcome').hidden = false;
  $('#app-view').classList.remove('chat-open');
}

function onChatMessage(m) {
  const key = chatKey(m.type, m.convId);
  const list = state.chats.get(key);
  if (list && !list.some(x => x.id === m.id)) list.push(m);
  const isGroup = m.type === 'group';
  const mine = m.from === state.me.id;

  const mainOpen = state.chat && chatKey(state.chat.type, state.chat.id) === key;
  if (mainOpen) appendMessage($('#chat-messages'), m, isGroup);

  const inCallChat = state.callId && state.callChat && chatKey(state.callChat.type, state.callChat.id) === key;
  const ccOpen = inCallChat && !$('#call-chat').hidden;
  if (ccOpen) appendMessage($('#cc-messages'), m, isGroup);

  const seen = (mainOpen && !state.callId) || ccOpen;
  if (seen || mine) return;
  state.unread.set(key, (state.unread.get(key) || 0) + 1);
  renderBadges();
  if (inCallChat) {                                   // a message for this call while the chat is closed
    state.callUnread++;
    updateCallBadge();
    toast(`💬 ${m.fromName}: ${m.file ? '📎 ' + m.file.name : m.location ? '📍 Location' : m.text.slice(0, 60)}`);
  }
}

$('#chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || !state.chat) return;
  input.value = '';
  input.focus();                         // keep the keyboard open on phones
  state.socket.emit('chat:send', { type: state.chat.type, targetId: state.chat.id, text }, res => {
    if (res?.error) { input.value = text; alert(res.error); }
  });
});

/* ---- send pictures / files ---- */
async function sendFile(file, chat = state.chat) {
  if (file.size > MAX_FILE) return alert(`"${file.name}" is too large (max 10 MB)`);
  const res = await fetch(`/api/chat/file?type=${chat.type}&id=${encodeURIComponent(chat.id)}&name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
}

$('#chat-attach').addEventListener('click', () => $('#chat-file').click());
$('#chat-file').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length || !state.chat) return;
  const btn = $('#chat-attach');
  btn.disabled = true; btn.textContent = '⏳';
  try {
    for (const f of files) await sendFile(f, state.chat);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false; btn.textContent = '📎';
  }
});

$('#chat-messages').addEventListener('scroll', e => {
  const b = e.currentTarget;
  b.dataset.stick = b.scrollHeight - b.scrollTop - b.clientHeight < 120 ? '1' : '0';
});
$('#chat-back').addEventListener('click', closeChat);
$('#chat-call').addEventListener('click', () => {
  if (state.chat) startCall(state.chat.type, state.chat.id, state.chat.name);
});

/* Open a chat by tapping a contact / group */
document.body.addEventListener('click', e => {
  const el = e.target.closest('[data-chat-type]');
  if (el) openChat(el.dataset.chatType, el.dataset.chatId, el.dataset.chatName, el.dataset.chatSub);
});

/* Delegated call buttons */
document.body.addEventListener('click', e => {
  const userBtn = e.target.closest('[data-call-user]');
  const groupBtn = e.target.closest('[data-call-group]');
  if (userBtn) startCall('user', userBtn.dataset.callUser, userBtn.dataset.name);
  if (groupBtn) startCall('group', groupBtn.dataset.callGroup, groupBtn.dataset.name);
});

/* ============================================================
   Ringing: ringtone + vibration + flashing title for incoming calls
   ============================================================ */
const ring = {
  ctx: null, timer: null, vibTimer: null, titleTimer: null, stopTimer: null, baseTitle: document.title,
  // browsers only allow sound after the person has touched the page once, so we prepare on the first tap
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    } catch { /* no audio available */ }
  },
  burst() {                                           // "brrring - brrring"
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    const t0 = c.currentTime;
    const gain = c.createGain();
    gain.connect(c.destination);
    gain.gain.setValueAtTime(0.0001, t0);
    for (const [start, dur] of [[0, 0.42], [0.55, 0.42]]) {
      for (const f of [440, 480]) {
        const o = c.createOscillator();
        o.type = 'sine'; o.frequency.value = f;
        o.connect(gain);
        o.start(t0 + start); o.stop(t0 + start + dur + 0.02);
      }
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.linearRampToValueAtTime(0.3, t0 + start + 0.03);
      gain.gain.setValueAtTime(0.3, t0 + start + dur - 0.05);
      gain.gain.linearRampToValueAtTime(0.0001, t0 + start + dur);
    }
  },
  buzz() { try { navigator.vibrate && navigator.vibrate([500, 250, 500]); } catch { /* not supported */ } },
  start(label, onTimeout) {
    this.stop();
    this.unlock();
    this.burst(); this.buzz();
    this.timer = setInterval(() => { this.unlock(); this.burst(); }, 2600);
    this.vibTimer = setInterval(() => this.buzz(), 2600);
    let on = false;
    this.titleTimer = setInterval(() => { on = !on; document.title = on ? `📞 ${label}` : this.baseTitle; }, 900);
    this.stopTimer = setTimeout(() => { this.stop(); onTimeout && onTimeout(); }, 45000);   // nobody answered
  },
  stop() {
    clearInterval(this.timer); clearInterval(this.vibTimer); clearInterval(this.titleTimer); clearTimeout(this.stopTimer);
    this.timer = this.vibTimer = this.titleTimer = this.stopTimer = null;
    document.title = this.baseTitle;
    try { navigator.vibrate && navigator.vibrate(0); } catch { /* ignore */ }
  },
};
['pointerdown', 'keydown', 'touchend'].forEach(ev => document.addEventListener(ev, () => ring.unlock(), { passive: true }));

/* ============================================================
   Socket.IO signaling + WebRTC
   ============================================================ */
/* ---- push notifications (ring the phone even when the app is closed) ---- */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    const { publicKey } = await (await fetch('/api/vapid-public-key')).json();
    if (!publicKey) return;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    state.socket?.emit('push:subscribe', { subscription: sub.toJSON() });
  } catch (e) { console.warn('push init failed', e); }
}

/* ---- keep the app portrait even when the phone is rotated ----
   1) try the real orientation lock (works on Android, often needs fullscreen)
   2) if the browser refuses (iOS Safari), counter-rotate the whole app with CSS */
async function lockOrientation() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('portrait');
    }
  } catch (e) { /* lock unsupported here — the CSS fallback below takes over */ }
}
function enforcePortrait() {
  const landscape = window.innerWidth > window.innerHeight;
  const body = document.body;
  if (!landscape) {
    body.classList.remove('fp-cw', 'fp-ccw');
    return;
  }
  // only phones/tablets can physically rotate — never touch desktop layouts
  const canRotate = matchMedia('(pointer: coarse)').matches &&
    Math.max(screen.width, screen.height) <= 1200;
  if (!canRotate) return;
  let angle = 0;
  if (screen.orientation && typeof screen.orientation.angle === 'number') {
    angle = screen.orientation.angle;
  }
  if (angle === 270) {
    body.classList.remove('fp-ccw');
    body.classList.add('fp-cw');
  } else {
    body.classList.remove('fp-cw');
    body.classList.add('fp-ccw');
  }
}
function isRotated() {
  return document.body.classList.contains('fp-cw') || document.body.classList.contains('fp-ccw');
}
// logical (portrait) viewport size while the CSS rotation is active
function viewW() { return isRotated() ? window.innerHeight : window.innerWidth; }
function viewH() { return isRotated() ? window.innerWidth : window.innerHeight; }
// screen point → logical point inside the rotated body
function screenToLocal(sx, sy) {
  if (document.body.classList.contains('fp-cw')) {
    return { x: sy, y: window.innerWidth - sx };
  }
  if (document.body.classList.contains('fp-ccw')) {
    return { x: window.innerHeight - sy, y: sx };
  }
  return { x: sx, y: sy };
}
// screen rect → screen position of the element's logical top-left corner
function localOriginScreen(r) {
  if (document.body.classList.contains('fp-cw')) {
    return { x: r.left + r.width, y: r.top };
  }
  if (document.body.classList.contains('fp-ccw')) {
    return { x: r.left, y: r.top + r.height };
  }
  return { x: r.left, y: r.top };
}
// some browsers only allow locking after the user touches the page
['pointerdown', 'touchend'].forEach(ev =>
  document.addEventListener(ev, () => lockOrientation(), { once: true, passive: true }),
);
window.addEventListener('resize', enforcePortrait);
window.addEventListener('orientationchange', () => setTimeout(enforcePortrait, 50));
document.addEventListener('fullscreenchange', enforcePortrait);
enforcePortrait();

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;
  socket.on('connect', () => initPush());

  socket.on('call:incoming', invite => {
    state.pendingInvite = invite;
    $('#incoming-title').textContent =
      invite.callType === 'group' ? `Group call: ${invite.title}` : 'Incoming video call';
    $('#incoming-from').textContent =
      invite.callType === 'group' ? `Started by ${invite.from.displayName}` : `from ${invite.from.displayName}`;
    $('#incoming-modal').hidden = false;
    ring.start(invite.callType === 'group' ? `Group call: ${invite.title}` : `${invite.from.displayName} is calling…`, () => {
      // nobody answered in time → treat it as a missed call
      if (state.pendingInvite === invite) {
        socket.emit('call:decline', { callId: invite.callId });
        state.pendingInvite = null;
        $('#incoming-modal').hidden = true;
        toast(`Missed call from ${invite.from.displayName}`);
      }
    });
  });

  // the caller hung up before anybody answered
  socket.on('call:cancelled', ({ callId } = {}) => {
    if (state.pendingInvite?.callId !== callId) return;
    ring.stop();
    state.pendingInvite = null;
    $('#incoming-modal').hidden = true;
    toast('The call was cancelled');
  });

  // who is muted / has the camera off (icons on every tile)
  socket.on('call:media', ({ userId, mic, cam } = {}) => {
    state.media.set(userId, { mic, cam });
    updateTileFlags(userId);
  });

  socket.on('call:peer-joined', ({ userId, profile }) => {
    if (profile) { state.names.set(userId, profile.displayName); updateTileName(userId); }
    // We were here first → we initiate the WebRTC offer to the newcomer
    callPeer(userId);
  });

  socket.on('chat:message', onChatMessage);
  socket.on('contacts:changed', () => refreshContacts().catch(() => {}));
  socket.on('groups:changed', () => refreshGroups().catch(() => {}));

  socket.on('call:peer-left', ({ userId }) => dropPeer(userId));
  socket.on('call:decline', ({ name } = {}) => {
    // 1:1 call nobody joined → it's over; in a group call just let people know
    if (state.callType === 'user' && state.peers.size === 0) endCall('Call declined');
    else toast(`${name || 'Someone'} declined the call`);
  });

  socket.on('game:started', g => {
    state.game = g; state.gameScores = g.scores || [];
    renderBoard();
    if (g.startedBy === state.me.id) return playGame();
    stopGame(); hideGameLayer();
    showGameBanner(`${g.byName} started ${PingGames.META[g.game].emoji} ${PingGames.META[g.game].title}`);
    toast(`${g.byName} started ${PingGames.META[g.game].title}. Tap Play to join!`);
  });
  socket.on('game:scores', list => { state.gameScores = list; renderBoard(); });
  socket.on('game:ended', ({ by } = {}) => {
    stopGame(); hideGameLayer(); $('#game-banner').hidden = true;
    state.game = null; state.gameScores = [];
    toast(`${by || 'Someone'} ended the game`);
  });

  socket.on('call:kicked', ({ by } = {}) => endCall(`You were removed from the call${by ? ' by ' + by : ''}`));
  socket.on('call:force-mute', ({ by } = {}) => {
    setMic(false, by || 'The host');
    toast(`${by || 'The host'} muted you. Tap the mic to speak again.`);
  });

  socket.on('rtc:offer', async ({ from, sdp }) => {
    try {
      const pc = ensurePeer(from);
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('rtc:answer', { callId: state.callId, to: from, sdp: pc.localDescription });
    } catch (e) { console.error('[rtc] answering offer failed:', e); }
  });

  socket.on('rtc:answer', async ({ from, sdp }) => {
    try {
      const pc = state.peers.get(from);
      if (pc) await pc.setRemoteDescription(sdp);
    } catch (e) { console.error('[rtc] applying answer failed:', e); }
  });

  socket.on('rtc:ice', ({ from, candidate }) => {
    const pc = state.peers.get(from);
    if (pc && candidate) pc.addIceCandidate(candidate).catch(() => {});
  });
}

/* ---------------- WebRTC helpers ---------------- */
async function getLocalStream() {
  if (!state.localStream) {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: true,
    });
    state.camTrack = state.localStream.getVideoTracks()[0] || null;
    if (!state.camTrack) {                    // never join a video call with audio only
      state.localStream.getTracks().forEach(t => t.stop());
      state.localStream = null;
      throw new Error('camera produced no video track');
    }
  }
  return state.localStream;
}

/* ---- iPhone (Safari) ↔ Android (Chrome) interop helpers ---- */
// Prefer hardware H.264 for the outgoing video: when Safari and Chrome negotiate
// some other codec the far side can decode the audio fine but show a black picture.
function preferVideoCodec(pc) {
  try {
    const caps = (typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities)
      ? RTCRtpReceiver.getCapabilities('video') : null;
    if (!caps || !caps.codecs || !caps.codecs.length) return;
    const tx = pc.getTransceivers().find(t => t.sender && t.sender.track && t.sender.track.kind === 'video');
    if (!tx || typeof tx.setCodecPreferences !== 'function') return;
    const rank = c => ((c.mimeType || '').toLowerCase() === 'video/h264' ? 1 : 0);
    tx.setCodecPreferences([...caps.codecs].sort((a, b) => rank(b) - rank(a)));
  } catch (e) { console.warn('[rtc] setCodecPreferences skipped:', e); }
}

function tryPlay(v) {
  if (!v) return;
  let p;
  try { p = v.play(); } catch { return; }
  if (p && p.then) p.catch(() => {
    // autoplay was refused (no user gesture yet) — retry when media loads or on first tap
    const again = () => {
      v.removeEventListener('loadedmetadata', again);
      document.removeEventListener('pointerdown', again);
      v.play().catch(() => {});
    };
    v.addEventListener('loadedmetadata', again);
    document.addEventListener('pointerdown', again, { once: true });
  });
}

// Health badge on a remote tile so a black picture is explainable:
// ⏳ = track exists but no frames are arriving; 📷 = camera track gone. Hidden when healthy.
function watchVideo(userId, v) {
  if (!v) return;
  clearTimeout(v._h1); clearTimeout(v._h2);
  const check = () => {
    const tile = document.getElementById('tile-' + userId);
    const flag = tile && tile.querySelector('.flag.vstat');
    if (!flag || !v.isConnected) return;
    const t = v.srcObject && v.srcObject.getVideoTracks ? v.srcObject.getVideoTracks()[0] : null;
    let why = '';
    if (!t) why = 'no video track from this device';
    else if (t.readyState !== 'live') why = 'camera track was closed';
    else if (t.muted) why = 'waiting for the video signal…';
    else if (!v.videoWidth) why = 'waiting for video frames…';
    flag.hidden = !why;
    flag.textContent = why ? '⏳' : '';
    flag.title = why;
    if (why) v._h1 = setTimeout(check, 5000);   // keep watching while unhealthy
  };
  v._h1 = setTimeout(check, 3000);
  v._h2 = setTimeout(check, 10000);
}

function ensurePeer(userId) {
  if (state.peers.has(userId)) return state.peers.get(userId);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.localStream.getTracks().forEach(t => pc.addTrack(t, state.localStream));
  preferVideoCodec(pc);

  pc.onicecandidate = e => {
    if (e.candidate) {
      state.socket.emit('rtc:ice', { callId: state.callId, to: userId, candidate: e.candidate });
    }
  };
  pc.ontrack = e => {
    attachRemoteVideo(userId, e.streams[0]);
    const v = () => document.getElementById('tile-' + userId)?.querySelector('video');
    const refresh = () => { const el = v(); if (el) { watchVideo(userId, el); } };
    e.track.addEventListener?.('mute', refresh);
    e.track.addEventListener?.('unmute', () => { const el = v(); if (el) { tryPlay(el); watchVideo(userId, el); } });
    e.track.addEventListener?.('ended', refresh);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
    if (pc.connectionState === 'connected') $('#call-status').textContent = '';
  };
  state.peers.set(userId, pc);
  return pc;
}

async function callPeer(userId) {
  try {
    const pc = ensurePeer(userId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.socket.emit('rtc:offer', { callId: state.callId, to: userId, sdp: pc.localDescription });
  } catch (e) { console.error('[rtc] creating offer failed:', e); }
}

function dropPeer(userId) {
  state.peers.get(userId)?.close();
  state.peers.delete(userId);
  document.getElementById('tile-' + userId)?.remove();
  state.media.delete(userId);
}

const iAmMod = () => state.mods.includes(state.me.id);

function updateTileName(userId) {
  const tile = document.getElementById('tile-' + userId);
  if (!tile) return;
  const video = tile.querySelector('video');
  tile.querySelector('.tile-name').textContent = (video.muted ? '🔕 ' : '') + (state.names.get(userId) || 'Participant');
  tile.querySelector('[data-act="local-mute"]').textContent = video.muted ? '🔊 Unmute for me' : '🔇 Mute for me';
}

function attachRemoteVideo(userId, stream) {
  let tile = document.getElementById('tile-' + userId);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = 'tile-' + userId;
    tile.dataset.user = userId;
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <div class="tile-flags"><span class="flag mic" title="Muted" hidden>🔇</span><span class="flag cam" title="Camera off" hidden>📷</span><span class="flag vstat" title="" hidden>⏳</span></div>
      <div class="tile-name"></div>
      <button type="button" class="tile-menu-btn" aria-label="Options" data-act="menu">⋮</button>
      <div class="tile-menu" hidden>
        <button type="button" data-act="local-mute">🔇 Mute for me</button>
        ${iAmMod() ? `<button type="button" data-act="force-mute">🎙️ Mute for everyone</button>
        <button type="button" class="danger" data-act="kick">⛔ Remove from call</button>` : ''}
      </div>`;
    const v = tile.querySelector('video');
    v.autoplay = true; v.playsInline = true;
    $('#video-grid').appendChild(tile);
    if (state.swapped) toggleSwap();          // a new person joined: go back to their video being big
  }
  const v = tile.querySelector('video');
  v.srcObject = stream;
  tryPlay(v);
  watchVideo(userId, v);
  updateTileName(userId);
  updateTileFlags(userId);
}

// show the red muted / camera-off icons on a person's tile
function updateTileFlags(userId) {
  const tile = document.getElementById('tile-' + userId);
  if (!tile) return;
  const m = state.media.get(userId) || { mic: true, cam: true };
  tile.querySelector('.flag.mic').hidden = m.mic !== false;
  tile.querySelector('.flag.cam').hidden = m.cam !== false;
  tile.classList.toggle('cam-off', m.cam === false);
}

/* tile menu: mute for me / mute for everyone / remove */
$('#video-grid').addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  const closeMenus = () => document.querySelectorAll('.tile-menu').forEach(m => { m.hidden = true; });
  if (!btn) return closeMenus();
  const tile = btn.closest('.tile');
  const userId = tile.dataset.user;
  const name = state.names.get(userId) || 'this person';
  if (btn.dataset.act === 'menu') {
    const menu = tile.querySelector('.tile-menu');
    const wasHidden = menu.hidden;
    closeMenus();
    menu.hidden = !wasHidden;
    if (!menu.hidden) {
      const r = btn.getBoundingClientRect();
      const a = screenToLocal(r.left, r.top);
      const b = screenToLocal(r.right, r.bottom);
      const locRight = Math.max(a.x, b.x), locBottom = Math.max(a.y, b.y);
      menu.style.top = Math.min(locBottom + 6, viewH() - 170) + 'px';
      menu.style.left = Math.max(8, Math.min(locRight - 230, viewW() - 238)) + 'px';
    }
    return;
  }
  closeMenus();
  if (btn.dataset.act === 'local-mute') {
    const v = tile.querySelector('video');
    v.muted = !v.muted;
    updateTileName(userId);
  } else if (btn.dataset.act === 'force-mute') {
    state.socket.emit('call:mute-user', { callId: state.callId, userId }, res => {
      toast(res?.error || `${name} was muted`);
    });
  } else if (btn.dataset.act === 'kick') {
    if (!confirm(`Remove ${name} from the call?`)) return;
    state.socket.emit('call:kick', { callId: state.callId, userId }, res => {
      if (res?.error) toast(res.error);
    });
  }
});
document.addEventListener('click', e => {
  if (!e.target.closest('.tile')) document.querySelectorAll('.tile-menu').forEach(m => { m.hidden = true; });
});

function addLocalVideo() {
  $('#vid-local').srcObject = state.localStream;
  $('#local-tile').classList.toggle('mirror', state.facing === 'user');   // selfie view is mirrored
  updateLocalFlags();
  applyLocalPos();
  detectCameras();
}

/* ---- microphone / camera state (also tells everyone else, so they can show the icons) ---- */
function sendMedia() {
  if (state.callId && state.socket) state.socket.emit('call:media', { callId: state.callId, mic: state.micOn, cam: state.camOn });
}

function updateLocalFlags() {
  $('#local-tile .flag.mic').hidden = state.micOn !== false;
  $('#local-tile .flag.cam').hidden = state.camOn !== false;
}

function setMic(on, forcedBy = null) {
  state.micOn = on;
  state.forcedBy = on ? null : forcedBy;
  state.localStream?.getAudioTracks().forEach(t => { t.enabled = on; });
  const btn = $('#mute-btn');
  btn.classList.toggle('off', !on);
  btn.textContent = on ? '🎙️' : '🔇';
  btn.title = on ? 'Mute microphone' : 'Unmute microphone';
  const lm = $('#local-mic');
  lm.textContent = on ? '🎙️' : '🔇';
  lm.classList.toggle('off', !on);
  updateLocalFlags();
  // when somebody else muted me, say so clearly and offer a one-tap way to speak again
  $('#mute-banner').hidden = !state.forcedBy;
  if (state.forcedBy) $('#mute-banner-text').textContent = `🔇 ${state.forcedBy} muted you`;
  sendMedia();
}

function setCam(on) {
  state.camOn = on;
  [...(state.localStream?.getVideoTracks() || []), state.camTrack].forEach(t => { if (t) t.enabled = on; });
  $('#video-btn').classList.toggle('off', !on);
  $('#local-tile').classList.toggle('cam-off', !on);
  updateLocalFlags();
  sendMedia();
}

/* ---- flip between the front and back camera ---- */
async function detectCameras() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    $('#local-flip').hidden = devs.filter(d => d.kind === 'videoinput').length < 2;
  } catch { $('#local-flip').hidden = true; }
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (state.callId) detectCameras(); });

const VIDEO_SIZE = { width: { ideal: 640 }, height: { ideal: 480 } };

async function openCamera(facing, avoidDeviceId) {
  try {                                               // phones: ask for the other lens by name
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing }, ...VIDEO_SIZE } });
    const id = stream.getVideoTracks()[0].getSettings().deviceId;
    if (!avoidDeviceId || id !== avoidDeviceId) return stream;
    stream.getTracks().forEach(t => t.stop());
  } catch { /* fall through to picking another camera by id */ }
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const i = cams.findIndex(c => c.deviceId === avoidDeviceId);
  const other = cams[(i + 1) % cams.length];
  if (!other) throw new Error('No other camera');
  return navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: other.deviceId }, ...VIDEO_SIZE } });
}

// put a video track into the outgoing stream and hand it to everybody already in the call
async function setOutgoingVideo(track) {
  const cur = state.localStream.getVideoTracks()[0];
  if (cur === track) return;
  if (cur) state.localStream.removeTrack(cur);
  state.localStream.addTrack(track);
  for (const pc of state.peers.values()) {
    const sender = pc.getSenders().find(x => x.track && x.track.kind === 'video');
    if (sender) await sender.replaceTrack(track);
  }
  $('#vid-local').srcObject = state.localStream;
}

async function swapVideoTrack(stream) {
  const track = stream.getVideoTracks()[0];
  track.enabled = state.camOn;
  state.camTrack = track;
  if (state.filter !== 'none' && state.filterEngine) state.filterEngine.setSource(track);   // the filtered track keeps flowing
  else await setOutgoingVideo(track);
  return track;
}

async function flipCamera() {
  if (!state.localStream) return;
  const btn = $('#local-flip');
  btn.disabled = true;
  const old = state.camTrack;
  const oldId = old?.getSettings().deviceId;
  const next = state.facing === 'user' ? 'environment' : 'user';
  old?.stop();                                        // many phones can't open both cameras at once
  try {
    const stream = await openCamera(next, oldId);
    const track = await swapVideoTrack(stream);
    const fm = track.getSettings().facingMode;
    state.facing = fm ? (fm === 'environment' ? 'environment' : 'user') : next;
    $('#local-tile').classList.toggle('mirror', state.facing === 'user');
  } catch {
    toast('Could not switch the camera');
    try { await swapVideoTrack(await navigator.mediaDevices.getUserMedia({ video: { facingMode: state.facing, ...VIDEO_SIZE } })); }
    catch { /* camera is gone */ }
  } finally {
    btn.disabled = false;
  }
}

/* ---- drag my own picture anywhere on the screen ---- */
const LOCAL_POS_KEY = 'ping_self_view_pos';
let localPos = null;                                  // { x, y } as 0..1 fractions of the free space
try { localPos = JSON.parse(localStorage.getItem(LOCAL_POS_KEY)); } catch { /* none saved */ }

function placeLocal(left, top) {                     // left/top are logical (portrait) coords
  const t = $('#local-tile');
  const maxL = Math.max(4, viewW() - t.offsetWidth - 4);
  const maxT = Math.max(4, viewH() - t.offsetHeight - 4);
  t.style.left = Math.min(Math.max(4, left), maxL) + 'px';
  t.style.top = Math.min(Math.max(4, top), maxT) + 'px';
  t.style.right = 'auto'; t.style.bottom = 'auto';
}
function applyLocalPos() {
  const t = $('#local-tile');
  if (!localPos) { t.style.left = t.style.top = t.style.right = t.style.bottom = ''; return; }
  placeLocal(localPos.x * (viewW() - t.offsetWidth), localPos.y * (viewH() - t.offsetHeight));
}
window.addEventListener('resize', () => { if (state.callId) (state.swapped ? layoutSwapped() : applyLocalPos()); });

/* ---- tap the small video to swap it with the big one ---- */
function applySwap(swapped) {
  if (state.swapped === swapped) return;      // already in this mode
  state.swapped = swapped;
  const remote = $('#video-grid .tile');
  if (remote) remote.classList.toggle('swapped-small', state.swapped);
  $('#call-view').classList.toggle('swapped', state.swapped);
  const t = $('#local-tile');
  t.title = state.swapped ? 'Tap to swap back' : 'Drag me anywhere';
  if (state.swapped) {
    layoutSwapped();
  } else {
    t.style.left = t.style.top = t.style.right = t.style.bottom = t.style.width = t.style.height = '';
    applyLocalPos();
  }
}
function toggleSwap() {
  if (!$('#video-grid .tile')) return;         // nobody to swap with
  applySwap(!state.swapped);
}
function layoutSwapped() {
  if (!state.swapped) return;
  const grid = $('#video-grid').getBoundingClientRect();
  const t = $('#local-tile');
  const p1 = screenToLocal(grid.left, grid.top);
  const p2 = screenToLocal(grid.right, grid.bottom);
  t.style.position = 'fixed';
  t.style.left = Math.min(p1.x, p2.x) + 'px';
  t.style.top = Math.min(p1.y, p2.y) + 'px';
  t.style.width = Math.abs(p2.x - p1.x) + 'px';
  t.style.height = Math.abs(p2.y - p1.y) + 'px';
  t.style.right = 'auto';
  t.style.bottom = 'auto';
}

(() => {
  const t = $('#local-tile');
  let drag = null,
    dragMoved = false,
    suppressClick = false;
  t.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;           // the mic / flip buttons are not part of the handle
    if (state.swapped) return;                          // the big view is not draggable
    const r = t.getBoundingClientRect();
    const o = localOriginScreen(r);                     // logical top-left as seen on screen (handles rotation)
    drag = { id: e.pointerId, dx: e.clientX - o.x, dy: e.clientY - o.y, startX: e.clientX, startY: e.clientY };
    dragMoved = false;
    t.setPointerCapture(e.pointerId);
    t.classList.add('dragging');
  });
  t.addEventListener('pointermove', e => {
    if (drag && e.pointerId === drag.id) {
      const p = screenToLocal(e.clientX - drag.dx, e.clientY - drag.dy);
      placeLocal(p.x, p.y);
      // only a real drag (more than a tap's jitter) should swallow the click
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 8) dragMoved = true;
    }
  });
  const stop = e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    t.classList.remove('dragging');
    if (dragMoved) { suppressClick = true; setTimeout(() => (suppressClick = false), 80); }
    const o = localOriginScreen(t.getBoundingClientRect());
    const p = screenToLocal(o.x, o.y);
    const freeW = viewW() - t.offsetWidth, freeH = viewH() - t.offsetHeight;
    localPos = { x: freeW > 0 ? p.x / freeW : 0, y: freeH > 0 ? p.y / freeH : 0 };
    try { localStorage.setItem(LOCAL_POS_KEY, JSON.stringify(localPos)); } catch { /* private mode */ }
  };
  t.addEventListener('pointerup', stop);
  t.addEventListener('pointercancel', stop);
  // tap the small video to swap it with the big one
  t.addEventListener('click', e => {
    if (e.target.closest('button') || suppressClick) return;
    toggleSwap();
  });
})();

$('#local-flip').addEventListener('click', flipCamera);
$('#local-mic').addEventListener('click', () => setMic(!state.micOn));
$('#mute-banner-btn').addEventListener('click', () => setMic(true));

/* ---------------- Call lifecycle ---------------- */
async function startCall(callType, targetId, title) {
  try {
    await getLocalStream();
  } catch {
    return alert('Camera/microphone access is required for video calls. (On non-localhost deployments the page must be served over HTTPS.)');
  }
  state.callTitle = title;
  state.socket.emit('call:start', { callType, targetId }, res => {
    if (res.error) return alert(res.error);
    state.callId = res.callId;
    state.callType = callType;
    state.mods = res.moderators || [];
    state.callChat = res.chat || null;
    openCallUI(title);
    $('#call-status').textContent = callType === 'group' ? 'Ringing group members…' : 'Ringing…';
  });
}

async function acceptCall() {
  ring.stop();
  const invite = state.pendingInvite;
  state.pendingInvite = null;
  $('#incoming-modal').hidden = true;
  if (!invite) return;
  try {
    await getLocalStream();
  } catch {
    state.socket.emit('call:decline', { callId: invite.callId });
    return alert('Camera/microphone access is required to accept calls.');
  }
  state.callId = invite.callId;
  state.callTitle = invite.title;
  state.callType = invite.callType;
  state.socket.emit('call:accept', { callId: invite.callId }, res => {
    if (res.error) { state.callId = null; return alert(res.error); }
    state.mods = res.moderators || [];
    state.callChat = res.chat || null;
    state.media = new Map(Object.entries(res.media || {}));
    for (const [id, p] of Object.entries(res.profiles || {})) if (p) state.names.set(id, p.displayName);
    if (res.game) {
      state.game = res.game; state.gameScores = res.game.scores || [];
      renderBoard();
      showGameBanner(`${res.game.byName} is playing ${PingGames.META[res.game.game].emoji} ${PingGames.META[res.game.game].title}`);
    }
    openCallUI(invite.title);
    // existing participants will send us offers via 'call:peer-joined'
  });
}

function declineCall() {
  ring.stop();
  if (state.pendingInvite) {
    state.socket.emit('call:decline', { callId: state.pendingInvite.callId });
    state.pendingInvite = null;
  }
  $('#incoming-modal').hidden = true;
}

function openCallUI(title) {
  state.facing = 'user';
  state.callUnread = 0; updateCallBadge();
  setMic(true); setCam(true);
  $('#call-title').textContent = title;
  $('#video-grid').innerHTML = '';
  state.swapped = false;
  $('#call-view').classList.remove('swapped');
  const lt = $('#local-tile');
  lt.style.left = lt.style.top = lt.style.right = lt.style.bottom = lt.style.width = lt.style.height = '';
  addLocalVideo();
  show('#call-view');
  lockOrientation();
  enforcePortrait();
}

function endCall(reason) {
  ring.stop();
  closeCallChat();
  state.callChat = null; state.callUnread = 0; updateCallBadge();
  state.media.clear(); state.forcedBy = null;
  $('#mute-banner').hidden = true;
  stopGame(); hideGameLayer(); $('#game-banner').hidden = true; $('#game-modal').hidden = true;
  state.game = null; state.gameScores = [];
  if (state.callId) state.socket.emit('call:leave', { callId: state.callId });
  for (const userId of [...state.peers.keys()]) dropPeer(userId);
  closeFilterTray();
  state.filterEngine?.destroy(); state.filterEngine = null; state.filter = 'none';
  state.filterReq++;
  $('#filter-btn').classList.remove('on');
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }
  state.camTrack?.stop(); state.camTrack = null;       // the real camera (not part of the stream while a filter is on)
  state.callId = null;
  state.callType = null;
  state.mods = [];
  state.names.clear();
  state.pendingInvite = null;
  $('#incoming-modal').hidden = true;
  state.swapped = false;
  $('#call-view').classList.remove('swapped');
  const lt = $('#local-tile');
  lt.style.left = lt.style.top = lt.style.right = lt.style.bottom = lt.style.width = lt.style.height = '';
  if (state.chat) renderChat();                     // show anything that was said during the call
  if (reason) alert(reason);
  show('#app-view');
}

/* ---------------- Call controls ---------------- */
$('#accept-btn').addEventListener('click', acceptCall);
$('#decline-btn').addEventListener('click', declineCall);
$('#leave-btn').addEventListener('click', () => endCall());

$('#mute-btn').addEventListener('click', () => setMic(!state.micOn));
$('#video-btn').addEventListener('click', () => setCam(!state.camOn));

/* ---------------- Share my location ---------------- */
function sendLocation(chat, btn, report) {
  if (!chat) return;
  if (!navigator.geolocation) return report('Your browser cannot share a location.');
  if (!confirm('Send your current location in this chat?')) return;
  btn.disabled = true; btn.textContent = '⏳';
  const done = () => { btn.disabled = false; btn.textContent = '📍'; };
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
    state.socket.emit('chat:send', { type: chat.type, targetId: chat.id, location: { lat, lng, acc } }, res => {
      done();
      if (res?.error) report(res.error);
    });
  }, err => {
    done();
    report(err.code === 1 ? 'Location is blocked. Allow location for this site in your browser settings, then try again.'
         : err.code === 3 ? 'Finding your location took too long. Try again outdoors or with GPS on.'
         : 'Your location is not available right now.');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}
$('#chat-loc').addEventListener('click', e => sendLocation(state.chat, e.currentTarget, msg => alert(msg)));
$('#cc-loc').addEventListener('click', e => sendLocation(state.callChat, e.currentTarget, msg => toast(msg)));

/* ---------------- Camera filters ---------------- */
const PF = window.PingFilters;

function buildFilterTray() {
  const chip = f => `<button type="button" class="chip" data-filter="${f.id}" aria-label="${f.name}"><span class="chip-ico">${f.icon}</span><span class="chip-name">${f.name}</span></button>`;
  $('#ft-simple').innerHTML = PF.SIMPLE.map(chip).join('');
  $('#ft-fancy').innerHTML = PF.FANCY.map(chip).join('');
  markFilter(state.filter);
}
function markFilter(id) {
  document.querySelectorAll('#filter-tray .chip').forEach(c => c.classList.toggle('active', c.dataset.filter === id));
  $('#filter-btn').classList.toggle('on', id !== 'none');
}
const ftStatus = (text, bad) => { const e = $('#ft-status'); e.textContent = text || ''; e.classList.toggle('bad', !!bad); };

function openFilterTray() {
  buildFilterTray();
  $('#filter-tray').hidden = false;
  const cv = $('#call-view');                         // lift my own picture above the tray so I can see the filter on myself
  cv.style.setProperty('--tray-h', $('#filter-tray').offsetHeight + 'px');
  cv.classList.add('filters-open');
}
function closeFilterTray() {
  $('#filter-tray').hidden = true; ftStatus('');
  $('#call-view').classList.remove('filters-open');
}

async function stopFilters() {
  state.filterReq++;
  state.filterEngine?.stop();
  state.filter = 'none';
  if (state.localStream && state.camTrack) await setOutgoingVideo(state.camTrack);   // back to the plain camera
  markFilter('none');
}

async function chooseFilter(id) {
  if (!PF.get(id)) return;
  if (!state.camTrack || state.camTrack.readyState === 'ended') return toast('The camera is not available');
  if (id === 'none') { ftStatus(''); return stopFilters(); }
  const req = ++state.filterReq;                      // if you tap another chip while this one is loading, the newest wins
  const def = PF.get(id);
  if (!state.filterEngine) state.filterEngine = new PF.Engine();
  const eng = state.filterEngine;
  if (def.face) {
    ftStatus('Loading face tracking… (first time only)');
    try { await eng.loadFaceTracking(); }
    catch (err) {
      if (req === state.filterReq) ftStatus('Could not load face tracking. Check your connection and try again.', true);
      return;
    }
    if (req !== state.filterReq) return;
    ftStatus('');
  } else ftStatus('');
  eng.setSource(state.camTrack);
  eng.setFilter(id);
  eng.start();
  await setOutgoingVideo(eng.track);                  // everybody in the call now receives the filtered picture
  state.filter = id;
  markFilter(id);
}

$('#filter-btn').addEventListener('click', () => ($('#filter-tray').hidden ? openFilterTray() : closeFilterTray()));
$('#ft-close').addEventListener('click', closeFilterTray);
$('#filter-tray').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (b) chooseFilter(b.dataset.filter);
});

/* ---------------- Chat during the call ---------------- */
function updateCallBadge() {
  const b = $('#cc-badge');
  b.hidden = !state.callUnread;
  b.textContent = state.callUnread > 99 ? '99+' : state.callUnread;
}

async function openCallChat() {
  const c = state.callChat;
  if (!c) return toast('Chat is not available for this call');
  const key = chatKey(c.type, c.id);
  const isGroup = c.type === 'group';
  state.callUnread = 0; updateCallBadge();
  state.unread.delete(key); renderBadges();
  $('#cc-sub').textContent = state.callTitle ? ' · ' + state.callTitle : '';
  $('#call-chat').hidden = false;
  if (!state.chats.has(key)) state.chats.set(key, []);
  renderMessages($('#cc-messages'), state.chats.get(key), isGroup);
  try {
    await loadHistory(c.type, c.id);
    if (!$('#call-chat').hidden && state.callChat && chatKey(state.callChat.type, state.callChat.id) === key)
      renderMessages($('#cc-messages'), state.chats.get(key), isGroup);
  } catch (err) {
    $('#cc-messages').innerHTML = `<div class="chat-empty">${esc(err.message)}</div>`;
  }
  if (window.matchMedia('(pointer: fine)').matches) $('#cc-input').focus();   // don't pop the phone keyboard open
}
function closeCallChat() { $('#call-chat').hidden = true; }

$('#chat-call-btn').addEventListener('click', () => ($('#call-chat').hidden ? openCallChat() : closeCallChat()));
$('#cc-close').addEventListener('click', closeCallChat);
$('#cc-messages').addEventListener('scroll', e => {
  const b = e.currentTarget;
  b.dataset.stick = b.scrollHeight - b.scrollTop - b.clientHeight < 120 ? '1' : '0';
});
$('#cc-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#cc-input');
  const text = input.value.trim();
  if (!text || !state.callChat) return;
  input.value = '';
  input.focus();
  state.socket.emit('chat:send', { type: state.callChat.type, targetId: state.callChat.id, text }, res => {
    if (res?.error) { input.value = text; toast(res.error); }
  });
});
$('#cc-attach').addEventListener('click', () => $('#cc-file').click());
$('#cc-file').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length || !state.callChat) return;
  const btn = $('#cc-attach');
  btn.disabled = true; btn.textContent = '⏳';
  try { for (const f of files) await sendFile(f, state.callChat); }
  catch (err) { toast(err.message); }
  finally { btn.disabled = false; btn.textContent = '📎'; }
});

/* ---------------- Mini-games during a call ---------------- */
const GAME_DESC = {
  tetris: 'Stack blocks, clear lines',
  pacman: 'Eat the dots, dodge the ghosts',
  riverraid: 'Fly up the river, shoot, refuel',
  invaders: 'Stop the alien wave',
};
const GAME_KEYS = {
  ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right',
  ArrowUp: 'up', w: 'up', W: 'up', ArrowDown: 'down', s: 'down', S: 'down',
  ' ': 'a', Enter: 'a', z: 'a', Z: 'a', x: 'a', X: 'a',
};
let scoreTimer = null, pendingScore = null;

function flushScore() {
  clearTimeout(scoreTimer); scoreTimer = null;
  if (!pendingScore || !state.callId) return;
  state.socket.emit('game:score', { callId: state.callId, score: pendingScore.n, over: pendingScore.over });
  pendingScore = null;
}
function sendScore(n, over, now) {
  pendingScore = { n, over };
  if (over || now) return flushScore();
  if (!scoreTimer) scoreTimer = setTimeout(flushScore, 300);
}

function renderBoard() {
  const rows = [...state.gameScores].sort((a, b) => Math.max(b.best, b.score) - Math.max(a.best, a.score));
  $('#game-board').innerHTML = rows.map((r, i) => `
    <li class="${r.userId === state.me.id ? 'me' : ''}">
      <span class="rk">${i + 1}</span><span class="nm">${esc(r.name)}</span>
      <span class="pt">${Math.max(r.best, r.score)}</span>${r.playing ? '<i class="live" title="playing now"></i>' : ''}
    </li>`).join('') || '<li class="empty">Nobody has played yet</li>';
}

function buildPad(meta) {
  const p = meta.pad;
  const dir = ['up', 'left', 'down', 'right'].filter(k => p[k])
    .map(k => `<button type="button" class="pad-btn pad-${k}" data-k="${k}" aria-label="${k}">${p[k]}</button>`).join('');
  $('#touch-pad').innerHTML = `<div class="dpad">${dir}</div>` +
    (p.a ? `<button type="button" class="pad-btn pad-a" data-k="a" aria-label="action">${p.a}</button>` : '');
}

function showGameBanner(msg) {
  $('#game-banner-text').textContent = msg;
  $('#game-banner').hidden = false;
}
function hideGameLayer() {
  $('#game-layer').hidden = true;
  $('#call-view').classList.remove('game-on');
}
function stopGame() {
  if (state.gameRun) { state.gameRun.stop(); state.gameRun = null; }
  flushScore();
}

function playGame() {
  const g = state.game;
  if (!g || !state.callId) return;
  stopGame();
  const meta = PingGames.META[g.game];
  $('#game-title').textContent = `${meta.emoji} ${meta.title}`;
  $('#game-hint').textContent = meta.hint;
  buildPad(meta);
  $('#game-over').hidden = true;
  $('#game-banner').hidden = true;
  $('#game-end').hidden = !(g.startedBy === state.me.id || iAmMod());
  $('#game-layer').hidden = false;
  $('#call-view').classList.add('game-on');
  document.querySelectorAll('.tile-menu').forEach(m => { m.hidden = true; });
  state.gameRun = PingGames.create(g.game, $('#game-canvas'), g.seed, {
    score: n => sendScore(n, false),
    over: n => { sendScore(n, true); $('#go-score').textContent = n; $('#game-over').hidden = false; },
  });
  state.gameRun.start();
  sendScore(0, false, true);
  document.activeElement?.blur();
}

function openGamePicker() {
  const g = state.game;
  const now = g ? `
    <div class="game-now">
      <span>Now playing <b>${PingGames.META[g.game].emoji} ${PingGames.META[g.game].title}</b> · started by ${esc(g.byName)}</span>
      <button class="btn primary small" data-gp="join">${state.gameRun ? 'Back to game' : 'Join'}</button>
    </div>` : '';
  $('#game-list').innerHTML = now + Object.entries(PingGames.META).map(([id, m]) => `
    <button type="button" class="game-pick" data-gp="${id}">
      <span class="gp-ico">${m.emoji}</span>
      <span class="gp-txt"><b>${m.title}</b><small>${GAME_DESC[id]}</small></span>
    </button>`).join('');
  $('#game-modal').hidden = false;
}

$('#game-btn').addEventListener('click', openGamePicker);
$('#game-modal-close').addEventListener('click', () => { $('#game-modal').hidden = true; });
$('#game-list').addEventListener('click', e => {
  const b = e.target.closest('[data-gp]');
  if (!b) return;
  $('#game-modal').hidden = true;
  if (b.dataset.gp === 'join') return playGame();
  state.socket.emit('game:start', { callId: state.callId, game: b.dataset.gp }, res => {
    if (res?.error) toast(res.error);
  });
});
$('#game-banner-join').addEventListener('click', playGame);
$('#game-banner-x').addEventListener('click', () => { $('#game-banner').hidden = true; });
$('#game-again').addEventListener('click', playGame);
$('#game-hide').addEventListener('click', () => {
  stopGame(); hideGameLayer();
  if (state.game) showGameBanner(`${state.game.byName}'s game is still going`);
});
$('#game-end').addEventListener('click', () => {
  if (confirm('End the game for everyone?')) state.socket.emit('game:end', { callId: state.callId }, res => { if (res?.error) toast(res.error); });
});

/* keyboard + on-screen touch pad both feed the running game */
const typing = e => e.target.closest && e.target.closest('input, textarea');
document.addEventListener('keydown', e => {
  const k = GAME_KEYS[e.key];
  if (!k || !state.gameRun || $('#game-layer').hidden || typing(e)) return;
  e.preventDefault();
  if (!e.repeat) state.gameRun.key(k, true);
});
document.addEventListener('keyup', e => {
  const k = GAME_KEYS[e.key];
  if (k && state.gameRun && !typing(e)) state.gameRun.key(k, false);
});
const pad = $('#touch-pad');
const padKey = (e, down) => {
  const b = e.target.closest('[data-k]');
  if (!b || !state.gameRun) return;
  e.preventDefault();
  state.gameRun.key(b.dataset.k, down);
  b.classList.toggle('on', down);
};
pad.addEventListener('pointerdown', e => padKey(e, true));
pad.addEventListener('pointerup', e => padKey(e, false));
pad.addEventListener('pointercancel', e => padKey(e, false));
pad.addEventListener('pointerleave', e => padKey(e, false), true);
pad.addEventListener('contextmenu', e => e.preventDefault());

/* ---------------- Boot ---------------- */
(async () => {
  if (state.token) {
    try { await enterApp(); return; } catch { localStorage.removeItem('ping_token'); state.token = null; }
  }
  show('#auth-view');
})();
