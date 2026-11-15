'use strict';
// keeps the demo in demo/ working
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMockServer } = require('../mockserver');

test('petstore demo', async t => {
  const server = createMockServer({
    mockDir: path.join(__dirname, '..', 'demo', 'mocks'),
    watch: false,
    logger: () => {}
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v3`;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const pet = await (await fetch(base + '/pet/42')).json();
  assert.equal(pet.id, 42);
  assert.match(
    await (await fetch(base + '/pet/42', { headers: { accept: 'application/xml' } })).text(),
    /<id>42<\/id>/
  );
  assert.equal((await fetch(base + '/pet/404')).status, 404);

  assert.equal((await (await fetch(base + '/pet/findByStatus?status=sold')).json())[0].status, 'sold');
  assert.equal((await (await fetch(base + '/pet/findByStatus?status=available')).json())[0].status, 'available');
  assert.equal((await fetch(base + '/pet/findByStatus?status=bogus')).status, 400);

  const login = await fetch(base + '/user/login?username=user1&password=secret');
  assert.equal(login.headers.get('x-rate-limit'), '100');
  assert.match(await login.text(), /^logged in user session:[0-9a-f-]{36}$/);
  assert.equal((await fetch(base + '/user/login?username=x&password=y')).status, 400);

  const order = await fetch(base + '/store/order', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ petId: 42, quantity: 3 })
  });
  const placed = await order.json();
  assert.equal(placed.petId, 42);
  assert.equal(placed.quantity, 3);

  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await fetch(base + '/store/inventory')).status);
  assert.deepEqual(statuses, [503, 503, 200]);

  await assert.rejects(fetch(base + '/user/ann', { headers: { 'x-demo-fault': 'reset' } }));
  assert.equal((await (await fetch(base + '/user/ann')).json()).username, 'ann');
});
