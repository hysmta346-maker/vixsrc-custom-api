'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');

function freePort() {
  return new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('start.js: boots, serves REST + WebSocket, shuts down gracefully on SIGTERM', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fake-deps.js'), path.join(__dirname, '..', 'start.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const exited = new Promise(r => child.on('exit', (code, sig) => r({ code, sig })));

  try {
    for (let i = 0; i < 50 && !out.includes('server listening'); i++) await sleep(50);
    assert.ok(out.includes('server listening'), 'server did not start: ' + err);

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);

    const headers = { 'X-Device-ID': 'hostdev', 'Content-Type': 'application/json' };
    const bad = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST', headers, body: JSON.stringify({ media: { TYPE: 'movie' } }) });
    assert.equal(bad.status, 400);
    const created = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST', headers, body: JSON.stringify({ media: { VID: 'tt1', TITLE: 'T', TYPE: 'movie' } }) });
    assert.equal(created.status, 201);
    const { code } = await created.json();
    const peek = await fetch(`http://127.0.0.1:${port}/api/rooms/${code}`, { headers });
    assert.equal(peek.status, 200);

    const msgs = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/rooms?code=${code}&name=Host`, {
      headers: { Authorization: 'Bearer good-hostdev', 'X-Device-ID': 'hostdev' }
    });
    const closed = new Promise(r => ws.on('close', c => r(c)));
    ws.on('message', d => msgs.push(JSON.parse(d.toString())));
    ws.on('error', () => {});
    for (let i = 0; i < 50 && !msgs.length; i++) await sleep(20);
    assert.equal(msgs[0].t, 'welcome');
    assert.equal(msgs[0].you.host, true);

    child.kill('SIGTERM');
    const result = await exited;
    assert.equal(result.code, 0, 'graceful shutdown exits 0');
    await closed;
    assert.ok(msgs.some(m => m.t === 'closed' && m.reason === 'server_shutdown'), 'members are told the server is going away');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
