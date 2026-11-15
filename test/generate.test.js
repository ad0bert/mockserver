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
      Post: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          created: { type: 'string', format: 'date-time' },
          state: { type: 'string', enum: ['open', 'closed'] }
        }
      },
      Node: {
        type: 'object',
        properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/definitions/Node' } } }
      }
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

  assert.match(
    fs.readFileSync(path.join(out, 'api/users/__/posts/__/DELETE.header'), 'utf8'),
    /^HTTP\/1\.1 204 No Content/
  );
  assert.ok(!fs.existsSync(path.join(out, 'api/users/__/posts/__/DELETE.json')));

  assert.deepEqual(read(path.join(out, 'api/tags/GET.json')), {
    additionalProperty1: 'string',
    additionalProperty2: 'string'
  });
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
        Pet: {
          allOf: [{ $ref: '#/components/schemas/Base' }, { properties: { name: { type: 'string', example: 'Rex' } } }]
        },
        Base: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } }
      },
      responses: { Ok: { content: { 'application/json': { example: { ok: true } } } } }
    }
  };
  const out = tmp();
  buildDirectoryTree(spec, out, { log() {} });
  assert.deepEqual(read(path.join(out, 'v1/pets/__/GET.json')), {
    id: '6c84fb90-12c4-11e1-840d-7b25c5ee775a',
    name: 'Rex'
  });
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

const { parseSpec, requestBodyExample } = require('../generate-mock-structure');
const { execFileSync } = require('node:child_process');

const YAML_SPEC = `openapi: 3.0.3
servers:
  - url: /api
paths:
  /pets/{id}:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
    put:
      requestBody:
        $ref: '#/components/requestBodies/PetBody'
      responses:
        204:
          description: updated
components:
  schemas:
    Pet:
      type: object
      properties:
        name: { type: string, example: Rex }
        born: { type: string, example: 2020-01-01 }
  requestBodies:
    PetBody:
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Pet'
`;

test('yaml specs', () => {
  const spec = parseSpec(YAML_SPEC, 'spec.yaml');
  const out = tmp();
  buildDirectoryTree(spec, out, { log() {} });
  // YAML 1.2: dates stay strings, numeric status keys work
  assert.deepEqual(read(path.join(out, 'api/pets/__/GET.json')), { name: 'Rex', born: '2020-01-01' });
  assert.match(fs.readFileSync(path.join(out, 'api/pets/__/PUT.header'), 'utf8'), /^HTTP\/1\.1 204 No Content/);
  assert.deepEqual(read(path.join(out, 'api/pets/__/PUT.request.json')), { name: 'Rex', born: '2020-01-01' });
});

test('parseSpec errors name the format', () => {
  assert.throws(() => parseSpec('{ "a": ', 'x.json'), /Cannot parse x\.json as JSON/);
  assert.throws(() => parseSpec('a: [1, 2', 'x.yaml'), /Cannot parse x\.yaml as YAML/);
});

test('swagger 2.0 request body from an in: body parameter', () => {
  const spec = {
    swagger: '2.0',
    parameters: {
      Body: { in: 'body', name: 'b', schema: { type: 'object', properties: { id: { type: 'integer' } } } }
    },
    paths: {}
  };
  assert.deepEqual(requestBodyExample({ parameters: [{ $ref: '#/parameters/Body' }] }, {}, spec), { id: 0 });
  assert.equal(requestBodyExample({ parameters: [{ in: 'query', name: 'q' }] }, {}, spec), undefined);
});

test('--overwrite replaces existing files', () => {
  const out = tmp();
  const spec = { swagger: '2.0', paths: { '/a': { get: { responses: { 200: { schema: { type: 'string' } } } } } } };
  fs.mkdirSync(path.join(out, 'a'));
  fs.writeFileSync(path.join(out, 'a/GET.json'), '{"custom":1}');
  const written = buildDirectoryTree(spec, out, { log() {}, overwrite: true });
  assert.deepEqual(written, [path.join(out, 'a/GET.json')]);
  assert.equal(read(path.join(out, 'a/GET.json')), 'string');
});

test('CLI: yaml file, --overwrite, usage', () => {
  const dir = tmp();
  const specFile = path.join(dir, 'spec.yml');
  fs.writeFileSync(specFile, YAML_SPEC);
  const script = path.join(__dirname, '..', 'generate-mock-structure.js');
  const out = path.join(dir, 'out');
  execFileSync(process.execPath, [script, specFile, out]);
  fs.writeFileSync(path.join(out, 'api/pets/__/GET.json'), '{}');
  execFileSync(process.execPath, [script, specFile, out]);
  assert.deepEqual(read(path.join(out, 'api/pets/__/GET.json')), {});
  execFileSync(process.execPath, [script, '--overwrite', specFile, out]);
  assert.equal(read(path.join(out, 'api/pets/__/GET.json')).name, 'Rex');
  assert.throws(() => execFileSync(process.execPath, [script, '--force', specFile], { stdio: 'pipe' }));
});
