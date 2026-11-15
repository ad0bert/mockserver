'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockServer } = require('../mockserver');
const { matchValue, ruleMatches, parseRules } = require('../lib/rules');

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
}

const LOGIN_RULES = [
  {
    match: { body: { username: 'admin', password: 'secret' } },
    body: { token: 'admin-token' },
    headers: { 'X-Role': 'admin', 'Set-Cookie': ['a=1', 'b=2'] }
  },
  { match: { body: { username: { $exists: true } } }, status: 401, body: { error: 'wrong password' } }
];

for (const liveCheck of [true, false]) {
  test(`rules (liveCheck=${liveCheck})`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
    write(root, 'login/POST.rules.json', LOGIN_RULES);
    write(root, 'login/POST.json', { fallback: true });
    write(root, 'users/__/GET.rules.json', [
      {
        match: { headers: { authorization: { $regex: '^bearer ', $flags: 'i' } }, query: { page: 2 } },
        file: 'page2.json'
      },
      { match: { headers: { 'X-Tenant': 'acme' } }, file: '../../files/acme.xml' },
      { match: { headers: { 'x-escape': '1' } }, file: '../../../outside.json' },
      { match: { headers: { 'x-slow': '1' } }, delay: 60, status: 204 }
    ]);
    write(root, 'users/__/page2.json', { page: 2 });
    write(root, 'users/__/GET.json', { page: 1 });
    write(root, 'files/acme.xml', '<acme/>');
    write(root, 'search/POST.rules.json', [
      { match: { body: { $regex: 'needle' } }, body: 'found it', headers: { 'Content-Type': 'text/plain' } },
      { match: { body: { tags: ['b'] } }, body: { tag: 'b' } }
    ]);
    write(root, 'form/POST.rules.json', [{ match: { body: { name: 'x' } }, body: { form: true } }]);
    write(root, 'broken/GET.rules.json', '{ not json');
    write(root, 'onlyrules/GET.rules.json', [{ match: { query: { a: '1' } }, body: { a: 1 } }]);

    const server = createMockServer({ mockDir: root, liveCheck, watch: false, logger: () => {} });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => server.close());
    const post = (p, body, type = 'application/json') =>
      fetch(base + p, { method: 'POST', headers: { 'content-type': type }, body });

    await t.test('first matching rule wins, rule headers are merged', async () => {
      const res = await post('/login', JSON.stringify({ username: 'admin', password: 'secret', extra: 1 }));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { token: 'admin-token' });
      assert.equal(res.headers.get('x-role'), 'admin');
      assert.deepEqual(res.headers.getSetCookie(), ['a=1', 'b=2']);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.equal(res.headers.get('access-control-allow-origin'), '*'); // from DEFAULT.header
    });

    await t.test('second rule and fallback to the mock file', async () => {
      const wrong = await post('/login', JSON.stringify({ username: 'bob', password: 'x' }));
      assert.equal(wrong.status, 401);
      assert.deepEqual(await wrong.json(), { error: 'wrong password' });
      const none = await post('/login', JSON.stringify({ other: true }));
      assert.equal(none.status, 200);
      assert.deepEqual(await none.json(), { fallback: true });
      const notJson = await post('/login', 'plain text', 'text/plain');
      assert.deepEqual(await notJson.json(), { fallback: true });
    });

    await t.test('headers ($regex, case insensitive names), query, wildcard folder, file', async () => {
      const res = await fetch(base + '/users/7?page=2', { headers: { Authorization: 'Bearer abc' } });
      assert.deepEqual(await res.json(), { page: 2 });
      const noAuth = await fetch(base + '/users/7?page=2');
      assert.deepEqual(await noAuth.json(), { page: 1 });
      const xml = await fetch(base + '/users/7', { headers: { 'x-tenant': 'acme' } });
      assert.equal(await xml.text(), '<acme/>');
      assert.equal(xml.headers.get('content-type'), 'application/xml; charset=utf-8');
    });

    await t.test('rule file outside the mock root is refused', async () => {
      const res = await fetch(base + '/users/7', { headers: { 'x-escape': '1' } });
      assert.equal(res.status, 500);
    });

    await t.test('delay and status without body', async () => {
      const start = Date.now();
      const res = await fetch(base + '/users/7', { headers: { 'x-slow': '1' } });
      assert.equal(res.status, 204);
      assert.ok(Date.now() - start >= 55);
    });

    await t.test('raw body regex, rule content type, array match', async () => {
      const res = await post('/search', 'find the needle here', 'text/plain');
      assert.equal(await res.text(), 'found it');
      assert.equal(res.headers.get('content-type'), 'text/plain');
      const tags = await post('/search', JSON.stringify({ tags: ['a', 'b', 'c'] }));
      assert.deepEqual(await tags.json(), { tag: 'b' });
    });

    await t.test('form encoded body', async () => {
      const res = await post('/form', 'name=x&other=y', 'application/x-www-form-urlencoded');
      assert.deepEqual(await res.json(), { form: true });
    });

    await t.test('rules file is never served as a body', async () => {
      const res = await fetch(base + '/onlyrules');
      assert.equal(res.status, 404);
      assert.deepEqual(await (await fetch(base + '/onlyrules?a=1')).json(), { a: 1 });
    });

    await t.test('invalid rules file gives a 500 with the reason', async () => {
      const res = await fetch(base + '/broken');
      assert.equal(res.status, 500);
      assert.match(await res.text(), /Invalid JSON in rules file/);
    });

    await t.test('HEAD uses GET rules', async () => {
      const res = await fetch(base + '/users/7', { method: 'HEAD', headers: { 'x-tenant': 'acme' } });
      assert.equal(res.headers.get('content-length'), '7');
    });
  });
}

test('matchValue', () => {
  assert.ok(matchValue({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 }));
  assert.ok(!matchValue({ a: { b: 1 } }, { a: { b: '1' } }));
  assert.ok(!matchValue({ a: 1 }, null));
  assert.ok(matchValue({ a: { $exists: false } }, {}));
  assert.ok(!matchValue({ a: { $exists: false } }, { a: 0 }));
  assert.ok(matchValue([{ id: 2 }], [{ id: 1 }, { id: 2, x: 1 }]));
  assert.ok(!matchValue([1], 1));
  assert.ok(matchValue(null, null));
});

test('ruleMatches: no match block matches everything, numbers vs header strings', () => {
  assert.ok(ruleMatches({}, { headers: {}, query: {}, body: '', rawBody: '' }));
  assert.ok(
    ruleMatches({ match: { headers: { 'X-N': 5 } } }, { headers: { 'x-n': '5' }, query: {}, body: '', rawBody: '' })
  );
});

test('parseRules validation', () => {
  assert.throws(() => parseRules('{}', 'f'), /JSON array/);
  assert.throws(() => parseRules('[1]', 'f'), /must be an object/);
  assert.throws(() => parseRules('[{"status": 42}]', 'f'), /invalid status/);
  assert.throws(() => parseRules('[{"file": 1}]', 'f'), /"file" must be a string/);
  assert.equal(parseRules('[{"status": 201}]', 'f').length, 1);
});
