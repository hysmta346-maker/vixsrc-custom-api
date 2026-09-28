'use strict';
/**
 * Local / VPS entry point for the real vixsrc-custom-api project.
 *
 *   node start.js          (Termux, a VPS, systemd, PM2, Docker - anywhere Node runs as ONE process)
 *
 * api/index.js is untouched and still works as-is on Vercel (vercel.json routes straight to it).
 * This file adds what Vercel's serverless functions cannot do: a real persistent process with a
 * WebSocket gateway for watch-party rooms, plus graceful shutdown.
 */
require('dotenv').config();

const http = require('http');
const log = require('./realtime/logger');
const express = require('express');
const app = require('./api/index.js');
const { RoomManager } = require('./realtime/rooms');
const { registerRoomRoutes } = require('./realtime/rest');
const { attachGateway } = require('./realtime/gateway');
const { loadRoomConfig } = require('./realtime/config');

const config = loadRoomConfig(process.env);
const manager = new RoomManager(config.manager);
const restHandlers = registerRoomRoutes(app, express, manager);

const server = http.createServer(app);
server.keepAliveTimeout = 65 * 1000;   // longer than typical proxy idle timeouts (avoids sporadic 502s)
server.headersTimeout = 66 * 1000;

const gateway = attachGateway({
  server,
  manager,
  authenticate: app.authenticateUpgrade,
  config: config.gateway,
  logger: { info: msg => log.info(msg) }
});

const port = parseInt(process.env.PORT, 10) || 5000;
const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => log.info('server listening', { host, port, node: process.version }));

const statsTimer = setInterval(() => log.info('rooms', manager.stats()), 5 * 60 * 1000);
statsTimer.unref();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  manager.shutdown();   // tells every room member the server is going away
  gateway.close();
  restHandlers.stop();
  server.close(() => process.exit(0));
  if (server.closeIdleConnections) server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', reason => log.error('unhandledRejection', { reason: String((reason && reason.stack) || reason) }));
process.on('uncaughtException', err => {
  log.error('uncaughtException', { error: String((err && err.stack) || err) });
  shutdown('uncaughtException');   // state may be corrupt: let the supervisor restart a clean process
});
