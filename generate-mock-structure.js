#!/usr/bin/env node
/**
 * Generates a mock folder structure for mockserver.js from a Swagger 2.0 or OpenAPI 3.x spec (JSON or YAML).
 *
 * Usage: generate-mock-structure [--overwrite] <spec file | http(s) url> [output dir (default ./mocks)]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const WILDCARD = '__';
const DEFAULT_HEADER_LINES = [
  'Content-Type: application/json; charset=utf-8',
  'Access-Control-Allow-Origin: *',
  'Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Cache-Control, Pragma, Expires, Authorization, X-Request-ID',
  'Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE, PUT, PATCH'
];
const STATUS_TEXT = require('node:http').STATUS_CODES;

/**
 * resolves a local JSON reference like '#/definitions/Pet' or '#/components/schemas/Pet'
 */
function resolveRef(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new Error(`Only local $ref values are supported, got '${ref}'`);
  }
  let node = spec;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (node == null || !(key in node)) {
      throw new Error(`Cannot resolve $ref '${ref}'`);
    }
    node = node[key];
  }
  return node;
}

function exampleString(schema) {
  switch (schema.format) {
    case 'date-time':
      return new Date().toISOString();
    case 'date':
      return new Date().toISOString().slice(0, 10);
    case 'uuid':
      return '6c84fb90-12c4-11e1-840d-7b25c5ee775a';
    case 'email':
      return 'user@example.com';
    case 'uri':
    case 'url':
      return 'https://example.com';
    default:
      return 'string';
  }
}

/**
 * creates an example value for the given schema
 * @param schema JSON schema (Swagger / OpenAPI flavour)
 * @param spec the complete spec, used to resolve $ref
 * @param seen refs currently being expanded, prevents endless recursion on circular schemas
 */
function createExample(schema, spec, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return null;

  if (schema.$ref) {
    if (seen.has(schema.$ref)) return null; // circular reference
    const next = new Set(seen).add(schema.$ref);
    return createExample(resolveRef(spec, schema.$ref), spec, next);
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];

  if (Array.isArray(schema.allOf)) {
    return schema.allOf.reduce((acc, part) => {
      const value = createExample(part, spec, seen);
      return value && typeof value === 'object' && !Array.isArray(value) ? { ...acc, ...value } : acc;
    }, {});
  }
  const variants = schema.oneOf || schema.anyOf;
  if (Array.isArray(variants) && variants.length) {
    return createExample(variants[0], spec, seen);
  }

  // OpenAPI 3.1 allows type arrays like ['string', 'null']
  let type = Array.isArray(schema.type) ? schema.type.find(t => t !== 'null') : schema.type;
  if (!type && (schema.properties || schema.additionalProperties)) type = 'object';

  switch (type) {
    case 'object': {
      const result = {};
      for (const [name, prop] of Object.entries(schema.properties || {})) {
        result[name] = createExample(prop, spec, seen);
      }
      const extra = schema.additionalProperties;
      if (!schema.properties && extra) {
        const value = extra === true ? 'string' : createExample(extra, spec, seen);
        result.additionalProperty1 = value;
        result.additionalProperty2 = value;
      }
      return result;
    }
    case 'array':
      return [createExample(schema.items, spec, seen)];
    case 'string':
      return exampleString(schema);
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'file':
      return 'file-not-supported';
    default:
      return null;
  }
}

/**
 * picks the response used for the mock: 200, then the first 2xx, then 'default'
 * @return {{status: number, response: object} | null}
 */
function pickResponse(operation, spec) {
  const responses = operation.responses || {};
  const codes = Object.keys(responses);
  const code =
    (codes.includes('200') && '200') ||
    codes.filter(c => /^2\d\d$/.test(c)).sort()[0] ||
    (codes.includes('default') && 'default');
  if (!code) return null;
  let response = responses[code];
  if (response && response.$ref) response = resolveRef(spec, response.$ref);
  return { status: code === 'default' ? 200 : Number(code), response: response || {} };
}

/**
 * extracts the example body of a response for Swagger 2.0 and OpenAPI 3.x
 * @return the body value or undefined if the response has no schema
 */
function responseBody(response, spec) {
  // Swagger 2.0
  if (response.examples && response.examples['application/json'] !== undefined) {
    return response.examples['application/json'];
  }
  if (response.schema) return createExample(response.schema, spec);

  // OpenAPI 3.x
  if (response.content) {
    const types = Object.keys(response.content);
    const type = types.find(t => /json/i.test(t)) || types[0];
    const media = type ? response.content[type] : null;
    if (media) {
      if (media.example !== undefined) return media.example;
      const first = media.examples && Object.values(media.examples)[0];
      if (first) {
        const example = first.$ref ? resolveRef(spec, first.$ref) : first;
        if (example.value !== undefined) return example.value;
      }
      if (media.schema) return createExample(media.schema, spec);
    }
  }
  return undefined;
}

/**
 * extracts an example request body of an operation for Swagger 2.0 (in: body parameter)
 * and OpenAPI 3.x (requestBody)
 * @return the body value or undefined if the operation takes no body
 */
function requestBodyExample(operation, pathItem, spec) {
  const params = [...(pathItem.parameters || []), ...(operation.parameters || [])].map(p =>
    p && p.$ref ? resolveRef(spec, p.$ref) : p
  );
  const bodyParam = params.find(p => p && p.in === 'body');
  if (bodyParam) return bodyParam.schema ? createExample(bodyParam.schema, spec) : undefined;
  let requestBody = operation.requestBody;
  if (!requestBody) return undefined;
  if (requestBody.$ref) requestBody = resolveRef(spec, requestBody.$ref);
  // same shape as an OpenAPI 3 response (content -> media type -> example / schema)
  return responseBody(requestBody, spec);
}

function basePathOf(spec) {
  let base = '';
  if (spec.swagger) {
    base = spec.basePath || '';
  } else if (Array.isArray(spec.servers) && spec.servers[0] && spec.servers[0].url) {
    try {
      base = decodeURIComponent(new URL(spec.servers[0].url, 'http://localhost').pathname);
    } catch {
      base = '';
    }
  }
  return base.replace(/\/+$/, '');
}

/**
 * writes the mock files for the given spec
 * @param {any} spec parsed Swagger / OpenAPI document
 * @param {string} outDir
 * @param {{log?: (msg: string) => void, overwrite?: boolean}} [options] overwrite: replace existing files
 * @return {string[]} written files
 */
function buildDirectoryTree(spec, outDir, { log = console.log, overwrite = false } = {}) {
  if (!spec || typeof spec.paths !== 'object') {
    throw new Error('The given document is not a Swagger 2.0 / OpenAPI 3 spec (no "paths")');
  }
  const written = [];
  const writeFile = (file, content) => {
    if (!overwrite && fs.existsSync(file)) {
      log(`skipped (exists): ${file}`);
      return;
    }
    fs.writeFileSync(file, content);
    written.push(file);
  };
  const basePath = basePathOf(spec);
  for (const [apiPath, pathItem] of Object.entries(spec.paths)) {
    // replace every path parameter ({id}) with the wildcard folder
    const relative = (basePath + apiPath).replace(/\{[^}/]+\}/g, WILDCARD);
    const dir = path.join(outDir, ...relative.split('/').filter(Boolean));

    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !operation) continue;
      fs.mkdirSync(dir, { recursive: true });
      const name = method.toUpperCase();
      const picked = pickResponse(operation, spec);
      const status = picked ? picked.status : 200;
      const body = picked ? responseBody(picked.response, spec) : undefined;

      // example request, for reference: the server never sends .request.json files
      const request = requestBodyExample(operation, pathItem, spec);
      if (request !== undefined) {
        writeFile(path.join(dir, name + '.request.json'), JSON.stringify(request, null, 4) + '\n');
      }

      if (status !== 200) {
        const statusLine = `HTTP/1.1 ${status} ${STATUS_TEXT[status] || ''}`.trim();
        writeFile(path.join(dir, name + '.header'), [statusLine, ...DEFAULT_HEADER_LINES].join('\n') + '\n');
      }
      // 204 / 304 must not have a body
      if (status === 204 || status === 304) continue;

      const content = body === undefined ? { auto_generated: true } : body;
      writeFile(path.join(dir, name + '.json'), JSON.stringify(content, null, 4) + '\n');
    }
  }
  return written;
}

/**
 * parses a spec in JSON or YAML
 */
function parseSpec(text, source) {
  try {
    return JSON.parse(text);
  } catch (jsonError) {
    try {
      return YAML.parse(text);
    } catch (yamlError) {
      const looksLikeJson = /^\s*[[{]/.test(text) || /\.json$/i.test(source);
      // report the error of the format the file was meant to be in
      const error = looksLikeJson ? jsonError : yamlError;
      const message = `Cannot parse ${source} as ${looksLikeJson ? 'JSON' : 'YAML'}: ${error.message}`;
      throw new Error(message, { cause: error }); // eslint-disable-line preserve-caught-error -- cause is one of the two caught errors
    }
  }
}

async function loadSpec(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to download ${source}: ${response.status} ${response.statusText}`);
    }
    return parseSpec(await response.text(), source);
  }
  return parseSpec(await fs.promises.readFile(path.resolve(source), 'utf8'), source);
}

const USAGE =
  'Usage: generate-mock-structure [--overwrite] <spec.json | spec.yaml | http(s)://host/spec> [outDir (default ./mocks)]';

async function main(argv) {
  const flags = argv.filter(a => a.startsWith('-'));
  const args = argv.filter(a => !a.startsWith('-'));
  const unknown = flags.filter(f => f !== '--overwrite');
  if (args.length < 1 || args.length > 2 || unknown.length) {
    console.error(USAGE);
    process.exit(1);
  }
  const outDir = path.resolve(args[1] || 'mocks');
  try {
    const spec = await loadSpec(args[0]);
    const written = buildDirectoryTree(spec, outDir, { overwrite: flags.includes('--overwrite') });
    written.forEach(f => console.log(`created: ${f}`));
    console.log(`\n${written.length} file(s) written to ${outDir}`);
    console.log(`Start the server with: node ${path.join(__dirname, 'mockserver.js')} -m ${outDir}`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  buildDirectoryTree,
  createExample,
  resolveRef,
  pickResponse,
  responseBody,
  requestBodyExample,
  loadSpec,
  parseSpec
};
