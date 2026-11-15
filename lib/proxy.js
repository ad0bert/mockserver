'use strict';
/**
 * Forwards requests without a mock to a real backend (-t) and optionally records
 * the answers as mock files (-r).
 */
const fs = require('node:fs');
const path = require('node:path');
const { STATUS_CODES } = require('node:http');

// headers that describe the connection or the transfer, not the resource
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);
// not forwarded to the backend: fetch sets them itself (accept-encoding: fetch decompresses)
const SKIP_REQUEST = new Set([...HOP_BY_HOP, 'host', 'content-length', 'accept-encoding', 'expect']);
// not sent back / recorded: the body is decompressed and its length set by the mock server
const SKIP_RESPONSE = new Set([...HOP_BY_HOP, 'content-length', 'content-encoding', 'date']);

/**
 * sends the request to the backend
 * @return {{status: number, headers: Array<[string, string]>, body: Buffer}}
 */
async function forward({ target, req, method, body, timeout }) {
  const url = target.replace(/\/+$/, '') + req.url;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (SKIP_REQUEST.has(name)) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const response = await fetch(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' || !body || body.length === 0 ? undefined : body,
    redirect: 'manual', // pass redirects through to the client
    signal: AbortSignal.timeout(timeout)
  });
  const result = [];
  response.headers.forEach((value, name) => {
    if (!SKIP_RESPONSE.has(name) && name !== 'set-cookie') result.push([name, value]);
  });
  for (const cookie of response.headers.getSetCookie()) result.push(['set-cookie', cookie]);
  return { status: response.status, headers: result, body: Buffer.from(await response.arrayBuffer()) };
}

/**
 * adds the DEFAULT.header lines the backend did not send (i.e. CORS headers),
 * so proxied and recorded responses behave like the other mocks
 */
function withDefaults(headers, defaults) {
  const present = new Set(headers.map(([n]) => n.toLowerCase()));
  return [...headers, ...defaults.filter(([n]) => !present.has(n.toLowerCase()))];
}

/**
 * @param mimeTypes extension -> mime map of the mock server
 * @return file extension for a content type
 */
function extensionForType(contentType, mimeTypes) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!mime) return 'bin';
  const known = Object.keys(mimeTypes).find(ext => mimeTypes[ext] === mime);
  if (known) return known;
  if (mime.endsWith('+json')) return 'json';
  if (mime.endsWith('+xml')) return 'xml';
  if (mime.startsWith('text/')) return 'txt';
  return 'bin';
}

/**
 * writes a recorded response as METHOD[--query].header + METHOD[--query].<ext>.
 * Existing files are never overwritten.
 * @return list of written files
 */
function record({ dir, baseName, status, headers, body, mimeTypes }) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const writeNew = (file, content) => {
    try {
      fs.writeFileSync(file, content, { flag: 'wx' });
      written.push(file);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  };
  const statusLine = `HTTP/1.1 ${status} ${STATUS_CODES[status] || ''}`.trim();
  const headerLines = headers
    .filter(([n]) => n.toLowerCase() !== 'content-length')
    .map(([n, v]) => `${n}: ${v}`);
  writeNew(path.join(dir, `${baseName}.header`), [statusLine, ...headerLines].join('\n') + '\n');

  if (body.length > 0) {
    const type = (headers.find(([n]) => n.toLowerCase() === 'content-type') || [])[1];
    const ext = extensionForType(type, mimeTypes);
    let content = body;
    if (ext === 'json') {
      // pretty print so recorded mocks are easy to edit
      try {
        content = JSON.stringify(JSON.parse(body.toString('utf8')), null, 4) + '\n';
      } catch {
        // keep as received
      }
    }
    writeNew(path.join(dir, `${baseName}.${ext}`), content);
  }
  return written;
}

module.exports = { forward, record, withDefaults, extensionForType };
