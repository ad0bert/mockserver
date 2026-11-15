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

// polls until the server reflects a filesystem change (watch events are async)
async function eventually(fn, timeout = 3000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > end) throw e;
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
  const { server, base } = await start(root, { liveCheck: false, watch: true });
  t.after(() => server.close());

  assert.equal((await fetch(base + '/new/deep')).status, 404);
  write(root, 'new/deep/GET.json', '{"added":true}');
  await eventually(async () => assert.deepEqual(await (await fetch(base + '/new/deep')).json(), { added: true }));

  write(root, 'a/GET.xml', '<a/>');
  await eventually(async () => {
    const res = await fetch(base + '/a', { headers: { accept: 'application/xml' } });
    assert.equal(await res.text(), '<a/>');
  });

  fs.rmSync(path.join(root, 'new'), { recursive: true });
  await eventually(async () => assert.equal((await fetch(base + '/new/deep')).status, 404));
});

test('watch: DEFAULT.header is reloaded, a broken one keeps the previous', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocks-'));
  write(root, 'a/GET.json', '{}');
  const { server, base } = await start(root, { watch: true });
  t.after(() => server.close());

  write(root, 'DEFAULT.header', 'HTTP/1.1 200 OK\nX-Version: 2\n');
  await eventually(async () => assert.equal((await fetch(base + '/a')).headers.get('x-version'), '2'));

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
