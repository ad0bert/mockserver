'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildDirectoryTree, createExample } = require('../generate-mock-structure');

const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));

test('swagger 2.0', () => {
  const spec = {
    swagger: '2.0',
    basePath: '/api',
    paths: {
      '/users/{userId}/posts/{postId}': {
        parameters: [{ name: 'userId', in: 'path' }],
        get: { responses: { 200: { schema: { $ref: '#/definitions/Post' } } } },
        delete: { responses: { 204: { description: 'deleted' } } }
      },
      '/tags': {
        get: { responses: { 200: { schema: { type: 'object', additionalProperties: { type: 'string' } } } } },
        post: { responses: { 201: { schema: { type: 'string' } } } }
      },
      '/nodes': { get: { responses: { 200: { schema: { type: 'array', items: { $ref: '#/definitions/Node' } } } } } },
      '/noresponses': { get: {} }
    },
    definitions: {
      Post: { type: 'object', properties: { id: { type: 'integer' }, created: { type: 'string', format: 'date-time' }, state: { type: 'string', enum: ['open', 'closed'] } } },
      Node: { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/definitions/Node' } } } }
    }
  };
  const out = tmp();
  buildDirectoryTree(spec, out, { log() {} });

  // greedy {.*} regex used to collapse the path to /api/users/__
  const post = read(path.join(out, 'api/users/__/posts/__/GET.json'));
  assert.equal(post.id, 0);
  assert.equal(post.state, 'open');
  assert.ok(!Number.isNaN(Date.parse(post.created)));
  assert.ok(!fs.existsSync(path.join(out, 'api/users/__/posts/__/PARAMETERS.json')));

  assert.match(fs.readFileSync(path.join(out, 'api/users/__/posts/__/DELETE.header'), 'utf8'), /^HTTP\/1\.1 204 No Content/);
  assert.ok(!fs.existsSync(path.join(out, 'api/users/__/posts/__/DELETE.json')));

  assert.deepEqual(read(path.join(out, 'api/tags/GET.json')), { additionalProperty1: 'string', additionalProperty2: 'string' });
  assert.equal(read(path.join(out, 'api/tags/POST.json')), 'string');
  assert.match(fs.readFileSync(path.join(out, 'api/tags/POST.header'), 'utf8'), /^HTTP\/1\.1 201 Created/);

  // circular references terminate
  assert.deepEqual(read(path.join(out, 'api/nodes/GET.json')), [{ name: 'string', children: [null] }]);
  assert.deepEqual(read(path.join(out, 'api/noresponses/GET.json')), { auto_generated: true });
});

test('swagger without basePath', () => {
  const out = tmp();
  buildDirectoryTree({ swagger: '2.0', paths: { '/ping': { get: { responses: { 200: {} } } } } }, out, { log() {} });
  assert.ok(fs.existsSync(path.join(out, 'ping/GET.json')));
  assert.ok(!fs.existsSync(path.join(out, 'undefined')));
});

test('openapi 3', () => {
  const spec = {
    openapi: '3.0.3',
    servers: [{ url: 'https://example.com/v1/' }],
    paths: {
      '/pets/{id}': {
        get: {
          responses: {
            200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }
          }
        },
        put: { responses: { default: { $ref: '#/components/responses/Ok' } } }
      }
    },
    components: {
      schemas: {
        Pet: { allOf: [{ $ref: '#/components/schemas/Base' }, { properties: { name: { type: 'string', example: 'Rex' } } }] },
        Base: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } }
      },
      responses: { Ok: { content: { 'application/json': { example: { ok: true } } } } }
    }
  };
  const out = tmp();
  buildDirectoryTree(spec, out, { log() {} });
  assert.deepEqual(read(path.join(out, 'v1/pets/__/GET.json')), { id: '6c84fb90-12c4-11e1-840d-7b25c5ee775a', name: 'Rex' });
  assert.deepEqual(read(path.join(out, 'v1/pets/__/PUT.json')), { ok: true });
});

test('existing files are not overwritten', () => {
  const out = tmp();
  fs.mkdirSync(path.join(out, 'a'));
  fs.writeFileSync(path.join(out, 'a/GET.json'), '{"custom":1}');
  buildDirectoryTree({ swagger: '2.0', paths: { '/a': { get: {} } } }, out, { log() {} });
  assert.deepEqual(read(path.join(out, 'a/GET.json')), { custom: 1 });
});

test('createExample handles nullable type arrays', () => {
  assert.equal(createExample({ type: ['null', 'integer'] }, {}), 0);
});
