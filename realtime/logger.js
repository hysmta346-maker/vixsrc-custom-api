'use strict';

/** One JSON object per line: easy to grep, ship to a log service, or read with `docker logs`. */
function write(level, msg, fields) {
  const line = JSON.stringify(Object.assign({ time: new Date().toISOString(), level, msg }, fields || {}));
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

module.exports = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields)
};
