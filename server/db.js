const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/**
 * Minimal JSON-file database for users, contacts and groups.
 * Swap this for Postgres/MongoDB in production — the API surface stays the same.
 */
class Database {
  constructor(file) {
    // DATA_DIR env var lets you point at a persistent volume
    if (process.env.DATA_DIR) file = path.join(process.env.DATA_DIR, 'db.json');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.accessSync(path.dirname(file), fs.constants.W_OK);
    } catch (err) {
      // Read-only / restricted filesystem: fall back to a temp folder
      file = path.join(os.tmpdir(), 'ping-data', 'db.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      console.warn('Data dir not writable, using ' + file + ' (data may be lost on restart)');
    }
    this.file = file;
    this.data = { users: [], contacts: {}, groups: [], messages: [] };
    this.load();
  }

  load() {
    try {
      this.data = { contacts: {}, messages: [], ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch { /* first run */ }
    this.makeContactsMutual();
  }

  // Older data may have one-way contacts: make every contact mutual
  makeContactsMutual() {
    const c = this.data.contacts;
    for (const [uid, list] of Object.entries(c)) {
      for (const other of list) {
        if (!c[other]) c[other] = [];
        if (!c[other].includes(uid)) c[other].push(uid);
      }
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  // ---------- users ----------
  createUser({ displayName, identifier, kind, passwordHash }) {
    const user = {
      id: crypto.randomUUID(),
      displayName,
      identifier,          // email address OR phone number (unique)
      kind,                // 'email' | 'phone'
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    this.data.users.push(user);
    this.save();
    return user;
  }

  // emails compare in lower case; phone numbers compare as "+" and digits (spaces, dashes and brackets don't matter)
  static canon(v) {
    const s = String(v || '').trim();
    if (s.includes('@')) return s.toLowerCase();
    const digits = s.replace(/\D/g, '');
    if (s.startsWith('+')) return '+' + digits;
    if (s.startsWith('00')) return '+' + digits.slice(2);
    return digits || s.toLowerCase();
  }

  // allowLegacy: also find old accounts that were saved without a country code (used for log in and contact search, not for sign-up)
  findByIdentifier(identifier, allowLegacy = true) {
    const key = Database.canon(identifier);
    const exact = this.data.users.find(u => Database.canon(u.identifier) === key);
    if (exact || !allowLegacy || !/^\+\d+$/.test(key)) return exact;
    // old accounts saved a number WITHOUT a country code: match them when exactly one fits the end of the full number
    const digits = key.slice(1);
    const legacy = this.data.users.filter(u => {
      const c = Database.canon(u.identifier).replace(/^0+/, '');
      return /^\d{7,}$/.test(c) && digits.endsWith(c);
    });
    return legacy.length === 1 ? legacy[0] : undefined;
  }

  findById(id) {
    return this.data.users.find(u => u.id === id);
  }

  // ---------- contacts ----------
  // Adding a contact adds it on BOTH accounts
  addContact(userId, contactId) {
    let changed = false;
    for (const [a, b] of [[userId, contactId], [contactId, userId]]) {
      if (!this.data.contacts[a]) this.data.contacts[a] = [];
      if (!this.data.contacts[a].includes(b)) {
        this.data.contacts[a].push(b);
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  removeContact(userId, contactId) {
    for (const [a, b] of [[userId, contactId], [contactId, userId]]) {
      this.data.contacts[a] = (this.data.contacts[a] || []).filter(id => id !== b);
    }
    this.save();
  }

  contactsOf(userId) {
    return (this.data.contacts[userId] || []).map(id => this.findById(id)).filter(Boolean);
  }

  // ---------- chat messages ----------
  convKey(type, a, b) {
    return type === 'group' ? 'g:' + a : 'u:' + [a, b].sort().join(':');
  }

  addMessage({ conv, from, text = '', file, location }) {
    const msg = { id: crypto.randomUUID(), conv, from, text, ts: Date.now() };
    if (file) msg.file = file; // { id, name, size, mime|null }
    if (location) msg.location = location; // { lat, lng, acc|null }
    this.data.messages.push(msg);
    this.save();
    return msg;
  }

  findFile(fileId) {
    for (let i = this.data.messages.length - 1; i >= 0; i--) {
      const f = this.data.messages[i].file;
      if (f && f.id === fileId) return f;
    }
    return null;
  }

  messagesOf(conv, limit = 200) {
    return this.data.messages.filter(m => m.conv === conv).slice(-limit);
  }

  // ---------- groups ----------
  createGroup({ name, ownerId, memberIds }) {
    const group = {
      id: crypto.randomUUID(),
      name,
      ownerId,
      memberIds,           // always includes the owner
      createdAt: new Date().toISOString(),
    };
    this.data.groups.push(group);
    this.save();
    return group;
  }

  getGroup(id) {
    return this.data.groups.find(g => g.id === id);
  }

  addGroupMembers(groupId, userIds) {
    const g = this.getGroup(groupId);
    for (const id of userIds) if (!g.memberIds.includes(id)) g.memberIds.push(id);
    this.save();
    return g;
  }

  groupsOf(userId) {
    return this.data.groups.filter(g => g.memberIds.includes(userId));
  }
}

module.exports = Database;
