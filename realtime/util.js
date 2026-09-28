'use strict';
const crypto = require('crypto');

// Room codes avoid look-alike characters (no 0/O, 1/I/L) so they are easy to read out loud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_REGEX = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/;

function randomCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

// C0/C1 control characters, bidi-override/isolate characters (used for text spoofing) and BOM.
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Single-line, length-limited (by code points), control-character-free text. */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.normalize('NFC').replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('').trim() : s;
}

class TokenBucket {
  constructor(capacity, refillPerSec, now = Date.now()) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSec / 1000;
    this.tokens = capacity;
    this.last = now;
  }

  take(now = Date.now(), n = 1) {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}

/** Sliding-window counter keyed by string (device id / ip). Old keys are pruned automatically. */
class RateWindow {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
    this.timer = setInterval(() => this.prune(), Math.max(windowMs, 30000));
    if (this.timer.unref) this.timer.unref();
  }

  allow(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  prune(now = Date.now()) {
    for (const [k, arr] of this.hits) {
      const fresh = arr.filter(t => now - t < this.windowMs);
      if (fresh.length) this.hits.set(k, fresh); else this.hits.delete(k);
    }
  }

  stop() { clearInterval(this.timer); }
}

/** Never log a full device id. */
function shortId(id) {
  return String(id || '').slice(0, 8);
}

module.exports = { CODE_ALPHABET, CODE_REGEX, randomCode, cleanText, TokenBucket, RateWindow, shortId };
