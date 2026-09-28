'use strict';
const { WebSocketServer } = require('ws');
const { CODE_REGEX, TokenBucket, shortId } = require('./util');

const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests' };
const CLOSE_FOR_ERROR = { not_found: 4004, full: 4008, kicked: 4003 };

function reject(socket, status) {
  try {
    socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch (_) { /* ignore */ }
  socket.destroy();
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    // Behind ONE reverse proxy (nginx/caddy) the rightmost entry is the one the proxy itself added.
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function safeSend(ws, obj) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}

/**
 * Real-time endpoint:  GET /ws/rooms?code=ABC123&name=Sam   (Authorization: Bearer <access>, X-Device-ID)
 * Everything a client sends is validated and rate-limited; only the host can control playback.
 */
function attachGateway({ server, manager, authenticate, config = {}, logger = console }) {
  const cfg = Object.assign({
    path: '/ws/rooms',
    maxPayload: 4096,
    heartbeatMs: 25000,
    maxSocketsPerDevice: 3,
    connectionsPerMinutePerIp: 60,
    allowedOrigins: [],
    trustProxy: false,
    maxBufferedBytes: 512 * 1024
  }, config);

  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxPayload, perMessageDeflate: false });
  const socketsPerDevice = new Map();
  const ipBuckets = new Map();

  function allowIp(ip) {
    let bucket = ipBuckets.get(ip);
    if (!bucket) {
      bucket = new TokenBucket(cfg.connectionsPerMinutePerIp, cfg.connectionsPerMinutePerIp / 60);
      ipBuckets.set(ip, bucket);
    }
    return bucket.take();
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      if (ws.bufferedAmount > cfg.maxBufferedBytes) { ws.terminate(); continue; } // hopelessly slow client
      ws.isAlive = false;
      try { ws.ping(); } catch (_) { /* closing */ }
    }
    // forget idle per-IP buckets
    if (ipBuckets.size > 10000) ipBuckets.clear();
  }, cfg.heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => { /* handshake-phase socket errors are not actionable */ });
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (_) { return reject(socket, 400); }
    if (url.pathname !== cfg.path) return reject(socket, 404);

    const ip = clientIp(req, cfg.trustProxy);
    if (!allowIp(ip)) return reject(socket, 429);

    const origin = req.headers.origin;
    if (origin && cfg.allowedOrigins.length && !cfg.allowedOrigins.includes(origin)) return reject(socket, 403);

    const deviceId = authenticate(req);
    if (!deviceId) return reject(socket, 401);

    const code = String(url.searchParams.get('code') || '').toUpperCase();
    if (!CODE_REGEX.test(code)) return reject(socket, 400);

    if ((socketsPerDevice.get(deviceId) || 0) >= cfg.maxSocketsPerDevice) return reject(socket, 429);

    const name = url.searchParams.get('name') || '';
    wss.handleUpgrade(req, socket, head, ws => onConnection(ws, { deviceId, code, name }));
  });

  function onConnection(ws, { deviceId, code, name }) {
    socketsPerDevice.set(deviceId, (socketsPerDevice.get(deviceId) || 0) + 1);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { try { ws.terminate(); } catch (_) { /* ignore */ } });

    const transport = {
      send: obj => safeSend(ws, obj),
      close: (c, reason) => { try { ws.close(c, reason); } catch (_) { /* ignore */ } }
    };

    ws.on('close', () => {
      const n = (socketsPerDevice.get(deviceId) || 1) - 1;
      if (n <= 0) socketsPerDevice.delete(deviceId); else socketsPerDevice.set(deviceId, n);
      manager.disconnect(code, deviceId, transport);
    });

    const joined = manager.join(code, deviceId, name, transport);
    if (joined.error) {
      transport.send({ t: 'error', code: joined.error });
      ws.close(CLOSE_FOR_ERROR[joined.error] || 4000, joined.error);
      return;
    }
    logger.info && logger.info(`room ${code} ${joined.isNew ? 'join' : 'rejoin'} ${shortId(deviceId)}`);
    transport.send(manager.buildWelcome(joined.room, joined.member));

    const bucket = new TokenBucket(40, 20); // burst 40 messages, 20/s sustained
    let strikes = 0;

    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(1003, 'text only');
      if (!bucket.take()) {
        if (++strikes > 20) ws.close(4008, 'rate limit');
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch (_) { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

      switch (msg.t) {
        case 'ping':
          transport.send({ t: 'pong', c: Number.isFinite(msg.c) ? msg.c : 0, now: Date.now() });
          break;
        case 'state': {
          const r = manager.setState(code, deviceId, msg);
          if (r.error) transport.send({ t: 'error', code: r.error });
          break;
        }
        case 'chat': {
          const r = manager.chat(code, deviceId, msg.text);
          if (r.error === 'rate') transport.send({ t: 'error', code: 'rate' });
          break;
        }
        case 'kick': {
          const r = manager.kick(code, deviceId, String(msg.id || ''));
          if (r.error) transport.send({ t: 'error', code: r.error });
          break;
        }
        case 'voice-state': {
          const r = manager.setVoiceState(code, deviceId, !!msg.mic);
          if (r.error) transport.send({ t: 'error', code: r.error });
          break;
        }
        case 'mute': {
          const r = manager.muteMember(code, deviceId, String(msg.id || ''));
          if (r.error) transport.send({ t: 'error', code: r.error });
          break;
        }
        case 'unmute': {
          const r = manager.unmuteMember(code, deviceId, String(msg.id || ''));
          if (r.error) transport.send({ t: 'error', code: r.error });
          break;
        }
        case 'signal': {
          const r = manager.relaySignal(code, deviceId, String(msg.to || ''), msg.data);
          if (r.error && r.error !== 'rate') transport.send({ t: 'error', code: r.error });
          break;
        }
        case 'end': {
          const r = manager.end(code, deviceId);
          if (r.error) transport.send({ t: 'error', code: r.error });
          break;
        }
        case 'leave':
          manager.leave(code, deviceId);
          ws.close(1000, 'left');
          break;
        default:
          if (++strikes > 20) ws.close(4008, 'protocol');
      }
    });
  }

  return {
    wss,
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) { try { ws.close(1001, 'server shutting down'); } catch (_) { /* ignore */ } }
      wss.close();
    }
  };
}

module.exports = { attachGateway };
