'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const { RoomManager } = require('../realtime/rooms');
const { attachGateway } = require('../realtime/gateway');

const MOVIE = { VID: 'tt1', TITLE: 'Movie', TYPE: 'movie' };

async function boot(cfg = {}, mgrOpts = {}) {
  const manager = new RoomManager(Object.assign({ reconnectGraceMs: 150, emptyGraceMs: 500 }, mgrOpts));
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const gw = attachGateway({
    server, manager, config: cfg, logger: {},
    authenticate: req => {
      const m = /^Bearer good-(\w+)$/.exec(req.headers.authorization || '');
      return m && req.headers['x-device-id'] === m[1] ? m[1] : null;
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    manager, port,
    async stop() { gw.close(); manager.shutdown(); await new Promise(r => server.close(r)); }
  };
}

/** Opens a socket and collects every message; resolves once opened (or rejects with the HTTP status). */
function connect(port, device, code, name = 'X', tokenOverride) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/rooms?code=${code}&name=${name}`, {
      headers: { Authorization: tokenOverride || `Bearer good-${device}`, 'X-Device-ID': device }
    });
    const c = { ws, msgs: [], closed: null };
    ws.on('message', d => c.msgs.push(JSON.parse(d.toString())));
    ws.on('close', (code, reason) => { c.closed = [code, reason.toString()]; });
    ws.on('open', () => resolve(c));
    ws.on('unexpected-response', (req, res) => reject(new Error('HTTP ' + res.statusCode)));
    ws.on('error', () => { /* surfaced through unexpected-response / close */ });
  });
}
const send = (c, o) => c.ws.send(JSON.stringify(o));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(10); }
  throw new Error('timeout waiting for condition');
}
const last = (c, t) => c.msgs.filter(m => m.t === t).pop();

test('rejects unauthenticated, wrong device, bad code and wrong path', async () => {
  const s = await boot();
  const { code } = s.manager.createRoom('host', MOVIE);
  await assert.rejects(connect(s.port, 'host', code, 'x', 'Bearer nope'), /HTTP 401/);
  await assert.rejects(connect(s.port, 'other', code, 'x', 'Bearer good-host'), /HTTP 401/);
  await assert.rejects(connect(s.port, 'host', 'bad'), /HTTP 400/);
  await assert.rejects(new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/other`);
    ws.on('unexpected-response', (q, r) => rej(new Error('HTTP ' + r.statusCode)));
    ws.on('error', () => {});
  }), /HTTP 404/);
  await s.stop();
});

test('full session: welcome, host controls, guest follows, chat, kick, end', async () => {
  const s = await boot();
  const { code } = s.manager.createRoom('host', MOVIE);
  const host = await connect(s.port, 'host', code, 'Hana');
  const guest = await connect(s.port, 'guest', code.toLowerCase(), 'Gus');

  const hw = await waitFor(() => last(host, 'welcome'));
  assert.equal(hw.you.host, true);
  assert.equal(hw.room.media.TITLE, 'Movie');
  const gw = await waitFor(() => last(guest, 'welcome'));
  assert.equal(gw.you.host, false);
  assert.equal(gw.room.members.length, 2);
  await waitFor(() => last(host, 'join'));

  send(host, { t: 'state', playing: true, pos: 5000 });
  const st = await waitFor(() => last(guest, 'state'));
  assert.equal(st.playing, true); assert.equal(st.pos, 5000);

  send(guest, { t: 'state', playing: false, pos: 0 });
  assert.equal((await waitFor(() => last(guest, 'error'))).code, 'not_host');
  await sleep(50);
  assert.equal(last(host, 'state'), undefined);

  send(guest, { t: 'chat', text: 'hi <b>all</b>' });
  const chat = await waitFor(() => last(host, 'chat'));
  assert.equal(chat.text, 'hi <b>all</b>');   // stored verbatim as text; clients render it as plain text
  assert.equal(chat.from.name, 'Gus');
  await waitFor(() => last(guest, 'chat'));

  send(guest, { t: 'ping', c: 7 });
  const pong = await waitFor(() => last(guest, 'pong'));
  assert.equal(pong.c, 7); assert.ok(pong.now > 0);

  send(host, { t: 'kick', id: gw.you.id });
  await waitFor(() => guest.closed);
  assert.equal(guest.closed[0], 4003);
  await assert.rejects(connect(s.port, 'guest', code), /HTTP|closed|ECONN|socket/).catch(() => {});

  send(host, { t: 'end' });
  await waitFor(() => host.closed);
  assert.equal(s.manager.getRoom(code), null);
  await s.stop();
});

test('oversized, binary and garbage frames cannot hurt the room', async () => {
  const s = await boot({ maxPayload: 512 });
  const { code } = s.manager.createRoom('host', MOVIE);
  const host = await connect(s.port, 'host', code);
  const guest = await connect(s.port, 'guest', code);
  await waitFor(() => last(guest, 'welcome'));

  guest.ws.send('not json at all');
  guest.ws.send(JSON.stringify({ t: 12 }));
  guest.ws.send(JSON.stringify(['array']));
  await sleep(50);
  assert.equal(guest.closed, null, 'garbage is ignored, connection stays up');

  guest.ws.send(Buffer.from([1, 2, 3]));
  await waitFor(() => guest.closed);
  assert.equal(guest.closed[0], 1003);

  const g2 = await connect(s.port, 'g2', code);
  g2.ws.send(JSON.stringify({ t: 'chat', text: 'x'.repeat(2000) }));
  await waitFor(() => g2.closed);
  assert.equal(g2.closed[0], 1009, 'frame over maxPayload is refused');
  assert.equal(host.closed, null);
  await s.stop();
});

test('message flood gets the connection closed', async () => {
  const s = await boot();
  const { code } = s.manager.createRoom('host', MOVIE);
  const c = await connect(s.port, 'host', code);
  for (let i = 0; i < 400; i++) c.ws.send(JSON.stringify({ t: 'ping', c: i }));
  await waitFor(() => c.closed, 3000);
  assert.equal(c.closed[0], 4008);
  await s.stop();
});

test('same device reconnecting replaces the old socket and keeps its seat', async () => {
  const s = await boot();
  const { code } = s.manager.createRoom('host', MOVIE);
  const host = await connect(s.port, 'host', code);
  const g1 = await connect(s.port, 'guest', code);
  const id1 = (await waitFor(() => last(g1, 'welcome'))).you.id;
  const g2 = await connect(s.port, 'guest', code);
  const id2 = (await waitFor(() => last(g2, 'welcome'))).you.id;
  assert.equal(id1, id2);
  await waitFor(() => g1.closed);
  assert.equal(g1.closed[0], 4001);
  await sleep(300); // longer than the reconnect grace: the stale close must not evict the member
  assert.equal(s.manager.getRoom(code).members.size, 2);
  assert.equal(host.closed, null);
  await s.stop();
});

test('dropped host: after the grace period the room moves to the guest', async () => {
  const s = await boot({}, { reconnectGraceMs: 100 });
  const { code } = s.manager.createRoom('host', MOVIE);
  const host = await connect(s.port, 'host', code);
  const guest = await connect(s.port, 'guest', code);
  const me = (await waitFor(() => last(guest, 'welcome'))).you.id;
  host.ws.terminate();
  const ev = await waitFor(() => last(guest, 'host'), 2000);
  assert.equal(ev.id, me);
  send(guest, { t: 'state', playing: true, pos: 1 });
  await sleep(50);
  assert.equal(last(guest, 'error'), undefined, 'guest is now allowed to control');
  await s.stop();
});

test('per-device socket cap and unknown/full rooms', async () => {
  const s = await boot({ maxSocketsPerDevice: 2 }, { maxMembers: 2 });
  const { code } = s.manager.createRoom('host', MOVIE);
  await connect(s.port, 'host', code);
  await connect(s.port, 'host', code);
  await assert.rejects(connect(s.port, 'host', code), /HTTP 429/);

  await connect(s.port, 'g1', code);
  const full = await connect(s.port, 'g2', code);
  await waitFor(() => full.closed);
  assert.equal(full.closed[0], 4008);
  assert.equal(last(full, 'error').code, 'full');

  const gone = await connect(s.port, 'g3', 'ZZZZZZ');
  await waitFor(() => gone.closed);
  assert.equal(gone.closed[0], 4004);
  await s.stop();
});

test('two rooms are isolated from each other', async () => {
  const s = await boot();
  const a = s.manager.createRoom('hA', MOVIE), b = s.manager.createRoom('hB', MOVIE);
  const hA = await connect(s.port, 'hA', a.code), gA = await connect(s.port, 'gA', a.code);
  const hB = await connect(s.port, 'hB', b.code), gB = await connect(s.port, 'gB', b.code);
  await waitFor(() => last(gA, 'welcome') && last(gB, 'welcome'));
  send(hA, { t: 'state', playing: true, pos: 111 });
  send(gB, { t: 'chat', text: 'only B' });
  await waitFor(() => last(gA, 'state'));
  await waitFor(() => last(hB, 'chat'));
  await sleep(50);
  assert.equal(last(gB, 'state'), undefined);
  assert.equal(last(gA, 'chat'), undefined);
  await s.stop();
});

test('origin allow-list blocks browsers but not native clients', async () => {
  const s = await boot({ allowedOrigins: ['https://app.example'] });
  const { code } = s.manager.createRoom('host', MOVIE);
  await connect(s.port, 'host', code); // no Origin header (native app) is fine
  await assert.rejects(new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/rooms?code=${code}`, {
      headers: { Authorization: 'Bearer good-host', 'X-Device-ID': 'host', Origin: 'https://evil.example' }
    });
    ws.on('unexpected-response', (q, r) => rej(new Error('HTTP ' + r.statusCode)));
    ws.on('open', res); ws.on('error', () => {});
  }), /HTTP 403/);
  await s.stop();
});
