'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createMockServer } = require('../mockserver');
const { parseRules } = require('../lib/rules');

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

async function start(t, root) {
  const server = createMockServer({ mockDir: root, watch: false, logger: () => {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
}

// sends a raw request and reports how the connection ended
function rawRequest(port, p) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET ${p} HTTP/1.1\r\nHost: x\r\n\r\n`));
    let data = '';
    socket.on('data', d => (data += d));
    socket.on('error', e => resolve({ error: e.code, data }));
    socket.on('close', () => resolve({ error: null, data }));
  });
}

test('times: fail twice, then succeed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-'));
  write(root, 'flaky/GET.rules.json', [{ times: 2, status: 503, body: { error: 'busy' } }]);
  write(root, 'flaky/GET.json', { ok: true });
  write(root, 'steps/GET.rules.json', [
    { times: 1, body: { step: 1 } },
    { times: 1, body: { step: 2 } },
    { body: { step: 'last' } }
  ]);
  const { base } = await start(t, root);

  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await fetch(base + '/flaky')).status);
  assert.deepEqual(statuses, [503, 503, 200, 200]);

  const steps = [];
  for (let i = 0; i < 4; i++) steps.push((await (await fetch(base + '/steps')).json()).step);
  assert.deepEqual(steps, [1, 2, 'last', 'last']);
});

test('times: counters start over when the rules file changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-'));
  write(root, 'a/GET.rules.json', [{ times: 1, status: 500 }]);
  write(root, 'a/GET.json', {});
  const { base } = await start(t, root);
  assert.equal((await fetch(base + '/a')).status, 500);
  assert.equal((await fetch(base + '/a')).status, 200);
  write(root, 'a/GET.rules.json', [{ times: 1, status: 502 }]);
  assert.equal((await fetch(base + '/a')).status, 502);
  assert.equal((await fetch(base + '/a')).status, 200);
});

test('times: only matching requests are counted', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-'));
  write(root, 'a/GET.rules.json', [{ match: { query: { fail: 'yes' } }, times: 1, status: 500 }]);
  write(root, 'a/GET.json', {});
  const { base } = await start(t, root);
  assert.equal((await fetch(base + '/a')).status, 200);
  assert.equal((await fetch(base + '/a?fail=yes')).status, 500);
  assert.equal((await fetch(base + '/a?fail=yes')).status, 200);
});

test('probability', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-'));
  write(root, 'never/GET.rules.json', [{ probability: 0, status: 500 }]);
  write(root, 'never/GET.json', {});
  write(root, 'always/GET.rules.json', [{ probability: 1, status: 503 }]);
  write(root, 'half/GET.rules.json', [{ probability: 0.5, status: 503 }]);
  write(root, 'half/GET.json', {});
  const { base } = await start(t, root);
  for (let i = 0; i < 5; i++) {
    assert.equal((await fetch(base + '/never')).status, 200);
    assert.equal((await fetch(base + '/always')).status, 503);
  }
  const results = new Set();
  for (let i = 0; i < 60 && results.size < 2; i++) results.add((await fetch(base + '/half')).status);
  assert.deepEqual([...results].sort(), [200, 503]);
});

test('faults', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-'));
  write(root, 'reset/GET.rules.json', [{ fault: 'reset' }]);
  write(root, 'close/GET.rules.json', [{ fault: 'close' }]);
  write(root, 'hang/GET.rules.json', [{ fault: 'timeout' }]);
  write(root, 'once/GET.rules.json', [{ times: 1, fault: 'reset' }, { body: { recovered: true } }]);
  const { base, port } = await start(t, root);

  const reset = await rawRequest(port, '/reset');
  assert.equal(reset.error, 'ECONNRESET');
  assert.equal(reset.data, '');

  const closed = await rawRequest(port, '/close');
  assert.equal(closed.data, '');

  await assert.rejects(fetch(base + '/hang', { signal: AbortSignal.timeout(150) }), /TimeoutError|aborted/i);

  await assert.rejects(fetch(base + '/once'));
  assert.deepEqual(await (await fetch(base + '/once')).json(), { recovered: true });
});

test('parseRules validates times, probability and fault', () => {
  assert.throws(() => parseRules('[{"times": 0}]', 'f'), /"times"/);
  assert.throws(() => parseRules('[{"times": 1.5}]', 'f'), /"times"/);
  assert.throws(() => parseRules('[{"probability": 2}]', 'f'), /"probability"/);
  assert.throws(() => parseRules('[{"fault": "explode"}]', 'f'), /"fault" must be one of reset, close, timeout/);
  assert.equal(parseRules('[{"times": 3, "probability": 0.5, "fault": "close"}]', 'f').length, 1);
});
