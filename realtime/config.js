'use strict';

function int(env, name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function bool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

/** All watch-party tunables in one place, read from environment variables (see .env.example). */
function loadRoomConfig(env = process.env) {
  return {
    manager: {
      maxMembers: int(env, 'ROOMS_MAX_MEMBERS', 30, 2, 200),
      maxRooms: int(env, 'ROOMS_MAX_TOTAL', 5000, 1),
      maxRoomsPerDevice: int(env, 'ROOMS_MAX_PER_DEVICE', 2, 1, 20),
      maxRoomAgeMs: int(env, 'ROOMS_MAX_AGE_HOURS', 12, 1, 72) * 3600 * 1000,
      reconnectGraceMs: int(env, 'ROOMS_RECONNECT_GRACE_SECONDS', 45, 5, 600) * 1000,
      chatMaxLength: int(env, 'ROOMS_CHAT_MAX_LENGTH', 300, 20, 2000)
    },
    gateway: {
      maxSocketsPerDevice: int(env, 'WS_MAX_SOCKETS_PER_DEVICE', 3, 1, 20),
      connectionsPerMinutePerIp: int(env, 'WS_CONNECTIONS_PER_MINUTE_PER_IP', 60, 5),
      trustProxy: bool(env, 'TRUST_PROXY', true),
      allowedOrigins: String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
    }
  };
}

module.exports = { loadRoomConfig };
