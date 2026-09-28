'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager } = require('../realtime/rooms');
const { createRoomHandlers } = require('../realtime/rest');

function res() {
  const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } };
  return r;
}
const MOVIE = { VID: 'tt1', TITLE: 'M', TYPE: 'movie' };

test('POST creates a room, GET previews it, bad input is rejected', () => {
  const manager = new RoomManager();
  const h = createRoomHandlers({ manager });
  const auth = { sub: 'dev1' };

  const bad = res(); h.create({ auth, body: { media: { TYPE: 'movie' } } }, bad);
  assert.equal(bad.code, 400);

  const anon = res(); h.create({ body: { media: MOVIE } }, anon);
  assert.equal(anon.code, 401);

  const ok = res(); h.create({ auth, body: { media: MOVIE } }, ok);
  assert.equal(ok.code, 201);
  assert.match(ok.body.code, /^[A-Z2-9]{6}$/);

  const view = res(); h.preview({ auth: { sub: 'dev2' }, params: { code: ok.body.code.toLowerCase() } }, view);
  assert.equal(view.code, 200);
  assert.equal(view.body.room.media.TITLE, 'M');
  assert.equal(JSON.stringify(view.body).includes('dev1'), false, 'no device ids in previews');

  const missing = res(); h.preview({ auth, params: { code: 'ZZZZZZ' } }, missing);
  assert.equal(missing.code, 404);
  const junk = res(); h.preview({ auth, params: { code: '<script>' } }, junk);
  assert.equal(junk.code, 400);
  h.stop(); manager.shutdown();
});

test('rate limits: room creation and code guessing', () => {
  const manager = new RoomManager({ maxRoomsPerDevice: 100 });
  const h = createRoomHandlers({ manager });
  const auth = { sub: 'spammer' };
  let last;
  for (let i = 0; i < 11; i++) { last = res(); h.create({ auth, body: { media: MOVIE } }, last); }
  assert.equal(last.code, 429);
  let g;
  for (let i = 0; i < 41; i++) { g = res(); h.preview({ auth: { sub: 'guesser' }, params: { code: 'ZZZZZZ' } }, g); }
  assert.equal(g.code, 429);
  h.stop(); manager.shutdown();
});
