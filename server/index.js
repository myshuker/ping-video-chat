const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('./db');

// ---- web push (optional: npm install webpush) ----
let webpush = null;
try { webpush = require('web-push'); } catch { console.warn('[push] web-push not installed — run: npm install web-push'); }
const vapidKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
// web-push wants the raw keys: public = 65 bytes (0x04 + X + Y), private = 32 bytes
const pubJwk = vapidKeys.publicKey.export({ format: 'jwk' });
const privJwk = vapidKeys.privateKey.export({ format: 'jwk' });
const rawPub = Buffer.concat([Buffer.from([4]), Buffer.from(pubJwk.x, 'base64url'), Buffer.from(pubJwk.y, 'base64url')]);
const VAPID_PUBLIC_KEY = rawPub.toString('base64url');
const VAPID_PRIVATE_KEY = privJwk.d;
if (webpush) webpush.setVapidDetails('mailto:ping@ping.local', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3000;

const db = new Database(path.join(__dirname, '..', 'data', 'db.json'));
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
// never cache the HTML so everyone always gets the latest version
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: VAPID_PUBLIC_KEY }));

// ---------------- helpers ----------------
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
// Phone numbers are kept in international form: "+" and digits only (e.g. +4512345678).
// "+45 12 34 56 78", "0045 12345678" and "+4512345678" are all the same number.
const toInternational = v => {
  const s = String(v || '').trim();
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return '+' + digits;
  if (s.startsWith('00')) return '+' + digits.slice(2);
  return null;                                           // no country code
};
const isPhone = v => /^\+[1-9]\d{7,14}$/.test(toInternational(v) || '');
const looksLikePhone = v => /^[+\d(][\d\s().+-]{5,24}$/.test(String(v || '').trim());
const publicUser = u => ({ id: u.id, identifier: u.identifier, kind: u.kind, displayName: u.displayName });
const sign = u => jwt.sign({ sub: u.id }, JWT_SECRET, { expiresIn: '30d' });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------------- auth & user management ----------------
app.post('/api/register', (req, res) => {
  const { displayName, identifier: raw, password } = req.body || {};
  const identifier = String(raw || '').trim();
  if (!displayName?.trim() || !identifier || !password)
    return res.status(400).json({ error: 'Name, email/phone and password are required' });

  const kind = isEmail(identifier) ? 'email' : isPhone(identifier) ? 'phone' : null;
  if (!kind) return res.status(400).json({
    error: looksLikePhone(identifier) && !toInternational(identifier)
      ? 'Please add your country code, for example +45 12 34 56 78'
      : 'Enter a valid email or phone number',
  });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const stored = kind === 'phone' ? toInternational(identifier) : identifier;
  if (db.findByIdentifier(stored, false))
    return res.status(409).json({ error: 'An account with this email/phone already exists' });

  const user = db.createUser({
    displayName: displayName.trim(),
    identifier: stored,
    kind,
    passwordHash: bcrypt.hashSync(password, 10),
  });
  res.status(201).json({ token: sign(user), user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { identifier: raw, password } = req.body || {};
  const identifier = String(raw || '').trim();
  const user = db.findByIdentifier(identifier);
  if (!user || !bcrypt.compareSync(String(password || ''), user.passwordHash))
    return res.status(401).json({ error: 'Wrong email/phone or password' });
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  const u = db.findById(req.userId);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(u));
});

// ---------------- contacts ----------------
app.get('/api/contacts', auth, (req, res) => {
  res.json(db.contactsOf(req.userId).map(publicUser));
});

app.post('/api/contacts', auth, (req, res) => {
  const identifier = String((req.body || {}).identifier || '').trim();
  const target = db.findByIdentifier(identifier);
  if (!target) return res.status(404).json({ error: 'No user found with that email or phone' });
  if (target.id === req.userId) return res.status(400).json({ error: 'You cannot add yourself' });
  db.addContact(req.userId, target.id); // adds on both accounts
  emitToUser(target.id, 'contacts:changed');
  res.status(201).json(publicUser(target));
});

app.delete('/api/contacts/:id', auth, (req, res) => {
  db.removeContact(req.userId, req.params.id);
  emitToUser(req.params.id, 'contacts:changed');
  res.status(204).end();
});

// ---------------- groups ----------------
app.get('/api/groups', auth, (req, res) => {
  res.json(db.groupsOf(req.userId).map(groupWithMembers));
});

const MAX_GROUP_MEMBERS = 10; // including the creator

const groupWithMembers = g => ({ ...g, members: g.memberIds.map(id => db.findById(id)).filter(Boolean).map(publicUser) });
const allAreContacts = (userId, ids) => {
  const mine = new Set(db.contactsOf(userId).map(c => c.id));
  return ids.every(id => mine.has(id));
};

app.post('/api/groups', auth, (req, res) => {
  const { name, memberIds = [] } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Group name is required' });
  if (!Array.isArray(memberIds) || !memberIds.length) return res.status(400).json({ error: 'Add at least one contact to the group' });
  if (!allAreContacts(req.userId, memberIds)) return res.status(400).json({ error: 'You can only add your contacts' });
  const members = [...new Set([req.userId, ...memberIds])];
  if (members.length > MAX_GROUP_MEMBERS)
    return res.status(400).json({ error: `A group can have at most ${MAX_GROUP_MEMBERS} members (including you)` });
  const group = db.createGroup({ name: name.trim(), ownerId: req.userId, memberIds: members });
  for (const id of group.memberIds) if (id !== req.userId) emitToUser(id, 'groups:changed');
  res.status(201).json(group);
});

// add more people to an existing group (owner only)
app.post('/api/groups/:id/members', auth, (req, res) => {
  const g = db.getGroup(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (g.ownerId !== req.userId) return res.status(403).json({ error: 'Only the group creator can add people' });
  const { memberIds = [] } = req.body || {};
  if (!Array.isArray(memberIds) || !memberIds.length) return res.status(400).json({ error: 'Select at least one contact' });
  if (!allAreContacts(req.userId, memberIds)) return res.status(400).json({ error: 'You can only add your contacts' });
  const total = new Set([...g.memberIds, ...memberIds]).size;
  if (total > MAX_GROUP_MEMBERS)
    return res.status(400).json({ error: `A group can have at most ${MAX_GROUP_MEMBERS} members (including you)` });
  db.addGroupMembers(g.id, memberIds);
  for (const id of g.memberIds) if (id !== req.userId) emitToUser(id, 'groups:changed');
  res.json(groupWithMembers(g));
});

// ---------------- chat history ----------------
// Resolves a chat target to its conversation key, or an error string
function resolveChat(userId, type, targetId) {
  if (type === 'user') {
    if (!db.contactsOf(userId).some(c => c.id === targetId)) return { error: 'You can only chat with your contacts' };
    return { conv: db.convKey('user', userId, targetId), recipients: [userId, targetId] };
  }
  if (type === 'group') {
    const g = db.getGroup(targetId);
    if (!g) return { error: 'Group not found' };
    if (!g.memberIds.includes(userId)) return { error: 'You are not a member of this group' };
    return { conv: db.convKey('group', targetId), recipients: g.memberIds };
  }
  return { error: 'Unknown chat type' };
}

const withSender = m => ({
  id: m.id, from: m.from, fromName: profileOf(m.from)?.displayName || 'Unknown', text: m.text, ts: m.ts,
  ...(m.file ? { file: { id: m.file.id, name: m.file.name, size: m.file.size, image: !!m.file.mime } } : {}),
  ...(m.location ? { location: { lat: m.location.lat, lng: m.location.lng, acc: m.location.acc } } : {}),
});

// store a message and push it to everybody in the conversation
function deliverMessage(uid, type, targetId, r, { text = '', file, location } = {}) {
  const msg = withSender(db.addMessage({ conv: r.conv, from: uid, text, file, location }));
  for (const rid of new Set(r.recipients)) {
    // each person files the chat under the "other side": the sender under the target, the target under the sender
    const convId = type === 'group' ? targetId : (rid === uid ? targetId : uid);
    emitToUser(rid, 'chat:message', { ...msg, type, convId });
  }
  return msg;
}

app.get('/api/messages', auth, (req, res) => {
  const r = resolveChat(req.userId, String(req.query.type || ''), String(req.query.id || ''));
  if (r.error) return res.status(403).json({ error: r.error });
  res.json(db.messagesOf(r.conv).map(withSender));
});


// ---------------- file & picture sharing ----------------
const MAX_FILE = 10 * 1024 * 1024; // 10 MB
let uploadDir = path.join(path.dirname(db.file), 'uploads');
try { fs.mkdirSync(uploadDir, { recursive: true }); fs.accessSync(uploadDir, fs.constants.W_OK); }
catch { uploadDir = path.join(require('os').tmpdir(), 'ping-uploads'); fs.mkdirSync(uploadDir, { recursive: true }); }

// Decide from the file's real bytes whether it is a safe raster image (never trust the client's type)
function sniffImage(b) {
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
const cleanName = n => String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(-120) || 'file';

app.post('/api/chat/file', auth, express.raw({ type: () => true, limit: MAX_FILE }), (req, res) => {
  const type = String(req.query.type || '');
  const targetId = String(req.query.id || '');
  const r = resolveChat(req.userId, type, targetId);
  if (r.error) return res.status(403).json({ error: r.error });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Empty file' });
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFile(path.join(uploadDir, id), buf, err => {
    if (err) return res.status(500).json({ error: 'Could not save the file' });
    const file = { id, name: cleanName(req.query.name), size: buf.length, mime: sniffImage(buf) };
    deliverMessage(req.userId, type, targetId, r, { file });
    res.status(201).json({ ok: true });
  });
});

// Files are served by an unguessable id. Anything that is not a real image is forced to download,
// and everything is sandboxed so an uploaded file can never run code on this site.
app.get('/files/:id/:name?', (req, res) => {
  const id = String(req.params.id);
  const file = /^[a-f0-9]{32}$/.test(id) && db.findFile(id);
  if (!file) return res.status(404).send('Not found');
  const full = path.join(uploadDir, id);
  fs.stat(full, (err, st) => {
    if (err) return res.status(404).send('File no longer available');
    const inline = !!file.mime && req.query.download !== '1';
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Length', st.size);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    fs.createReadStream(full).on('error', () => res.end()).pipe(res);
  });
});

// ---------------- realtime: presence + WebRTC signaling ----------------
const userSockets = new Map(); // userId -> Set(socketId)
const calls = new Map();       // callId -> Map(userId -> Set(socketId))
const callMeta = new Map();    // callId -> { hostId, ownerId, allowed:Set, kicked:Set }
const pushSubs = new Map();     // userId -> Set of push subscription JSON strings
const isMod = (meta, id) => id === meta.hostId || (meta.ownerId && id === meta.ownerId);
const modsOf = meta => [...new Set([meta.hostId, meta.ownerId].filter(Boolean))];

// ---- mini-games played together during a call ----
const GAMES = ['tetris', 'pacman', 'riverraid', 'invaders'];
const scoreList = g => Object.entries(g.scores).map(([userId, s]) => ({ userId, name: s.name, score: s.score, best: s.best, playing: s.playing }));
const publicGame = g => ({ game: g.game, seed: g.seed, startedBy: g.startedBy, byName: g.byName, scores: scoreList(g) });

const socketsOf = userId => userSockets.get(userId) || new Set();
const emitToUser = (userId, event, payload) => {
  for (const sid of socketsOf(userId)) io.to(sid).emit(event, payload);
};
const participantsOf = callId => [...(calls.get(callId)?.keys() || [])];
const sendPushToUser = (userId, payload) => {
  if (!webpush) return;
  const subs = pushSubs.get(userId);
  if (!subs || !subs.size) return;
  for (const s of subs) {
    webpush.sendNotification(JSON.parse(s), JSON.stringify(payload)).catch(() => subs.delete(s));
  }
};
const profileOf = id => {
  const u = db.findById(id);
  return u && publicUser(u);
};

io.use((socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth?.token || '', JWT_SECRET);
    socket.userId = payload.sub;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', socket => {
  const uid = socket.userId;
  if (!userSockets.has(uid)) userSockets.set(uid, new Set());
  userSockets.get(uid).add(socket.id);

  // --- text chat (1:1 or group) ---
  socket.on('chat:send', (payload, cb = () => {}) => {
    const { type, targetId } = payload || {};
    const text = String((payload || {}).text || '').trim().slice(0, 2000);
    // a shared location: only real coordinates are accepted, rounded to ~10 cm
    let location;
    const loc = (payload || {}).location;
    if (loc) {
      const lat = Number(loc.lat), lng = Number(loc.lng), acc = Number(loc.acc);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
        return cb({ error: 'Invalid location' });
      location = {
        lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6,
        acc: Number.isFinite(acc) && acc >= 0 ? Math.min(Math.round(acc), 100000) : null,
      };
    }
    if (!text && !location) return cb({ error: 'Empty message' });
    const r = resolveChat(uid, type, String(targetId || ''));
    if (r.error) return cb({ error: r.error });
    deliverMessage(uid, type, String(targetId), r, location ? { location } : { text });
    cb({ ok: true });
  });

  // --- start a call (1:1 or group) ---
  socket.on('call:start', (payload, cb = () => {}) => {
    const { callType, targetId } = payload || {};
    let targets = [];
    let title = '';

    if (callType === 'user') {
      const t = db.findById(targetId);
      if (!t) return cb({ error: 'User not found' });
      if (!db.contactsOf(uid).some(c => c.id === targetId))
        return cb({ error: 'You can only call your contacts' });
      targets = [targetId];
      title = t.displayName;
    } else if (callType === 'group') {
      const g = db.getGroup(targetId);
      if (!g) return cb({ error: 'Group not found' });
      if (!g.memberIds.includes(uid)) return cb({ error: 'You are not a member of this group' });
      targets = g.memberIds.filter(id => id !== uid);
      title = g.name;
    } else {
      return cb({ error: 'Unknown call type' });
    }

    const callId = crypto.randomUUID();
    calls.set(callId, new Map([[uid, new Set([socket.id])]]));
    // the person who starts the call is the host; the group owner can moderate group calls too
    const meta = {
      hostId: uid,
      ownerId: callType === 'group' ? db.getGroup(targetId).ownerId : null,
      allowed: new Set([uid, ...targets]),
      kicked: new Set(),
      game: null,
      callType,
      targetId,
      media: {},            // userId -> { mic, cam } so everyone can show muted / camera-off icons
    };
    callMeta.set(callId, meta);
    socket.join('call:' + callId);
    const from = profileOf(uid);
    for (const t of targets) emitToUser(t, 'call:incoming', { callId, callType, title, from });
    // offline? ring their phone with a push notification instead
    for (const t of targets) {
      if (!socketsOf(t).size) {
        sendPushToUser(t, { title: '📞 Incoming call', body: `${from?.displayName || 'Someone'} is calling you`, callId, type: 'call-incoming' });
      }
    }
    cb({ callId, moderators: modsOf(meta), chat: { type: callType, id: targetId } });
  });

  // --- accept an incoming call / join ---
  socket.on('call:accept', (payload, cb = () => {}) => {
    const { callId } = payload || {};
    const room = calls.get(callId);
    const meta = callMeta.get(callId);
    if (!room || !meta) return cb({ error: 'Call no longer available' });
    if (meta.kicked.has(uid)) return cb({ error: 'You were removed from this call' });
    if (!meta.allowed.has(uid)) return cb({ error: 'You were not invited to this call' });
    const existing = participantsOf(callId).filter(id => id !== uid);
    if (!room.has(uid)) room.set(uid, new Set());
    room.get(uid).add(socket.id);
    socket.join('call:' + callId);
    // tell existing participants so they initiate WebRTC offers to the newcomer
    socket.to('call:' + callId).emit('call:peer-joined', { userId: uid, profile: profileOf(uid) });
    cb({
      peers: existing,
      profiles: Object.fromEntries(existing.map(id => [id, profileOf(id)])),
      moderators: modsOf(meta),
      game: meta.game ? publicGame(meta.game) : null,
      media: meta.media,
      chat: meta.callType === 'group' ? { type: 'group', id: meta.targetId } : { type: 'user', id: meta.hostId },
    });
  });

  socket.on('call:decline', ({ callId } = {}) => {
    if (!callMeta.get(callId)?.allowed.has(uid)) return;
    socket.to('call:' + callId).emit('call:decline', { userId: uid, name: profileOf(uid)?.displayName });
  });

  // --- who is muted / has the camera off (shown as icons on everybody's screen) ---
  socket.on('call:media', ({ callId, mic, cam } = {}) => {
    const room = calls.get(callId);
    const meta = callMeta.get(callId);
    if (!room || !meta || !room.has(uid)) return;
    meta.media[uid] = { mic: !!mic, cam: !!cam };
    socket.to('call:' + callId).emit('call:media', { userId: uid, ...meta.media[uid] });
  });

  // store this browser's push subscription so we can reach it when it's offline
  socket.on('push:subscribe', ({ subscription } = {}) => {
    if (!subscription) return;
    if (!pushSubs.has(uid)) pushSubs.set(uid, new Set());
    pushSubs.get(uid).add(JSON.stringify(subscription));
  });

  // --- mini-games: anyone in the call can start one; everybody gets the same seed ---
  const gameCtx = callId => {
    const room = calls.get(callId);
    const meta = callMeta.get(callId);
    return room && meta && room.has(uid) ? { room, meta } : null;
  };

  socket.on('game:start', ({ callId, game } = {}, cb = () => {}) => {
    const ctx = gameCtx(callId);
    if (!ctx) return cb({ error: 'You are not in this call' });
    if (!GAMES.includes(game)) return cb({ error: 'Unknown game' });
    const cur = ctx.meta.game;
    if (cur && cur.startedBy !== uid && !isMod(ctx.meta, uid))
      return cb({ error: `${cur.byName || 'Someone'} is already running a game. Ask them or the host to switch.` });
    ctx.meta.game = {
      game, seed: crypto.randomInt(1, 2 ** 31), startedBy: uid,
      byName: profileOf(uid)?.displayName || 'Someone', scores: {},
    };
    io.to('call:' + callId).emit('game:started', publicGame(ctx.meta.game));
    cb({ ok: true });
  });

  socket.on('game:score', ({ callId, score, over } = {}) => {
    const g = gameCtx(callId)?.meta.game;
    if (!g) return;
    const n = Math.max(0, Math.min(10_000_000, Math.floor(Number(score) || 0)));
    const s = g.scores[uid] || (g.scores[uid] = { name: profileOf(uid)?.displayName || 'Player', score: 0, best: 0, playing: true, t: 0 });
    const now = Date.now();
    if (!over && now - s.t < 150) return;           // ignore floods
    s.t = now;
    s.score = n;
    s.best = Math.max(s.best, n);
    s.playing = !over;
    io.to('call:' + callId).emit('game:scores', scoreList(g));
  });

  // only whoever started the game, or a moderator, can end it for everybody
  socket.on('game:end', ({ callId } = {}, cb = () => {}) => {
    const ctx = gameCtx(callId);
    const g = ctx?.meta.game;
    if (!g) return cb({ error: 'No game is running' });
    if (g.startedBy !== uid && !isMod(ctx.meta, uid)) return cb({ error: 'Only the person who started it or the host can end the game' });
    ctx.meta.game = null;
    io.to('call:' + callId).emit('game:ended', { by: profileOf(uid)?.displayName });
    cb({ ok: true });
  });

  // --- moderation: only the host (and the group owner in group calls) ---
  const moderate = (callId, userId, cb) => {
    const room = calls.get(callId);
    const meta = callMeta.get(callId);
    if (!room || !meta || !room.has(uid) || !isMod(meta, uid)) { cb({ error: 'Only the host can do that' }); return null; }
    if (userId === uid) { cb({ error: "You can't do that to yourself" }); return null; }
    if (!room.has(userId)) { cb({ error: 'That person is not in the call' }); return null; }
    return { room, meta };
  };

  // mute someone for everyone (they can unmute themselves again)
  socket.on('call:mute-user', ({ callId, userId } = {}, cb = () => {}) => {
    const ctx = moderate(callId, userId, cb);
    if (!ctx) return;
    for (const sid of ctx.room.get(userId)) io.to(sid).emit('call:force-mute', { by: profileOf(uid)?.displayName });
    ctx.meta.media[userId] = { cam: true, ...ctx.meta.media[userId], mic: false };
    io.to('call:' + callId).emit('call:media', { userId, ...ctx.meta.media[userId] });
    cb({ ok: true });
  });

  // remove someone from the call and stop them rejoining
  socket.on('call:kick', ({ callId, userId } = {}, cb = () => {}) => {
    const ctx = moderate(callId, userId, cb);
    if (!ctx) return;
    if (userId === ctx.meta.ownerId && uid !== ctx.meta.ownerId) return cb({ error: "You can't remove the group owner" });
    ctx.meta.kicked.add(userId);
    const sids = [...ctx.room.get(userId)];
    ctx.room.delete(userId);
    for (const sid of sids) {
      io.to(sid).emit('call:kicked', { by: profileOf(uid)?.displayName });
      io.sockets.sockets.get(sid)?.leave('call:' + callId);
    }
    io.to('call:' + callId).emit('call:peer-left', { userId });
    cb({ ok: true });
  });

  // --- WebRTC signaling relay (offer / answer / ICE) ---
  const relay = event => payload => {
    const { callId, to } = payload || {};
    if (!calls.get(callId)?.has(uid)) return;   // kicked / not in this call
    const targetSockets = calls.get(callId)?.get(to);
    if (!targetSockets) return;
    for (const sid of targetSockets) if (sid !== socket.id) socket.to(sid).emit(event, { ...payload, from: uid });
  };
  socket.on('rtc:offer', relay('rtc:offer'));
  socket.on('rtc:answer', relay('rtc:answer'));
  socket.on('rtc:ice', relay('rtc:ice'));

  // --- leave / disconnect cleanup ---
  const leaveAllCalls = () => {
    for (const [callId, room] of calls) {
      if (!room.has(uid)) continue;
      const set = room.get(uid);
      set.delete(socket.id);
      if (set.size === 0) {
        room.delete(uid);
        const g = callMeta.get(callId)?.game;
        if (g?.scores[uid]) { g.scores[uid].playing = false; io.to('call:' + callId).emit('game:scores', scoreList(g)); }
        socket.to('call:' + callId).emit('call:peer-left', { userId: uid });
        if (room.size === 0) {
          const meta = callMeta.get(callId);
          if (meta) for (const id of meta.allowed) if (id !== uid) emitToUser(id, 'call:cancelled', { callId });
          calls.delete(callId); callMeta.delete(callId);
        }
      }
    }
  };

  socket.on('call:leave', leaveAllCalls);
  socket.on('disconnect', () => {
    const set = userSockets.get(uid);
    if (set) {
      set.delete(socket.id);
      if (!set.size) userSockets.delete(uid);
    }
    leaveAllCalls();
  });
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'File is too large (max 10 MB)' });
  console.error(err);
  res.status(err.status || 500).json({ error: 'Server error' });
});

server.listen(PORT, () => console.log(`Ping server running at http://localhost:${PORT}`));
