'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createMockServer } = require('../mockserver');
const { buildDirectoryTree } = require('../generate-mock-structure');
const { safeFileName } = require('../lib/names');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

test('safeFileName', () => {
  assert.equal(safeFileName('t=10:30'), 't=10%3A30');
  assert.equal(safeFileName('a<b>c"d|e?f*g'), 'a%3Cb%3Ec%22d%7Ce%3Ff%2Ag');
  assert.equal(safeFileName('tab\there'), 'tab%09here');
  assert.equal(safeFileName('name.'), 'name%2E');
  assert.equal(safeFileName('name '), 'name%20');
  assert.equal(safeFileName('plain-name_1.json'), 'plain-name_1.json');
});

for (const liveCheck of [true, false]) {
  test(`lookup with encoded and unencoded names (liveCheck=${liveCheck})`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
    fs.mkdirSync(path.join(root, 'time', '10%3A30'), { recursive: true });
    fs.writeFileSync(path.join(root, 'time', '10%3A30', 'GET.json'), '{"encoded":"segment"}');
    fs.mkdirSync(path.join(root, 'slots'), { recursive: true });
    fs.writeFileSync(path.join(root, 'slots', 'GET--at=10%3A30.json'), '{"encoded":"query"}');
    // a mock written before names were encoded (only possible on Linux / macOS)
    const legacy = process.platform !== 'win32';
    if (legacy) fs.writeFileSync(path.join(root, 'slots', 'GET--at=11:00.json'), '{"legacy":true}');
    const server = createMockServer({ mockDir: root, liveCheck, watch: false, logger: () => {} });
    const base = `http://127.0.0.1:${await listen(server)}`;
    t.after(() => server.close());

    assert.deepEqual(await (await fetch(base + '/time/10:30')).json(), { encoded: 'segment' });
    assert.deepEqual(await (await fetch(base + '/time/10%3A30')).json(), { encoded: 'segment' });
    assert.deepEqual(await (await fetch(base + '/slots?at=10:30')).json(), { encoded: 'query' });
    if (legacy) assert.deepEqual(await (await fetch(base + '/slots?at=11:00')).json(), { legacy: true });
  });
}

test('recording writes encoded names', async t => {
  const backend = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
  });
  const backendPort = await listen(backend);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  const server = createMockServer({
    mockDir: root,
    target: `http://127.0.0.1:${backendPort}`,
    record: true,
    watch: false,
    logger: () => {}
  });
  const base = `http://127.0.0.1:${await listen(server)}`;
  t.after(() => {
    server.close();
    backend.close();
  });
  await fetch(base + '/at/12:00?q=a*b');
  assert.deepEqual(fs.readdirSync(path.join(root, 'at', '12%3A00')).sort(), [
    'GET--q=a%2Ab.header',
    'GET--q=a%2Ab.json'
  ]);
});

test('generator encodes path segments', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  buildDirectoryTree({ swagger: '2.0', paths: { '/things:batchGet': { get: {} } } }, out, { log() {} });
  assert.ok(fs.existsSync(path.join(out, 'things%3AbatchGet', 'GET.json')));
});
