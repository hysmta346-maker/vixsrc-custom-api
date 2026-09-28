'use strict';
// Test-only preload: replaces `express` and `../api/index.js` (which need packages not installed in
// the sandbox, and hard-required env vars) with tiny fakes so start.js's wiring (REST mount, WS
// gateway, shutdown) can be exercised for real, without needing a live database or real secrets.
const Module = require('module');
const path = require('path');

const routes = [];
function fakeExpress() { throw new Error('not used'); }
const fakeDotenv = { config: () => ({}) };
fakeExpress.Router = () => {
  const r = { stack: [] };
  r.post = (p, fn) => r.stack.push(['POST', p, fn]);
  r.get = (p, fn) => r.stack.push(['GET', p, fn]);
  return r;
};

const app = function (req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.end('{"ok":true}'); return; }
  const mount = routes.find(([p]) => url.pathname.startsWith(p));
  if (!mount) { res.statusCode = 404; res.end(); return; }
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    req.body = body ? JSON.parse(body) : {};
    req.auth = { sub: String(req.headers['x-device-id'] || '') };
    const rest = url.pathname.slice(mount[0].length).replace(/^\//, '');
    const hit = mount[1].stack.find(([m, p]) => m === req.method && (p === '/' ? rest === '' : rest !== ''));
    if (!hit) { res.statusCode = 404; res.end(); return; }
    req.params = { code: rest };
    res.status = c => { res.statusCode = c; return res; };
    res.json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    hit[2](req, res);
  });
};
app.use = (p, router) => routes.push([p, router]);
app.authenticateUpgrade = req => {
  const m = /^Bearer good-(\w+)$/.exec(req.headers.authorization || '');
  return m && req.headers['x-device-id'] === m[1] ? m[1] : null;
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'express') return fakeExpress;
  if (request === 'dotenv') return fakeDotenv;
  if (request === './api/index.js' && parent && parent.filename === path.join(__dirname, '..', 'start.js')) return app;
  return origLoad.apply(this, arguments);
};
