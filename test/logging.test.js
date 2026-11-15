'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockServer, LOG_LVL } = require('../mockserver');

test('one log line per request with status, duration and source', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-'));
  fs.mkdirSync(path.join(root, 'users', '__'), { recursive: true });
  fs.writeFileSync(path.join(root, 'users', '__', 'GET.json'), '{}');
  fs.writeFileSync(path.join(root, 'users', '__', 'POST.rules.json'), '[{"status": 201}]');
  const lines = [];
  const server = createMockServer({
    mockDir: root,
    watch: false,
    logger: (type, message) => lines.push({ type, message })
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const requestLines = async (fn, count = 1) => {
    lines.length = 0;
    await fn();
    // the line is written on 'close', shortly after the client got the response
    for (let i = 0; i < 50 && lines.filter(l => l.type !== LOG_LVL.DEBUG).length < count; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    return lines.filter(l => l.type !== LOG_LVL.DEBUG);
  };

  const [found] = await requestLines(() => fetch(base + '/users/1'));
  assert.equal(found.type, LOG_LVL.INFO);
  assert.match(found.message, /^GET \/users\/1 200 \d+\.\dms <- users\/__\/GET\.json$/);

  const [rule] = await requestLines(() => fetch(base + '/users/1', { method: 'POST' }));
  assert.match(rule.message, /^POST \/users\/1 201 .* <- rule #0 in users\/__\/POST\.rules\.json$/);

  const [missing] = await requestLines(() => fetch(base + '/nothing'));
  assert.equal(missing.type, LOG_LVL.ERROR);
  assert.match(missing.message, /^GET \/nothing 404 .* <- no mock found$/);

  const [options] = await requestLines(() => fetch(base + '/users/1', { method: 'OPTIONS' }));
  assert.match(options.message, /^OPTIONS \/users\/1 202 .* <- default OPTIONS header$/);
});
