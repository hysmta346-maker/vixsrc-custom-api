'use strict';
// Extracts and unit-tests getGithubRoot/getGithubFileUrl/getGithubUrls straight out of api/index.js
// source text (the real functions can't be required in isolation: the top of that file throws
// without JWT_SECRET/SUBDL_API_KEY, and requires packages this sandbox doesn't have installed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
const start = src.indexOf('function getGithubRoot()');
const end = src.indexOf('app.get(\'/api/config\'');
const snippet = src.slice(start, end) + '\nmodule.exports = { getGithubRoot, getGithubFileUrl, getGithubUrls };';

function loadWithEnv(env) {
  const sandbox = { process: { env }, module: { exports: {} }, require, console };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox);
  return sandbox.module.exports;
}

const FULL_ENV = {
  GITHUB_RAW_BASE: 'https://raw.githubusercontent.com/',
  GITHUB_USER: 'hhhhhhhh798',
  GITHUB_REPO: 'stream-master-config',
  GITHUB_BRANCH: 'main'
};

test('missing repo coordinates -> every URL is empty (no partial/broken links)', () => {
  const { getGithubUrls } = loadWithEnv({});
  const urls = getGithubUrls();
  for (const v of Object.values(urls)) assert.equal(v, '');
});

test('full coordinates + defaults -> every field matches the app-side fallback paths exactly', () => {
  const { getGithubUrls } = loadWithEnv(FULL_ENV);
  const urls = getGithubUrls();
  const root = 'https://raw.githubusercontent.com/hhhhhhhh798/stream-master-config/main/';
  assert.equal(urls.base, root);
  assert.equal(urls.provider, root + 'github/provider.json');
  assert.equal(urls.callback, root + 'github/callback.json');
  assert.equal(urls.host, root + 'github/host.json');
  assert.equal(urls.config, root + 'github/config.json');
  assert.equal(urls.subs, root + 'github/subs.json');
  assert.equal(urls.providersDir, root + 'github/providers/');
  assert.equal(urls.signatures, root + 'github/provider-signatures.json');
  assert.equal(urls.update, root + 'github/update.json');
});

test('a per-file env var overrides just that one path', () => {
  const { getGithubUrls } = loadWithEnv({ ...FULL_ENV, GITHUB_PROVIDER_JSON: 'custom/list.json' });
  assert.equal(getGithubUrls().provider, 'https://raw.githubusercontent.com/hhhhhhhh798/stream-master-config/main/custom/list.json');
  assert.equal(getGithubUrls().callback, 'https://raw.githubusercontent.com/hhhhhhhh798/stream-master-config/main/github/callback.json');
});

test('a per-file env var can be a full URL, bypassing the repo root entirely', () => {
  const { getGithubUrls } = loadWithEnv({ ...FULL_ENV, GITHUB_UPDATE_JSON: 'https://example.com/update.json' });
  assert.equal(getGithubUrls().update, 'https://example.com/update.json');
});

test('user/repo/branch are URL-encoded (special characters in a fork name, say, do not break the URL)', () => {
  const { getGithubRoot } = loadWithEnv({ ...FULL_ENV, GITHUB_BRANCH: 'feature/x' });
  assert.equal(getGithubRoot(), 'https://raw.githubusercontent.com/hhhhhhhh798/stream-master-config/feature%2Fx/');
});

test('trailing slashes on GITHUB_RAW_BASE do not produce a double slash', () => {
  const { getGithubRoot } = loadWithEnv({ ...FULL_ENV, GITHUB_RAW_BASE: 'https://raw.githubusercontent.com///' });
  assert.equal(getGithubRoot(), 'https://raw.githubusercontent.com/hhhhhhhh798/stream-master-config/main/');
});
