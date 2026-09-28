'use strict';
const crypto = require('crypto');
const { CODE_REGEX, randomCode, cleanText, TokenBucket } = require('./util');

// What a room "plays". These are exactly the extras the Android PlayerActivity already understands,
// so a guest can open the very same content through the normal player flow.
const MEDIA_STRING_LIMITS = {
  VID: 128, TITLE: 200, IMG: 600, DESC: 600, RATING: 16, YEAR: 16, QUALITY: 32,
  GENRE: 120, DIRECTOR: 120, DURATION: 32, LANGUAGE: 32, TMDB_ID: 32
};
const MEDIA_INT_KEYS = ['SEASON', 'EPISODE'];

function sanitizeMedia(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const media = {};
  for (const [key, max] of Object.entries(MEDIA_STRING_LIMITS)) {
    const v = raw[key];
    if (typeof v === 'string' || typeof v === 'number') {
      const text = cleanText(String(v), max);
      if (text) media[key] = text;
    }
  }
  if (!media.VID) return null;
  if (media.IMG && !/^https?:\/\//i.test(media.IMG)) delete media.IMG; // no javascript:/file: URLs
  const type = typeof raw.TYPE === 'string' ? raw.TYPE.toLowerCase() : 'movie';
  if (type !== 'movie' && type !== 'tv') return null;
  media.TYPE = type;
  for (const key of MEDIA_INT_KEYS) {
    const n = Number(raw[key]);
    if (Number.isInteger(n) && n >= 0 && n <= 9999) media[key] = n;
  }
  if (type === 'tv' && (!media.TMDB_ID || media.SEASON === undefined || media.EPISODE === undefined)) return null;
  return media;
}

const DEFAULTS = {
  maxMembers: 30,
  maxRooms: 5000,
  maxRoomsPerDevice: 2,
  reconnectGraceMs: 45000,   // a dropped member keeps their seat this long
  emptyGraceMs: 120000,      // a room nobody ever joined / everybody left is removed after this
  maxRoomAgeMs: 12 * 3600 * 1000,
  chatHistory: 50,
  chatMaxLength: 300,
  chatBurst: 5,
  chatRefillPerSec: 0.5,
  nameMaxLength: 24
};

class RoomManager {
  constructor(options = {}) {
    this.cfg = Object.assign({}, DEFAULTS, options);
    this.rooms = new Map();
    this.hosted = new Map(); // deviceId -> number of open rooms it created
    this.chatSeq = 0;
    this.sweeper = setInterval(() => this.sweep(), 60000);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  // ------------------------------------------------------------------ rooms
  createRoom(deviceId, rawMedia) {
    const media = sanitizeMedia(rawMedia);
    if (!media) return { error: 'bad_media' };
    if (this.rooms.size >= this.cfg.maxRooms) return { error: 'busy' };
    if ((this.hosted.get(deviceId) || 0) >= this.cfg.maxRoomsPerDevice) return { error: 'too_many_rooms' };

    let code = null;
    for (let i = 0; i < 20 && !code; i++) {
      const c = randomCode(6);
      if (!this.rooms.has(c)) code = c;
    }
    if (!code) return { error: 'busy' };

    const now = Date.now();
    const room = {
      code,
      media,
      hostDeviceId: deviceId,
      createdAt: now,
      members: new Map(),
      banned: new Set(),
      chat: [],
      state: { playing: false, pos: 0, rate: 1, at: now, seq: 0 },
      closed: false,
      emptyTimer: null
    };
    this.rooms.set(code, room);
    this.hosted.set(deviceId, (this.hosted.get(deviceId) || 0) + 1);
    this._armEmptyTimer(room);
    return { code, media };
  }

  getRoom(code) {
    if (typeof code !== 'string' || !CODE_REGEX.test(code)) return null;
    const room = this.rooms.get(code);
    return room && !room.closed ? room : null;
  }

  peek(code) {
    const room = this.getRoom(code);
    if (!room) return null;
    const host = this._hostMember(room);
    return {
      code: room.code,
      media: room.media,
      members: room.members.size,
      hostName: host ? host.name : null,
      full: room.members.size >= this.cfg.maxMembers
    };
  }

  stats() {
    let members = 0;
    for (const r of this.rooms.values()) members += r.members.size;
    return { rooms: this.rooms.size, members };
  }

  // ---------------------------------------------------------------- members
  join(code, deviceId, rawName, transport) {
    const room = this.getRoom(code);
    if (!room) return { error: 'not_found' };
    if (room.banned.has(deviceId)) return { error: 'kicked' };

    let member = room.members.get(deviceId);
    let isNew = false;
    if (member) {
      // Same device connecting again (network switch, app restart): keep its seat, replace the socket.
      const old = member.transport;
      this.timersClear(member);
      member.transport = transport;
      member.connected = true;
      if (old && old !== transport) safeClose(old, 4001, 'replaced');
      this.broadcast(room, { t: 'presence', id: member.id, online: true }, deviceId);
    } else {
      if (room.members.size >= this.cfg.maxMembers) return { error: 'full' };
      isNew = true;
      const name = cleanText(rawName, this.cfg.nameMaxLength) || 'Guest ' + crypto.randomInt(1000, 9999);
      member = {
        id: crypto.randomBytes(4).toString('hex'), // public id: never expose the device id to other members
        deviceId,
        name,
        joinedAt: Date.now(),
        transport,
        connected: true,
        graceTimer: null,
        chatBucket: new TokenBucket(this.cfg.chatBurst, this.cfg.chatRefillPerSec),
        mic: false,
        mutedByHost: false,
        signalBucket: new TokenBucket(60, 30) // WebRTC signaling: bursty but bounded
      };
      room.members.set(deviceId, member);
      this.broadcast(room, { t: 'join', member: { id: member.id, name: member.name, mic: false, mutedByHost: false } }, deviceId);
    }
    this._clearEmptyTimer(room);
    return { room, member, isNew };
  }

  buildWelcome(room, member) {
    const host = this._hostMember(room);
    return {
      t: 'welcome',
      you: { id: member.id, name: member.name, host: room.hostDeviceId === member.deviceId },
      room: {
        code: room.code,
        media: room.media,
        hostId: host ? host.id : null,
        members: Array.from(room.members.values()).map(m => ({
          id: m.id, name: m.name, host: m.deviceId === room.hostDeviceId, online: m.connected,
          mic: m.mic, mutedByHost: m.mutedByHost
        })),
        state: room.state,
        serverNow: Date.now()
      },
      history: room.chat.slice(-this.cfg.chatHistory)
    };
  }

  /** Called when a socket closes. Ignored if the member already reconnected on another socket. */
  disconnect(code, deviceId, transport) {
    const room = this.rooms.get(code);
    const member = room && room.members.get(deviceId);
    if (!member || member.transport !== transport) return;
    member.connected = false;
    member.transport = null;
    member.mic = false; // the WebRTC session dies with the socket; the client must re-negotiate on reconnect
    this.broadcast(room, { t: 'presence', id: member.id, online: false, mic: false }, deviceId);
    this.timersClear(member);
    member.graceTimer = setTimeout(() => this._removeMember(room, member, 'timeout'), this.cfg.reconnectGraceMs);
    if (member.graceTimer.unref) member.graceTimer.unref();
  }

  leave(code, deviceId) {
    const room = this.rooms.get(code);
    const member = room && room.members.get(deviceId);
    if (member) this._removeMember(room, member, 'left');
  }

  // --------------------------------------------------------------- actions
  setState(code, deviceId, msg) {
    const room = this.getRoom(code);
    if (!room) return { error: 'not_found' };
    if (room.hostDeviceId !== deviceId) return { error: 'not_host' };
    const pos = Number(msg && msg.pos);
    if (!Number.isFinite(pos) || pos < 0 || pos > 1e10) return { error: 'bad_state' };
    let rate = Number(msg && msg.rate);
    if (!Number.isFinite(rate)) rate = 1;
    rate = Math.min(4, Math.max(0.25, rate));
    room.state = { playing: !!(msg && msg.playing), pos: Math.round(pos), rate, at: Date.now(), seq: room.state.seq + 1 };
    this.broadcast(room, Object.assign({ t: 'state' }, room.state), deviceId);
    return { ok: true };
  }

  chat(code, deviceId, rawText) {
    const room = this.getRoom(code);
    const member = room && room.members.get(deviceId);
    if (!member) return { error: 'not_found' };
    const text = cleanText(rawText, this.cfg.chatMaxLength);
    if (!text) return { error: 'empty' };          // empty messages don't cost chat quota
    if (!member.chatBucket.take()) return { error: 'rate' };
    const message = { t: 'chat', id: ++this.chatSeq, from: { id: member.id, name: member.name }, text, at: Date.now() };
    room.chat.push(message);
    if (room.chat.length > this.cfg.chatHistory) room.chat.shift();
    this.broadcast(room, message); // sender included: everybody sees the same ordered log
    return { ok: true };
  }

  kick(code, deviceId, memberId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'not_found' };
    if (room.hostDeviceId !== deviceId) return { error: 'not_host' };
    const target = Array.from(room.members.values()).find(m => m.id === memberId);
    if (!target || target.deviceId === deviceId) return { error: 'bad_target' };
    room.banned.add(target.deviceId);
    if (target.transport) {
      try { target.transport.send({ t: 'kicked' }); } catch (_) { /* socket already gone */ }
      safeClose(target.transport, 4003, 'kicked');
    }
    this._removeMember(room, target, 'kicked');
    return { ok: true };
  }

  // ----------------------------------------------------------------- voice
  /** Self-service mic toggle. A host-muted member cannot turn their own mic back on. */
  setVoiceState(code, deviceId, mic) {
    const room = this.getRoom(code);
    const member = room && room.members.get(deviceId);
    if (!member) return { error: 'not_found' };
    if (member.mutedByHost && mic) return { error: 'muted_by_host' };
    member.mic = !!mic;
    this.broadcast(room, { t: 'voice-state', id: member.id, mic: member.mic, mutedByHost: member.mutedByHost });
    return { ok: true };
  }

  /** Host-only: force a participant's mic off and block them from re-enabling it. */
  muteMember(code, deviceId, targetId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'not_found' };
    if (room.hostDeviceId !== deviceId) return { error: 'not_host' };
    const target = Array.from(room.members.values()).find(m => m.id === targetId);
    if (!target) return { error: 'bad_target' };
    target.mutedByHost = true;
    target.mic = false;
    this.broadcast(room, { t: 'voice-state', id: target.id, mic: false, mutedByHost: true });
    return { ok: true };
  }

  /** Host-only: lift a forced mute. The member must still re-enable their own mic client-side. */
  unmuteMember(code, deviceId, targetId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'not_found' };
    if (room.hostDeviceId !== deviceId) return { error: 'not_host' };
    const target = Array.from(room.members.values()).find(m => m.id === targetId);
    if (!target) return { error: 'bad_target' };
    target.mutedByHost = false;
    this.broadcast(room, { t: 'voice-state', id: target.id, mic: target.mic, mutedByHost: false });
    return { ok: true };
  }

  /** Relays WebRTC offer/answer/ice-candidate payloads between two members of the same room. Opaque to the server. */
  relaySignal(code, deviceId, targetId, data) {
    const room = this.getRoom(code);
    const sender = room && room.members.get(deviceId);
    if (!sender) return { error: 'not_found' };
    if (!sender.signalBucket.take()) return { error: 'rate' };
    const target = Array.from(room.members.values()).find(m => m.id === targetId);
    if (!target || !target.transport) return { error: 'bad_target' };
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { error: 'bad_signal' };
    try {
      target.transport.send({ t: 'signal', from: sender.id, data });
    } catch (_) { /* dead socket: its close handler cleans up */ }
    return { ok: true };
  }

  end(code, deviceId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'not_found' };
    if (room.hostDeviceId !== deviceId) return { error: 'not_host' };
    this._destroy(room, 'ended');
    return { ok: true };
  }

  // -------------------------------------------------------------- internals
  broadcast(room, msg, exceptDeviceId) {
    for (const m of room.members.values()) {
      if (!m.transport || m.deviceId === exceptDeviceId) continue;
      try { m.transport.send(msg); } catch (_) { /* dead socket: its close handler cleans up */ }
    }
  }

  _hostMember(room) {
    return room.members.get(room.hostDeviceId) || null;
  }

  _removeMember(room, member, reason) {
    if (room.closed || room.members.get(member.deviceId) !== member) return;
    this.timersClear(member);
    room.members.delete(member.deviceId);
    this.broadcast(room, { t: 'leave', id: member.id, reason });
    if (room.members.size === 0) {
      this._destroy(room, 'empty');
      return;
    }
    if (member.deviceId === room.hostDeviceId) this._transferHost(room);
  }

  _transferHost(room) {
    const candidates = Array.from(room.members.values()).sort((a, b) => a.joinedAt - b.joinedAt);
    const next = candidates.find(m => m.connected) || candidates[0];
    if (!next) return;
    this._moveHosted(room.hostDeviceId, next.deviceId);
    room.hostDeviceId = next.deviceId;
    // Keep the playback clock continuous for the new host's followers.
    this.broadcast(room, { t: 'host', id: next.id });
  }

  _moveHosted(from, to) {
    const n = (this.hosted.get(from) || 1) - 1;
    if (n <= 0) this.hosted.delete(from); else this.hosted.set(from, n);
    this.hosted.set(to, (this.hosted.get(to) || 0) + 1);
  }

  _destroy(room, reason) {
    if (room.closed) return;
    room.closed = true;
    this._clearEmptyTimer(room);
    this.broadcast(room, { t: 'closed', reason });
    for (const m of room.members.values()) {
      this.timersClear(m);
      if (m.transport) safeClose(m.transport, 1000, 'closed');
    }
    room.members.clear();
    this.rooms.delete(room.code);
    const n = (this.hosted.get(room.hostDeviceId) || 1) - 1;
    if (n <= 0) this.hosted.delete(room.hostDeviceId); else this.hosted.set(room.hostDeviceId, n);
  }

  _armEmptyTimer(room) {
    this._clearEmptyTimer(room);
    room.emptyTimer = setTimeout(() => {
      if (room.members.size === 0) this._destroy(room, 'empty');
    }, this.cfg.emptyGraceMs);
    if (room.emptyTimer.unref) room.emptyTimer.unref();
  }

  _clearEmptyTimer(room) {
    if (room.emptyTimer) clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }

  timersClear(member) {
    if (member.graceTimer) clearTimeout(member.graceTimer);
    member.graceTimer = null;
  }

  sweep(now = Date.now()) {
    for (const room of Array.from(this.rooms.values())) {
      if (now - room.createdAt > this.cfg.maxRoomAgeMs) this._destroy(room, 'expired');
    }
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const room of Array.from(this.rooms.values())) this._destroy(room, 'server_shutdown');
  }
}

function safeClose(transport, code, reason) {
  try { transport.close(code, reason); } catch (_) { /* already closed */ }
}

module.exports = { RoomManager, sanitizeMedia, DEFAULTS };
