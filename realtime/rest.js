'use strict';
const { CODE_REGEX, RateWindow } = require('./util');

const STATUS_FOR_ERROR = {
  bad_media: 400,
  too_many_rooms: 409,
  busy: 503
};

/**
 * REST side of the rooms feature. Handlers are plain (req, res) functions so they can be unit-tested
 * without Express. `req.auth.sub` is the authenticated device id set by the server's auth middleware.
 */
function createRoomHandlers({ manager }) {
  const createLimit = new RateWindow(10, 60 * 60 * 1000); // 10 rooms / hour / device
  const lookupLimit = new RateWindow(40, 60 * 1000);      // 40 lookups / minute / device (blocks code guessing)

  function fail(res, status, message) {
    return res.status(status).json({ status: 'error', message });
  }

  function create(req, res) {
    try {
      const deviceId = req.auth && req.auth.sub;
      if (!deviceId) return fail(res, 401, 'unauthorized');
      if (!createLimit.allow(deviceId)) return fail(res, 429, 'rate_limited');
      const result = manager.createRoom(deviceId, req.body && req.body.media);
      if (result.error) return fail(res, STATUS_FOR_ERROR[result.error] || 400, result.error);
      return res.status(201).json({ status: 'success', code: result.code, media: result.media });
    } catch (err) {
      return fail(res, 500, 'internal_error');
    }
  }

  function preview(req, res) {
    try {
      const deviceId = req.auth && req.auth.sub;
      if (!deviceId) return fail(res, 401, 'unauthorized');
      if (!lookupLimit.allow(deviceId)) return fail(res, 429, 'rate_limited');
      const code = String(req.params.code || '').toUpperCase();
      if (!CODE_REGEX.test(code)) return fail(res, 400, 'bad_code');
      const info = manager.peek(code);
      if (!info) return fail(res, 404, 'room_not_found');
      return res.json({ status: 'success', room: info });
    } catch (err) {
      return fail(res, 500, 'internal_error');
    }
  }

  return { create, preview, stop() { createLimit.stop(); lookupLimit.stop(); } };
}

function registerRoomRoutes(app, express, manager) {
  const handlers = createRoomHandlers({ manager });
  const router = express.Router();
  router.post('/', handlers.create);
  router.get('/:code', handlers.preview);
  app.use('/api/rooms', router);
  return handlers;
}

module.exports = { createRoomHandlers, registerRoomRoutes };
