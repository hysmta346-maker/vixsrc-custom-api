'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRoomConfig } = require('../realtime/config');

test('defaults are sane', () => {
  const c = loadRoomConfig({});
  assert.equal(c.manager.maxMembers, 30);
  assert.equal(c.manager.reconnectGraceMs, 45000);
  assert.equal(c.gateway.trustProxy, true);
  assert.deepEqual(c.gateway.allowedOrigins, []);
});

test('env overrides and validation', () => {
  const c = loadRoomConfig({ ROOMS_MAX_MEMBERS: '10', TRUST_PROXY: 'false', ALLOWED_ORIGINS: 'https://a.x, https://b.x' });
  assert.equal(c.manager.maxMembers, 10);
  assert.equal(c.gateway.trustProxy, false);
  assert.deepEqual(c.gateway.allowedOrigins, ['https://a.x', 'https://b.x']);
  assert.throws(() => loadRoomConfig({ ROOMS_MAX_MEMBERS: 'abc' }), /ROOMS_MAX_MEMBERS/);
  assert.throws(() => loadRoomConfig({ ROOMS_MAX_MEMBERS: '99999' }), /ROOMS_MAX_MEMBERS/);
});
