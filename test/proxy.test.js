'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { createMockServer, parseArgs } = require('../mockserver');
const { extensionForType } = require('../lib/proxy');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

function startBackend() {
  const seen = [];
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.startsWith('/api/users')) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Set-Cookie', ['s=1', 't=2']);
        res.setHeader('X-Backend', 'yes');
        return res.end(JSON.stringify({ users: [1, 2], url: req.url }));
      }
      if (req.url === '/api/echo') {
        res.statusCode = 201;
        res.setHeader('Content-Type', 'text/plain');
        return res.end('echo:' + body);
      }
      if (req.url === '/api/gzip') {
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Encoding', 'gzip');
        return res.end(zlib.gzipSync('<p>zipped</p>'));
      }
      if (req.url === '/api/redirect') {
        res.statusCode = 302;
        res.setHeader('Location', '/api/users');
        return res.end();
      }
      if (req.url === '/api/empty') {
        res.statusCode = 204;
        return res.end();
      }
      if (req.url === '/api/fail') {
        res.statusCode = 503;
        return res.end('down');
      }
      res.statusCode = 404;
      res.end('nope');
    });
  });
  return { backend, seen };
}

async function setup(t, options) {
  const { backend, seen } = startBackend();
  const backendPort = await listen(backend);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  fs.mkdirSync(path.join(root, 'api', 'local'), { recursive: true });
  fs.writeFileSync(path.join(root, 'api', 'local', 'GET.json'), '{"local":true}');
  const server = createMockServer({
    mockDir: root,
    target: `http://127.0.0.1:${backendPort}`,
    logger: () => {},
    watch: false,
    ...options
  });
  const port = await listen(server);
  t.after(() => {
    server.close();
    backend.close();
  });
  return { root, base: `http://127.0.0.1:${port}`, seen };
}

test('proxy without recording', async t => {
  const { root, base, seen } = await setup(t, { record: false, liveCheck: false });

  await t.test('existing mocks are served locally', async () => {
    assert.deepEqual(await (await fetch(base + '/api/local')).json(), { local: true });
    assert.equal(seen.length, 0);
  });

  await t.test('missing mocks are forwarded with path, query, headers and cookies', async () => {
    const res = await fetch(base + '/api/users?x=1', { headers: { authorization: 'Bearer t' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { users: [1, 2], url: '/api/users?x=1' });
    assert.equal(res.headers.get('x-backend'), 'yes');
    assert.deepEqual(res.headers.getSetCookie(), ['s=1', 't=2']);
    assert.equal(res.headers.get('access-control-allow-origin'), '*'); // added from DEFAULT.header
    assert.equal(seen.at(-1).headers.authorization, 'Bearer t');
  });

  await t.test('request body is forwarded', async () => {
    const res = await fetch(base + '/api/echo', { method: 'POST', body: 'hello' });
    assert.equal(res.status, 201);
    assert.equal(await res.text(), 'echo:hello');
  });

  await t.test('gzip is decoded, redirects are passed through, errors are passed through', async () => {
    const zipped = await fetch(base + '/api/gzip');
    assert.equal(await zipped.text(), '<p>zipped</p>');
    assert.equal(zipped.headers.get('content-encoding'), null);
    const redirect = await fetch(base + '/api/redirect', { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/api/users');
    assert.equal((await fetch(base + '/api/missing')).status, 404);
  });

  await t.test('path traversal is not forwarded', async () => {
    const calls = seen.length;
    const port = new URL(base).port;
    const raw = await new Promise((resolve, reject) => {
      const socket = require('node:net').connect(port, '127.0.0.1', () =>
        socket.write('GET /api/../admin HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
      );
      let data = '';
      socket.on('data', d => (data += d));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 404/);
    assert.equal(seen.length, calls);
  });

  await t.test('nothing is written', async () => {
    assert.deepEqual(fs.readdirSync(path.join(root, 'api')), ['local']);
  });
});

test('proxy with recording', async t => {
  for (const liveCheck of [true, false]) {
    await t.test(`liveCheck=${liveCheck}`, async () => {
      const { root, base, seen } = await (async () => {
        const ctx = { after: fn => t.after(fn) };
        return setup(ctx, { record: true, liveCheck });
      })();

      await fetch(base + '/api/users?page=2');
      const dir = path.join(root, 'api', 'users');
      const header = fs.readFileSync(path.join(dir, 'GET--page=2.header'), 'utf8');
      assert.match(header, /^HTTP\/1\.1 200 OK\n/);
      assert.match(header, /^x-backend: yes$/m);
      assert.match(header, /^set-cookie: s=1$/m);
      assert.match(header, /^set-cookie: t=2$/m);
      assert.match(header, /^Access-Control-Allow-Origin: \*$/m);
      assert.doesNotMatch(header, /content-length|^date:/im);
      // pretty printed JSON
      assert.equal(
        fs.readFileSync(path.join(dir, 'GET--page=2.json'), 'utf8'),
        JSON.stringify({ users: [1, 2], url: '/api/users?page=2' }, null, 4) + '\n'
      );

      // the second call is answered from the recording, without the backend
      const calls = seen.length;
      const replay = await fetch(base + '/api/users?page=2');
      assert.equal(seen.length, calls);
      assert.equal(replay.headers.get('x-backend'), 'yes');
      assert.deepEqual(replay.headers.getSetCookie(), ['s=1', 't=2']);
      assert.deepEqual(await replay.json(), { users: [1, 2], url: '/api/users?page=2' });

      await fetch(base + '/api/echo', { method: 'POST', body: 'abc' });
      assert.equal(fs.readFileSync(path.join(root, 'api', 'echo', 'POST.txt'), 'utf8'), 'echo:abc');
      assert.match(fs.readFileSync(path.join(root, 'api', 'echo', 'POST.header'), 'utf8'), /^HTTP\/1\.1 201 Created/);

      await fetch(base + '/api/gzip');
      assert.equal(fs.readFileSync(path.join(root, 'api', 'gzip', 'GET.html'), 'utf8'), '<p>zipped</p>');

      // 204: only a header file, replayed with the right status
      await fetch(base + '/api/empty');
      assert.deepEqual(fs.readdirSync(path.join(root, 'api', 'empty')), ['GET.header']);
      const calls2 = seen.length;
      assert.equal((await fetch(base + '/api/empty')).status, 204);
      assert.equal(seen.length, calls2);

      // 5xx is not recorded
      assert.equal((await fetch(base + '/api/fail')).status, 503);
      assert.ok(!fs.existsSync(path.join(root, 'api', 'fail')));
    });
  }
});

test('unreachable target gives 502', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  const closed = http.createServer();
  const deadPort = await listen(closed);
  await new Promise(r => closed.close(r));
  const server = createMockServer({
    mockDir: root,
    target: `http://127.0.0.1:${deadPort}`,
    logger: () => {},
    watch: false
  });
  const port = await listen(server);
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${port}/x`);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /Proxy to .* failed/);
});

test('target with a base path', async t => {
  const { backend, seen } = startBackend();
  const backendPort = await listen(backend);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  const server = createMockServer({
    mockDir: root,
    target: `http://127.0.0.1:${backendPort}/api/`,
    logger: () => {},
    watch: false
  });
  const port = await listen(server);
  t.after(() => {
    server.close();
    backend.close();
  });
  await fetch(`http://127.0.0.1:${port}/users`);
  assert.equal(seen.at(-1).url, '/api/users');
});

test('parseArgs -t / -r', () => {
  const opts = parseArgs(['-t', 'https://api.example.com/v1', '-r', 'true']);
  assert.equal(opts.target, 'https://api.example.com/v1');
  assert.equal(opts.record, true);
  assert.throws(() => parseArgs(['-t', 'ftp://x']), /Invalid proxy target/);
  assert.throws(() => parseArgs(['-t', 'nope']), /Invalid proxy target/);
});

test('extensionForType', () => {
  const mimes = { json: 'application/json', xml: 'application/xml', png: 'image/png' };
  assert.equal(extensionForType('application/json; charset=utf-8', mimes), 'json');
  assert.equal(extensionForType('application/problem+json', mimes), 'json');
  assert.equal(extensionForType('image/svg+xml', mimes), 'xml');
  assert.equal(extensionForType('text/x-custom', mimes), 'txt');
  assert.equal(extensionForType('', mimes), 'bin');
  assert.equal(extensionForType('application/x-thing', mimes), 'bin');
});
