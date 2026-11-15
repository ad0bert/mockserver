'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockServer, chooseBodyFile, contentTypeFor } = require('../mockserver');

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function start(root, options) {
  const server = createMockServer({ mockDir: root, logger: () => {}, watchDelay: 20, ...options });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// polls until the server reflects a filesystem change (watch events are async).
// retry repeats the change now and then: a watcher that is still starting (FSEvents on macOS)
// can miss the first event, the test must not depend on that
async function eventually(fn, retry = () => {}, timeout = 5000) {
  const end = Date.now() + timeout;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > end) throw e;
      if (attempt % 8 === 0) retry();
      await new Promise(r => setTimeout(r, 25));
    }
  }
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

for (const liveCheck of [true, false]) {
  test(`non JSON bodies (liveCheck=${liveCheck})`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocks-'));
    write(root, 'feed/GET.xml', '<feed/>');
    write(root, 'logo/GET.png', PNG);
    write(root, 'page/__/GET.html', '<h1>hi</h1>');
    write(root, 'blob/GET.bin', 'raw');
    write(root, 'both/GET.json', '{"fmt":"json"}');
    write(root, 'both/GET.xml', '<fmt>xml</fmt>');
    write(root, 'both/GET.json~', 'editor backup');
    write(root, 'search/GET--q=1.csv', 'a,b');
    write(root, 'search/GET.json', '{}');
    write(root, 'typed/GET.txt', 'hello');
    write(root, 'typed/GET.header', 'HTTP/1.1 200 OK\nContent-Type: text/x-custom\n');
    write(root, 'hal/GET.json', '{}');
    const { server, base } = await start(root, { liveCheck, watch: false });
    t.after(() => server.close());

    await t.test('xml with content type from extension', async () => {
      const res = await fetch(base + '/feed');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/xml; charset=utf-8');
      assert.equal(await res.text(), '<feed/>');
      // default CORS headers are still applied
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
    });

    await t.test('binary body is served unchanged', async () => {
      const res = await fetch(base + '/logo');
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
      assert.equal(res.headers.get('content-length'), String(PNG.length));
    });

    await t.test('wildcard folder and unknown extension', async () => {
      assert.equal(await (await fetch(base + '/page/7')).text(), '<h1>hi</h1>');
      const res = await fetch(base + '/blob');
      assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    });

    await t.test('json is preferred, Accept header selects', async () => {
      assert.deepEqual(await (await fetch(base + '/both')).json(), { fmt: 'json' });
      const xml = await fetch(base + '/both', { headers: { accept: 'application/xml' } });
      assert.equal(await xml.text(), '<fmt>xml</fmt>');
      const q = await fetch(base + '/both', { headers: { accept: 'application/json;q=0.5, application/xml' } });
      assert.equal(await q.text(), '<fmt>xml</fmt>');
      const none = await fetch(base + '/both', { headers: { accept: 'image/png, */*' } });
      assert.deepEqual(await none.json(), { fmt: 'json' });
    });

    await t.test('query specific file with other extension', async () => {
      const res = await fetch(base + '/search?q=1');
      assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
      assert.equal(await res.text(), 'a,b');
    });

    await t.test('own header file keeps its content type', async () => {
      const res = await fetch(base + '/typed');
      assert.equal(res.headers.get('content-type'), 'text/x-custom');
    });

    await t.test('HEAD has content length but no body', async () => {
      const res = await fetch(base + '/feed', { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-length'), '7');
      assert.equal(await res.text(), '');
    });
  });
}

test('DEFAULT.header content type is kept for .json', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocks-'));
  write(root, 'DEFAULT.header', 'HTTP/1.1 200 OK\nContent-Type: application/hal+json\n');
  write(root, 'a/GET.json', '{}');
  write(root, 'b/GET.xml', '<b/>');
  const { server, base } = await start(root, { watch: false });
  t.after(() => server.close());
  assert.equal((await fetch(base + '/a')).headers.get('content-type'), 'application/hal+json');
  assert.equal((await fetch(base + '/b')).headers.get('content-type'), 'application/xml; charset=utf-8');
});

test('watch: index mode picks up added, changed and removed mocks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocks-'));
  write(root, 'a/GET.json', '{"v":1}');
  // no startup reload: the changes below have to come through the watcher
  const { server, base } = await start(root, { liveCheck: false, watch: true, startupReloadDelay: 60000 });
  t.after(() => server.close());

  assert.equal((await fetch(base + '/new/deep')).status, 404);
  const add = () => write(root, 'new/deep/GET.json', '{"added":true}');
  add();
  await eventually(async () => assert.deepEqual(await (await fetch(base + '/new/deep')).json(), { added: true }), add);

  const change = () => write(root, 'a/GET.xml', '<a/>');
  change();
  await eventually(async () => {
    const res = await fetch(base + '/a', { headers: { accept: 'application/xml' } });
    assert.equal(await res.text(), '<a/>');
  }, change);

  const remove = () => {
    write(root, 'new/deep/GET.json', '{"added":true}');
    fs.rmSync(path.join(root, 'new'), { recursive: true, force: true });
  };
  fs.rmSync(path.join(root, 'new'), { recursive: true });
  await eventually(async () => assert.equal((await fetch(base + '/new/deep')).status, 404), remove);
});

test('watch: one extra reload shortly after the start', async t => {
  // covers changes a watcher misses while it is still starting (FSEvents on macOS); that can't be
  // provoked reliably in a test, so check that the reload runs and the server keeps answering
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocks-'));
  write(root, 'a/GET.json', '{"ok":true}');
  const lines = [];
  const server = createMockServer({
    mockDir: root,
    liveCheck: false,
    watch: true,
    startupReloadDelay: 50,
    logger: (_type, message) => lines.push(message)
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  await eventually(async () => assert.ok(lines.includes('startup check, reloaded')));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/a`);
  assert.deepEqual(await res.json(), { ok: true });
});

test('watch: DEFAULT.header is reloaded, a broken one keeps the previous', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocks-'));
  write(root, 'a/GET.json', '{}');
  const { server, base } = await start(root, { watch: true });
  t.after(() => server.close());

  const update = () => write(root, 'DEFAULT.header', 'HTTP/1.1 200 OK\nX-Version: 2\n');
  update();
  await eventually(async () => assert.equal((await fetch(base + '/a')).headers.get('x-version'), '2'), update);

  write(root, 'DEFAULT.header', 'not a status line');
  await new Promise(r => setTimeout(r, 150));
  const res = await fetch(base + '/a');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-version'), '2');
});

test('watch disabled: index stays as it was', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocks-'));
  const { server, base } = await start(root, { liveCheck: false, watch: false });
  t.after(() => server.close());
  write(root, 'late/GET.json', '{}');
  await new Promise(r => setTimeout(r, 150));
  assert.equal((await fetch(base + '/late')).status, 404);
});

test('chooseBodyFile / contentTypeFor', () => {
  assert.equal(chooseBodyFile(['GET.png', 'GET.xml'], 'image/*'), 'GET.png');
  assert.equal(chooseBodyFile(['GET.png', 'GET.xml'], undefined), 'GET.png');
  assert.equal(chooseBodyFile(['GET.json', 'GET.xml'], 'application/xml;q=0'), 'GET.json');
  assert.equal(contentTypeFor('x/GET.SVG'), 'image/svg+xml; charset=utf-8');
  assert.equal(contentTypeFor('GET.pdf'), 'application/pdf');
});

test('.request.json files are never served', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocks-'));
  write(root, 'a/POST.request.json', '{"example":"request"}');
  const { server, base } = await start(root, { watch: false });
  t.after(() => server.close());
  assert.equal((await fetch(base + '/a', { method: 'POST' })).status, 404);
});
