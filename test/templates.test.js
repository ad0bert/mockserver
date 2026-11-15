'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockServer } = require('../mockserver');
const { render, isTemplateFile, escapingFor } = require('../lib/templates');

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

const REQUEST = {
  method: 'POST',
  url: '/users/42?page=2',
  segments: ['users', '42'],
  headers: { 'x-tenant': 'acme' },
  query: { page: '2' },
  body: { user: { name: 'Ann "the" Admin' }, tags: ['a'] }
};

test('render: request values', () => {
  assert.equal(render('{{method}} {{path}} {{path.1}} {{url}}', REQUEST), 'POST /users/42 42 /users/42?page=2');
  assert.equal(render('{{query.page}} {{headers.X-Tenant}} {{body.user.name}}', REQUEST), '2 acme Ann "the" Admin');
  assert.equal(render('{{body.tags}} {{body.tags.0}}', REQUEST), '["a"] a');
  assert.equal(render('[{{ query.missing | 10 }}] [{{query.missing}}] [{{nope.x}}]', REQUEST), '[10] [] []');
  assert.equal(render('{{body.constructor}} {{body.user.__proto__}}', REQUEST), ' ');
});

test('render: helpers', () => {
  assert.ok(!Number.isNaN(Date.parse(render('{{now}}', REQUEST))));
  assert.match(render('{{timestamp}}', REQUEST), /^\d{13}$/);
  assert.match(render('{{uuid}}', REQUEST), /^[0-9a-f-]{36}$/);
  for (let i = 0; i < 20; i++) {
    const n = Number(render('{{randomInt 5 7}}', REQUEST));
    assert.ok(n >= 5 && n <= 7);
  }
});

test('render: escaping', () => {
  const json = render('{"name": "{{body.user.name}}", "user": {{body.user}}, "n": {{query.page}}}', REQUEST, 'json');
  assert.deepEqual(JSON.parse(json), { name: 'Ann "the" Admin', user: { name: 'Ann "the" Admin' }, n: 2 });
  assert.equal(render('<b>{{body.user.name}}</b>', REQUEST, 'html'), '<b>Ann &quot;the&quot; Admin</b>');
  assert.equal(render('{{x}}', { ...REQUEST, segments: [] }, 'header'), '');
  assert.equal(
    render('a{{body.text}}', { ...REQUEST, body: { text: 'x\r\nInjected: 1' } }, 'header'),
    'ax Injected: 1'
  );
});

test('isTemplateFile / escapingFor', () => {
  assert.ok(isTemplateFile('/m/users/GET.tpl.json'));
  assert.ok(!isTemplateFile('/m/tpl.users/GET.json'));
  assert.equal(escapingFor('GET.tpl.json'), 'json');
  assert.equal(escapingFor('GET.tpl.html'), 'html');
  assert.equal(escapingFor('GET.tpl.txt'), 'raw');
});

test('templates in the server', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
  write(root, 'users/__/GET.tpl.json', '{ "id": "{{path.1}}", "page": {{query.page | 1}}, "at": "{{now}}" }');
  write(root, 'users/__/POST.tpl.html', '<p>{{body.name}}</p>');
  write(root, 'plain/GET.json', '{ "literal": "{{path.0}}" }');
  write(root, 'echo/POST.rules.json', [
    {
      match: { body: { name: { $exists: true } } },
      status: 201,
      headers: { Location: '/users/{{body.name}}' },
      body: { created: '{{body.name}}', by: '{{headers.x-user | anonymous}}' }
    },
    { body: 'raw {{method}}' }
  ]);
  const server = createMockServer({ mockDir: root, watch: false, logger: () => {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const res = await fetch(base + '/users/42?page=3');
  const json = await res.json();
  assert.equal(json.id, '42');
  assert.equal(json.page, 3);
  assert.ok(!Number.isNaN(Date.parse(json.at)));
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal((await (await fetch(base + '/users/7')).json()).page, 1);

  const html = await fetch(base + '/users/7', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":"<script>"}'
  });
  assert.equal(await html.text(), '<p>&lt;script&gt;</p>');
  assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');

  // files without .tpl. are sent unchanged
  assert.deepEqual(await (await fetch(base + '/plain')).json(), { literal: '{{path.0}}' });

  const created = await fetch(base + '/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":"bo\\"b"}'
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('location'), '/users/bo"b');
  assert.deepEqual(await created.json(), { created: 'bo"b', by: 'anonymous' });
  assert.equal(await (await fetch(base + '/echo', { method: 'POST' })).text(), 'raw POST');
});
