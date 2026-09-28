'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager, sanitizeMedia } = require('../realtime/rooms');
const { cleanText, TokenBucket, CODE_REGEX } = require('../realtime/util');

const MOVIE = { VID: 'tt123', TITLE: 'Test Movie', IMG: 'https://x.test/p.jpg', TYPE: 'movie' };
const EPISODE = { VID: 'ep1', TMDB_ID: '1399', TITLE: 'Show', TYPE: 'tv', SEASON: 1, EPISODE: 2 };

function fakeTransport() {
  const t = { sent: [], closed: null, send(m) { t.sent.push(m); }, close(code, reason) { t.closed = [code, reason]; } };
  return t;
}
const types = t => t.sent.map(m => m.t);
function mgr(opts) { return new RoomManager(Object.assign({ reconnectGraceMs: 40, emptyGraceMs: 60 }, opts)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('room codes are well formed and unambiguous', () => {
  const m = mgr();
  for (let i = 0; i < 50; i++) {
    const r = m.createRoom('dev' + i, MOVIE);
    assert.match(r.code, CODE_REGEX);
    assert.doesNotMatch(r.code, /[01OIL]/);
  }
  m.shutdown();
});

test('media is sanitized: unknown keys dropped, bad urls removed, tv needs season/episode', () => {
  const ok = sanitizeMedia({ ...MOVIE, evil: '<script>', IMG: 'javascript:alert(1)' });
  assert.equal(ok.evil, undefined);
  assert.equal(ok.IMG, undefined);
  assert.equal(sanitizeMedia({ TYPE: 'movie' }), null);                     // no VID
  assert.equal(sanitizeMedia({ VID: 'x', TYPE: 'tv' }), null);              // tv without ids
  assert.equal(sanitizeMedia({ VID: 'x', TYPE: 'live' }), null);            // unknown type
  assert.equal(sanitizeMedia('nope'), null);
  assert.equal(sanitizeMedia(EPISODE).SEASON, 1);
  assert.equal(sanitizeMedia({ ...MOVIE, TITLE: 'a'.repeat(1000) }).TITLE.length, 200);
});

test('cleanText strips control and bidi-override characters and limits length', () => {
  assert.equal(cleanText('hi\u202Ethere\u0000!', 50), 'hi there !');
  assert.equal(cleanText('  a   b  ', 10), 'a b');
  assert.equal(cleanText('😀😀😀😀', 2), '😀😀');
  assert.equal(cleanText(42, 10), '');
});

test('token bucket refills over time', () => {
  const b = new TokenBucket(2, 1, 0);
  assert.ok(b.take(0)); assert.ok(b.take(0)); assert.equal(b.take(0), false);
  assert.ok(b.take(1500));
});

test('create -> join -> welcome lists members, first joiner is host', () => {
  const m = mgr();
  const { code } = m.createRoom('host', MOVIE);
  const th = fakeTransport(), tg = fakeTransport();
  const h = m.join(code, 'host', 'Hana', th);
  const g = m.join(code, 'guest', 'Gus', tg);
  assert.ok(h.member.id !== 'host', 'public id must not be the device id');
  const w = m.buildWelcome(g.room, g.member);
  assert.equal(w.you.host, false);
  assert.equal(w.room.members.length, 2);
  assert.equal(w.room.hostId, h.member.id);
  assert.deepEqual(types(th), ['join']);               // host was told about the guest
  assert.ok(!JSON.stringify(w).includes('"guest"'));   // no device ids leak
  m.shutdown();
});

test('only the host can set playback state; guests receive it', () => {
  const m = mgr();
  const { code } = m.createRoom('host', MOVIE);
  const th = fakeTransport(), tg = fakeTransport();
  m.join(code, 'host', 'H', th); m.join(code, 'guest', 'G', tg);
  assert.equal(m.setState(code, 'guest', { playing: true, pos: 1000 }).error, 'not_host');
  assert.equal(m.setState(code, 'host', { playing: true, pos: -5 }).error, 'bad_state');
  assert.equal(m.setState(code, 'host', { playing: true, pos: 'x' }).error, 'bad_state');
  assert.ok(m.setState(code, 'host', { playing: true, pos: 61234, rate: 99 }).ok);
  const st = tg.sent.filter(x => x.t === 'state').pop();
  assert.equal(st.playing, true); assert.equal(st.pos, 61234); assert.equal(st.rate, 4); assert.equal(st.seq, 1);
  assert.equal(th.sent.filter(x => x.t === 'state').length, 0, 'sender does not get an echo');
  m.shutdown();
});

test('chat: broadcast to everyone, sanitized, rate limited, history kept', () => {
  const m = mgr({ chatBurst: 3, chatRefillPerSec: 0.0001 });
  const { code } = m.createRoom('host', MOVIE);
  const th = fakeTransport(), tg = fakeTransport();
  m.join(code, 'host', 'H', th); m.join(code, 'guest', 'G', tg);
  assert.ok(m.chat(code, 'guest', 'hello\u202E world').ok);
  assert.equal(th.sent.pop().text, 'hello world');
  assert.equal(tg.sent.filter(x => x.t === 'chat').length, 1, 'sender sees the confirmed message too');
  assert.equal(m.chat(code, 'guest', '   ').error, 'empty');
  m.chat(code, 'guest', 'two'); m.chat(code, 'guest', 'three');
  assert.equal(m.chat(code, 'guest', 'four').error, 'rate');
  const late = fakeTransport();
  const j = m.join(code, 'late', 'L', late);
  assert.equal(m.buildWelcome(j.room, j.member).history.length, 3);
  m.shutdown();
});

test('room fills up and rejects extra members; unknown/kicked handled', () => {
  const m = mgr({ maxMembers: 2 });
  const { code } = m.createRoom('host', MOVIE);
  m.join(code, 'host', 'H', fakeTransport());
  const tg = fakeTransport();
  const g = m.join(code, 'g1', 'G', tg);
  assert.equal(m.join(code, 'g2', 'X', fakeTransport()).error, 'full');
  assert.equal(m.join('ZZZZZZ', 'g3', 'X', fakeTransport()).error, 'not_found');
  assert.equal(m.kick(code, 'g1', g.member.id).error, 'not_host');
  assert.ok(m.kick(code, 'host', g.member.id).ok);
  assert.deepEqual(tg.closed, [4003, 'kicked']);
  assert.equal(m.join(code, 'g1', 'G', fakeTransport()).error, 'kicked');
  m.shutdown();
});

test('reconnect within grace keeps the seat; replaced socket is closed', async () => {
  const m = mgr({ reconnectGraceMs: 80 });
  const { code } = m.createRoom('host', MOVIE);
  const th = fakeTransport();
  m.join(code, 'host', 'H', th);
  const t1 = fakeTransport(), t2 = fakeTransport();
  const g = m.join(code, 'g', 'G', t1);
  m.disconnect(code, 'g', t1);
  await sleep(20);
  const again = m.join(code, 'g', 'G', t2);
  assert.equal(again.isNew, false);
  assert.equal(again.member.id, g.member.id);
  await sleep(120);
  assert.equal(m.getRoom(code).members.size, 2, 'seat survived the grace period');
  const t3 = fakeTransport();
  m.join(code, 'g', 'G', t3);
  assert.deepEqual(t2.closed, [4001, 'replaced']);
  m.shutdown();
});

test('a stale socket closing after a reconnect does not evict the member', () => {
  const m = mgr({ reconnectGraceMs: 10 });
  const { code } = m.createRoom('host', MOVIE);
  m.join(code, 'host', 'H', fakeTransport());
  const old = fakeTransport(), fresh = fakeTransport();
  m.join(code, 'g', 'G', old);
  m.join(code, 'g', 'G', fresh);
  m.disconnect(code, 'g', old); // late close event of the replaced socket
  return sleep(40).then(() => {
    assert.equal(m.getRoom(code).members.size, 2);
    m.shutdown();
  });
});

test('host timing out hands the room to the longest-present member', async () => {
  const m = mgr({ reconnectGraceMs: 30 });
  const { code } = m.createRoom('host', MOVIE);
  const th = fakeTransport(), t1 = fakeTransport(), t2 = fakeTransport();
  m.join(code, 'host', 'H', th);
  const g1 = m.join(code, 'g1', 'G1', t1);
  await sleep(5);
  m.join(code, 'g2', 'G2', t2);
  m.disconnect(code, 'host', th);
  await sleep(80);
  assert.ok(t1.sent.some(x => x.t === 'host' && x.id === g1.member.id));
  assert.ok(m.setState(code, 'g1', { playing: false, pos: 5 }).ok, 'new host can control playback');
  assert.equal(m.setState(code, 'g2', { playing: false, pos: 5 }).error, 'not_host');
  m.shutdown();
});

test('explicit leave by the last member destroys the room; end() closes for all', () => {
  const m = mgr();
  const a = m.createRoom('h1', MOVIE);
  m.join(a.code, 'h1', 'H', fakeTransport());
  m.leave(a.code, 'h1');
  assert.equal(m.getRoom(a.code), null);

  const b = m.createRoom('h2', MOVIE);
  const th = fakeTransport(), tg = fakeTransport();
  m.join(b.code, 'h2', 'H', th); m.join(b.code, 'g', 'G', tg);
  assert.equal(m.end(b.code, 'g').error, 'not_host');
  assert.ok(m.end(b.code, 'h2').ok);
  assert.ok(types(tg).includes('closed'));
  assert.deepEqual(tg.closed, [1000, 'closed']);
  assert.equal(m.getRoom(b.code), null);
  m.shutdown();
});

test('limits: rooms per device, empty rooms expire, hosted counter is released', async () => {
  const m = mgr({ maxRoomsPerDevice: 2, emptyGraceMs: 30 });
  const a = m.createRoom('dev', MOVIE), b = m.createRoom('dev', MOVIE);
  assert.ok(a.code && b.code);
  assert.equal(m.createRoom('dev', MOVIE).error, 'too_many_rooms');
  assert.equal(m.createRoom('dev', { TYPE: 'movie' }).error, 'bad_media');
  await sleep(80);                       // nobody joined -> both expire
  assert.equal(m.stats().rooms, 0);
  assert.ok(m.createRoom('dev', MOVIE).code);
  m.shutdown();
});

test('sweep removes rooms older than the max age', () => {
  const m = mgr({ maxRoomAgeMs: 1000 });
  const { code } = m.createRoom('h', MOVIE);
  m.join(code, 'h', 'H', fakeTransport());
  m.sweep(Date.now() + 5000);
  assert.equal(m.getRoom(code), null);
  m.shutdown();
});

// -------------------------------------------------------------- voice & moderation

test('self mic toggle broadcasts voice-state and is reflected in welcome/join payloads', () => {
  const m = mgr();
  const { code } = m.createRoom('h', MOVIE);
  const hostT = fakeTransport();
  const { member: host } = m.join(code, 'h', 'Host', hostT);
  const guestT = fakeTransport();
  const guestJoin = m.join(code, 'g', 'Guest', guestT);
  assert.equal(guestJoin.member.mic, false);

  const r = m.setVoiceState(code, 'h', true);
  assert.equal(r.ok, true);
  const last = guestT.sent[guestT.sent.length - 1];
  assert.equal(last.t, 'voice-state');
  assert.equal(last.id, host.id);
  assert.equal(last.mic, true);

  const welcome = m.buildWelcome(m.getRoom(code), guestJoin.member);
  const hostEntry = welcome.room.members.find(x => x.id === host.id);
  assert.equal(hostEntry.mic, true);
  assert.equal(hostEntry.mutedByHost, false);
  m.shutdown();
});

test('host mute forces mic off and blocks the target from re-enabling it themselves', () => {
  const m = mgr();
  const { code } = m.createRoom('h', MOVIE);
  m.join(code, 'h', 'Host', fakeTransport());
  const { member: guest } = m.join(code, 'g', 'Guest', fakeTransport());
  m.setVoiceState(code, 'g', true);

  const r = m.muteMember(code, 'h', guest.id);
  assert.equal(r.ok, true);
  assert.equal(guest.mic, false);
  assert.equal(guest.mutedByHost, true);

  const blocked = m.setVoiceState(code, 'g', true);
  assert.equal(blocked.error, 'muted_by_host');
  assert.equal(guest.mic, false);
  m.shutdown();
});

test('host unmute lifts the block but does not itself turn the mic on', () => {
  const m = mgr();
  const { code } = m.createRoom('h', MOVIE);
  m.join(code, 'h', 'Host', fakeTransport());
  const { member: guest } = m.join(code, 'g', 'Guest', fakeTransport());
  m.muteMember(code, 'h', guest.id);

  const r = m.unmuteMember(code, 'h', guest.id);
  assert.equal(r.ok, true);
  assert.equal(guest.mutedByHost, false);
  assert.equal(guest.mic, false); // still off until the user re-enables it

  assert.equal(m.setVoiceState(code, 'g', true).ok, true);
  assert.equal(guest.mic, true);
  m.shutdown();
});

test('only the host can mute/unmute; guests are rejected', () => {
  const m = mgr();
  const { code } = m.createRoom('h', MOVIE);
  m.join(code, 'h', 'Host', fakeTransport());
  const { member: guest } = m.join(code, 'g', 'Guest', fakeTransport());
  const { member: other } = m.join(code, 'o', 'Other', fakeTransport());

  assert.equal(m.muteMember(code, 'g', other.id).error, 'not_host');
  assert.equal(m.unmuteMember(code, 'g', other.id).error, 'not_host');
  assert.equal(guest.mutedByHost, false);
  m.shutdown();
});

test('disconnect clears mic state so followers see the participant go silent', () => {
  const m = mgr({ reconnectGraceMs: 5000 });
  const { code } = m.createRoom('h', MOVIE);
  m.join(code, 'h', 'Host', fakeTransport());
  const guestT = fakeTransport();
  const { member: guest } = m.join(code, 'g', 'Guest', guestT);
  m.setVoiceState(code, 'g', true);
  assert.equal(guest.mic, true);

  m.disconnect(code, 'g', guestT);
  assert.equal(guest.mic, false);
  m.shutdown();
});

test('signaling relays opaque WebRTC payloads only to the named target in the same room', () => {
  const m = mgr();
  const { code } = m.createRoom('h', MOVIE);
  m.join(code, 'h', 'Host', fakeTransport());
  const guestT = fakeTransport();
  const { member: guest } = m.join(code, 'g', 'Guest', guestT);

  const r = m.relaySignal(code, 'h', guest.id, { type: 'offer', sdp: 'v=0...' });
  assert.equal(r.ok, true);
  const last = guestT.sent[guestT.sent.length - 1];
  assert.equal(last.t, 'signal');
  assert.deepEqual(last.data, { type: 'offer', sdp: 'v=0...' });

  assert.equal(m.relaySignal(code, 'h', 'nope', { type: 'offer' }).error, 'bad_target');
  assert.equal(m.relaySignal(code, 'h', guest.id, 'not-an-object').error, 'bad_signal');
  m.shutdown();
});
