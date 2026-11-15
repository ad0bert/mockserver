'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createMockServer, parseArgs, parseHeader, splitUrl } = require('../mockserver');

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function setupMocks() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocks-'));
  write(root, 'TEST/00/GET.json', '{"id":"00"}');
  write(root, 'TEST/__/GET.json', '{"id":"wildcard"}');
  write(root, 'TEST/__/details/GET.json', '{"details":true}');
  write(root, 'users/__/posts/__/GET.json', '{"post":true}');
  write(root, 'search/GET.json', '{"q":"none"}');
  write(root, 'search/GET--q=abc.json', '{"q":"abc"}');
  write(root, 'redirect/GET.header', 'HTTP/1.1 302 Found\nLocation: http://example.com:8080/x\n');
  write(root, 'cookies/GET.header', 'HTTP/1.1 200 OK\nSet-Cookie: a=1\nSet-Cookie: b=2\n');
  write(root, 'cookies/GET.json', '{}');
  write(root, 'slow/GET.header', 'HTTP/1.1 201 Created\nUser-Defined-Delay: 50\nContent-Type: application/json\n');
  write(root, 'slow/GET.json', '{"slow":true}');
  write(root, 'with space/GET.json', '{"space":true}');
  write(path.dirname(root), path.basename(root) + '-secret.json', 'secret');
  return root;
}

for (const liveCheck of [true, false]) {
  let root;
  let server;
  let base;
  const get = (p, opts) => fetch(base + p, opts);

  test(`server (liveCheck=${liveCheck})`, async t => {
    root = setupMocks();
    server = createMockServer({ mockDir: root, liveCheck, logger: () => {} });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => server.close());

    await t.test('exact match', async () => {
      const res = await get('/TEST/00');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { id: '00' });
      assert.match(res.headers.get('content-type'), /application\/json/);
    });

    await t.test('wildcard match, also for prefixes of existing folders', async () => {
      assert.deepEqual(await (await get('/TEST/ABCD')).json(), { id: 'wildcard' });
      // '0' is a prefix of '00' and used to return a wrong 404 in non live mode
      assert.deepEqual(await (await get('/TEST/0')).json(), { id: 'wildcard' });
    });

    await t.test('wildcard backtracking', async () => {
      // /TEST/00 exists but has no 'details' -> must fall back to /TEST/__/details
      assert.deepEqual(await (await get('/TEST/00/details')).json(), { details: true });
    });

    await t.test('multiple wildcards', async () => {
      assert.deepEqual(await (await get('/users/1/posts/2/')).json(), { post: true });
    });

    await t.test('query specific file and fallback', async () => {
      assert.deepEqual(await (await get('/search?q=abc')).json(), { q: 'abc' });
      assert.deepEqual(await (await get('/search?q=zzz')).json(), { q: 'none' });
      assert.deepEqual(await (await get('/search?next=/a/b')).json(), { q: 'none' });
    });

    await t.test('url decoding', async () => {
      assert.deepEqual(await (await get('/with%20space')).json(), { space: true });
    });

    await t.test('header only mock and colon in header value', async () => {
      const res = await get('/redirect', { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), 'http://example.com:8080/x');
    });

    await t.test('repeated headers', async () => {
      const res = await get('/cookies');
      assert.deepEqual(res.headers.getSetCookie(), ['a=1', 'b=2']);
    });

    await t.test('user defined delay and status', async () => {
      const start = Date.now();
      const res = await get('/slow');
      assert.equal(res.status, 201);
      assert.ok(Date.now() - start >= 45);
      assert.equal(res.headers.get('user-defined-delay'), null);
    });

    await t.test('404', async () => {
      const res = await get('/nothing/here');
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
    });

    await t.test('OPTIONS default', async () => {
      const res = await get('/TEST/00', { method: 'OPTIONS' });
      assert.equal(res.status, 202);
      assert.match(res.headers.get('access-control-allow-methods'), /GET/);
    });

    await t.test('path traversal is rejected', async () => {
      const name = path.basename(root) + '-secret.json';
      for (const p of [`/../${name}`, `/%2e%2e/${name}`, `/..%2F${name}`]) {
        const raw = await rawGet(server.address().port, p);
        assert.match(raw, /^HTTP\/1\.1 404/, p);
        assert.doesNotMatch(raw, /secret/);
      }
    });
  });
}

function rawGet(port, p) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${p} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', d => (data += d));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

test('parseArgs', () => {
  assert.equal(parseArgs([]).port, 8181);
  assert.equal(parseArgs([]).mockDir, path.resolve('mocks'));
  const opts = parseArgs(['-p', '9000', '-m', '/abs/mocks', '-l', 'false', '-v', '4', '-H', '0.0.0.0']);
  assert.equal(opts.port, 9000);
  assert.equal(opts.mockDir, path.resolve('/abs/mocks'));
  assert.equal(opts.liveCheck, false);
  assert.equal(opts.verbose, 4);
  assert.equal(opts.host, '0.0.0.0');
  assert.throws(() => parseArgs(['-p']));
  assert.throws(() => parseArgs(['-x', '1']));
  assert.throws(() => parseArgs(['-p', 'abc']));
});

test('parseHeader', () => {
  const h = parseHeader('HTTP/1.1 404 Not Found\r\nX-A: 1\r\nbroken line\r\n\r\nX-B: ignored');
  assert.equal(h.statusCode, 404);
  assert.deepEqual(h.headers, [['X-A', '1']]);
  assert.throws(() => parseHeader('garbage'));
});

test('splitUrl', () => {
  assert.deepEqual(splitUrl('/a//b/?x=1'), { segments: ['a', 'b'], query: 'x=1' });
  assert.equal(splitUrl('/a/../b'), null);
  assert.equal(splitUrl('/%zz'), null);
});
