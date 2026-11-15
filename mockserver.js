#!/usr/bin/env node
/**
 * Local webserver delivering mock responses for http requests.
 *
 * @author Peter Ortner
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const rules = require('./lib/rules');
const proxy = require('./lib/proxy');
const templates = require('./lib/templates');
const { safeFileName } = require('./lib/names');

// ----------------------- program defaults -----------------------
/**
 * @typedef {object} ServerOptions
 * @property {number} port
 * @property {string} host
 * @property {string} mockDir mock root
 * @property {number} verbose log level 0-5
 * @property {boolean} liveCheck check the filesystem on every request instead of using an index
 * @property {boolean} watch reload on changes in the mock folder
 * @property {number} watchDelay ms to wait for more changes before reloading
 * @property {number} startupReloadDelay ms after the start for one extra reload (changes a starting watcher missed)
 * @property {string | null} target backend for requests without a mock
 * @property {boolean} record write proxied responses as mock files
 * @property {number} proxyTimeout ms
 * @property {(type: string, message: string) => void} [logger] replaces the console logger
 */

/** @type {Readonly<ServerOptions>} */
const DEFAULTS = Object.freeze({
  port: 8181,
  host: '127.0.0.1',
  mockDir: path.resolve('mocks'), // ./mocks in the current directory, like the generator
  verbose: 2,
  liveCheck: true,
  watch: true,
  watchDelay: 100,
  startupReloadDelay: 1000,
  target: null, // backend for requests without a mock
  record: false, // write proxied responses as mock files
  proxyTimeout: 30000
});

const WILDCARD = '__';
const QUERY_SEPARATOR = '--';
// files next to the body files that are never served as a body
const SPECIAL_EXT = { header: 'header', rules: 'rules.json', request: 'request.json' };
const SPECIAL_EXTS = new Set(Object.values(SPECIAL_EXT));

const DEFAULT_OPTIONS_HEADER = [
  'HTTP/1.1 202 Accepted',
  'Content-Length: 0',
  'Access-Control-Allow-Origin: *',
  'Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Cache-Control, Pragma, Expires, Authorization, X-Request-ID',
  'Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE, PUT'
].join('\n');

const DEFAULT_DEFAULT_HEADER = [
  'HTTP/1.1 200 OK',
  'Content-Type: application/json; charset=utf-8',
  'Access-Control-Allow-Origin: *',
  'Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Cache-Control, Pragma, Expires, Authorization, X-Request-ID',
  'Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE, PUT, PATCH'
].join('\n');

// ----------------------- logging util -----------------------
const LOG_LVL = Object.freeze({
  DEBUG: 'debug',
  INFO: 'info',
  LOG: 'log',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal'
});

// levels that can be silenced, in the order they get enabled by -v (0-5)
const VERBOSITY_ORDER = [LOG_LVL.LOG, LOG_LVL.INFO, LOG_LVL.SUCCESS, LOG_LVL.WARN, LOG_LVL.DEBUG];

const COLORS = {
  [LOG_LVL.LOG]: '\x1b[39m',
  [LOG_LVL.INFO]: '\x1b[34m',
  [LOG_LVL.SUCCESS]: '\x1b[32m',
  [LOG_LVL.DEBUG]: '\x1b[36m',
  [LOG_LVL.WARN]: '\x1b[33m',
  [LOG_LVL.ERROR]: '\x1b[31m',
  [LOG_LVL.FATAL]: '\x1b[31m'
};
const COLOR_RESET = '\x1b[0m';

function createLogger(verbose) {
  const level = Number.isFinite(verbose) ? verbose : DEFAULTS.verbose;
  const ignored = new Set(VERBOSITY_ORDER.slice(Math.max(0, level)));
  return function log(type, message) {
    if (ignored.has(type)) return;
    const isError = type === LOG_LVL.ERROR || type === LOG_LVL.FATAL;
    const stream = isError || type === LOG_LVL.WARN ? process.stderr : process.stdout;
    const text = stream.isTTY ? `${COLORS[type] || COLORS[LOG_LVL.FATAL]}${message}${COLOR_RESET}` : String(message);
    stream.write(text + '\n');
  };
}

// ----------------------- parse program arguments -----------------------
const USAGE =
  'Usage: mockserver [-p PORT] [-H HOST] [-m MOCK_DIR] [-v VERBOSE(0-5)] [-l LIVE_CHECK(true|false)] [-w WATCH(true|false)]\n' +
  '                  [-t PROXY_TARGET_URL] [-r RECORD(true|false)]';

/**
 * parses the command line arguments
 * @param argv arguments without node binary and script name
 * @return options object or throws on invalid input
 */
function parseArgs(argv) {
  /** @type {ServerOptions} */
  const options = { ...DEFAULTS };
  if (argv.length % 2 !== 0) {
    throw new Error(USAGE);
  }
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case '-p': {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error(`Invalid port '${value}'\n${USAGE}`);
        }
        options.port = port;
        break;
      }
      case '-H':
        options.host = value;
        break;
      case '-m':
        // relative paths are resolved against the current working directory
        options.mockDir = path.resolve(value);
        break;
      case '-v': {
        const verbose = Number(value);
        if (!Number.isInteger(verbose)) {
          throw new Error(`Invalid verbose level '${value}'\n${USAGE}`);
        }
        options.verbose = verbose;
        break;
      }
      case '-l':
        options.liveCheck = value === 'true';
        break;
      case '-w':
        options.watch = value === 'true';
        break;
      case '-t': {
        let url;
        try {
          url = new URL(value);
        } catch {
          url = null;
        }
        if (!url || !/^https?:$/.test(url.protocol)) {
          throw new Error(`Invalid proxy target '${value}', expected an http(s) URL\n${USAGE}`);
        }
        options.target = value;
        break;
      }
      case '-r':
        options.record = value === 'true';
        break;
      default:
        throw new Error(`Unknown option '${argv[i]}'\n${USAGE}`);
    }
  }
  return options;
}

// ----------------------- header handling -----------------------

/**
 * parses the content of a .header file
 * @param content raw http header text (status line + headers)
 * @return {{statusCode: number, headers: Array<[string, string]>}}
 */
function parseHeader(content) {
  const lines = content.split(/\r?\n/);
  const statusCode = parseInt((lines[0] || '').trim().split(/\s+/)[1], 10);
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 999) {
    throw new Error(`Invalid status line in header file: '${lines[0]}'`);
  }
  const headers = [];
  for (let i = 1; i < lines.length; ++i) {
    const line = lines[i];
    if (line.trim() === '') break;
    const idx = line.indexOf(':');
    if (idx <= 0) continue; // ignore malformed lines
    // only split on the first colon, values like URLs or dates contain colons
    headers.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  return { statusCode, headers };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const USER_DEFINED_HEADERS = new Map([
  [
    'user-defined-delay',
    async value => {
      const ms = parseInt(value, 10);
      if (ms > 0) await delay(ms);
    }
  ]
]);

/**
 * applies the header information to the server response
 * @param res server response
 * @param parsed result of parseHeader
 */
async function applyHeader(res, parsed) {
  res.statusCode = parsed.statusCode;
  const collected = new Map();
  for (const [name, value] of parsed.headers) {
    const userDefined = USER_DEFINED_HEADERS.get(name.toLowerCase());
    if (userDefined) {
      await userDefined(value);
      continue;
    }
    // repeated headers (i.e. Set-Cookie) are sent multiple times
    const key = name.toLowerCase();
    if (collected.has(key)) {
      collected.get(key).values.push(value);
    } else {
      collected.set(key, { name, values: [value] });
    }
  }
  for (const { name, values } of collected.values()) {
    res.setHeader(name, values.length === 1 ? values[0] : values);
  }
}

// ----------------------- file lookup -----------------------

/**
 * builds the lookup for files and directories below the mock root
 * @param mockDir mock root
 * @param liveCheck true: check the filesystem on every request, false: use an index (see rebuild)
 * @return {{isDir(p: string): boolean, list(dir: string): string[], rebuild(): void}}
 *   list returns the names of the files (not directories) in dir
 */
function createFileLookup(mockDir, liveCheck) {
  if (liveCheck) {
    return {
      isDir: p => {
        try {
          return fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
      list: dir => {
        try {
          return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter(e => !e.isDirectory())
            .map(e => e.name);
        } catch {
          return [];
        }
      },
      rebuild() {}
    };
  }
  // directory -> file names
  let index = new Map();
  const build = () => {
    const next = new Map();
    const walk = dir => {
      const files = [];
      next.set(dir, files);
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // removed while indexing
      }
      for (const entry of entries) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
        else files.push(entry.name);
      }
    };
    walk(mockDir);
    index = next; // swap at once, requests never see a half built index
  };
  build();
  return {
    isDir: p => index.has(p),
    list: dir => index.get(dir) || [],
    rebuild: build
  };
}

// ----------------------- content types -----------------------
const MIME_TYPES = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  csv: 'text/csv',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  md: 'text/markdown',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm'
};
const TEXT_MIME = /^text\/|^application\/(json|xml|yaml|javascript)|\+xml$|\+json$/;

function extensionOf(file) {
  const base = path.basename(file);
  const idx = base.lastIndexOf('.');
  return idx >= 0 ? base.slice(idx + 1).toLowerCase() : '';
}

/**
 * @return content type for the file name, including charset for text types
 */
function contentTypeFor(file) {
  const mime = MIME_TYPES[extensionOf(file)] || 'application/octet-stream';
  return TEXT_MIME.test(mime) ? `${mime}; charset=utf-8` : mime;
}

/**
 * picks the body file when several exist (i.e. GET.json and GET.xml).
 * The request's Accept header decides, otherwise .json wins, otherwise the first by name.
 */
function chooseBodyFile(names, accept) {
  if (names.length > 1 && accept) {
    const accepted = accept
      .split(',')
      .map(part => {
        const [type, ...params] = part.trim().toLowerCase().split(';');
        const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
        return { type: type.trim(), q: q ? Number(q.slice(2)) : 1 };
      })
      .filter(a => a.type && a.type !== '*/*' && a.q > 0)
      .sort((a, b) => b.q - a.q); // stable, keeps the client's order for equal q
    for (const { type } of accepted) {
      const match = names.find(name => {
        const mime = MIME_TYPES[extensionOf(name)];
        if (!mime) return false;
        return type.endsWith('/*') ? mime.startsWith(type.slice(0, -1)) : mime === type;
      });
      if (match) return match;
    }
  }
  return names.find(n => extensionOf(n) === 'json') || names[0];
}

/**
 * splits a request url into safe, decoded path segments and the raw query.
 * @return {{segments: string[], query: string} | null} null if the path is not allowed
 */
function splitUrl(url) {
  const qIdx = url.indexOf('?');
  const rawPath = qIdx >= 0 ? url.slice(0, qIdx) : url;
  // slashes in a query would otherwise create sub directories
  const query = qIdx >= 0 ? url.slice(qIdx + 1).replace(/[/\\]/g, encodeURIComponent) : '';
  const segments = [];
  for (const raw of rawPath.split('/')) {
    if (raw === '') continue;
    let segment;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    // prevent path traversal outside of the mock root
    if (segment === '.' || segment === '..' || /[/\\\0]/.test(segment)) {
      return null;
    }
    segments.push(segment);
  }
  if (query.includes('\0')) return null;
  return { segments, query };
}

/**
 * resolves the mock file for a request. Each path segment is matched literally first,
 * if that does not lead to a file the wildcard folder '__' is tried (with backtracking).
 * In the final folder the query specific file (METHOD--query.ext) is preferred over METHOD.ext.
 *
 * example:
 *   Filesystem:
 *   - TEST
 *       |- 00
 *       |   |- GET.json
 *       |- __
 *           |- GET.json
 *
 *   /TEST/00   -> /TEST/00/GET.json
 *   /TEST/ABCD -> /TEST/__/GET.json
 *
 * Body files can have any extension (GET.json, GET.xml, GET.png, ...), see chooseBodyFile.
 *
 * @param lookup see createFileLookup
 * @param kind 'header' for the .header file, 'rules' for the .rules.json file, 'body' for the response body
 * @param accept the request's Accept header (only used for kind 'body')
 * @return absolute file path or null when nothing matches
 */
function resolveMockFile(mockDir, lookup, url, method, kind, accept) {
  const parts = splitUrl(url);
  if (!parts) return null;
  const { segments, query } = parts;
  const prefixes = [];
  if (query) {
    prefixes.push(method + QUERY_SEPARATOR + safeFileName(query) + '.');
    prefixes.push(method + QUERY_SEPARATOR + query + '.');
  }
  prefixes.push(method + '.');

  const pickInDir = dir => {
    const files = lookup.list(dir);
    for (const prefix of new Set(prefixes)) {
      if (kind === 'header' || kind === 'rules') {
        const name = prefix + SPECIAL_EXT[kind];
        if (files.includes(name)) return path.join(dir, name);
        continue;
      }
      const bodies = files.filter(name => {
        if (!name.startsWith(prefix)) return false;
        const ext = name.slice(prefix.length);
        // skip header / rules files and editor leftovers (GET.json~, GET.json.swp)
        return ext !== '' && !SPECIAL_EXTS.has(ext) && !ext.endsWith('~') && !ext.endsWith('.swp');
      });
      if (bodies.length) return path.join(dir, chooseBodyFile(bodies.sort(), accept));
    }
    return null;
  };

  const search = (dir, i) => {
    if (i === segments.length) return pickInDir(dir);
    for (const name of new Set([safeFileName(segments[i]), segments[i], WILDCARD])) {
      const next = path.join(dir, name);
      if (lookup.isDir(next)) {
        const found = search(next, i + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return search(mockDir, 0);
}

// ----------------------- server -----------------------

function readOptionalFile(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/**
 * creates (but does not start) the mock server
 * @param {Partial<ServerOptions>} [options] see DEFAULTS
 * @return {http.Server}
 */
function createMockServer(options = {}) {
  /** @type {ServerOptions} */
  const opts = { ...DEFAULTS, ...options };
  const log = opts.logger || createLogger(opts.verbose);

  // a recording can start with an empty folder
  if (opts.record && opts.target && !fs.existsSync(opts.mockDir)) fs.mkdirSync(opts.mockDir, { recursive: true });
  if (!fs.existsSync(opts.mockDir) || !fs.statSync(opts.mockDir).isDirectory()) {
    throw new Error(`Mock directory '${opts.mockDir}' does not exist`);
  }
  const mockDir = fs.realpathSync(opts.mockDir);

  const optionsHeaderFile = path.join(mockDir, 'OPTIONS.header');
  const defaultHeaderFile = path.join(mockDir, 'DEFAULT.header');
  let OPTIONS_HEADER;
  let DEFAULT_HEADER;
  // a broken header file while editing must not kill the server, keep the previous one
  const loadRootHeader = (file, fallback, label, previous) => {
    const content = readOptionalFile(file);
    if (content === null) {
      if (!previous) log(LOG_LVL.LOG, `File: --> ${file}\nis not provided, default ${label} is used:\n${fallback}\n`);
      return parseHeader(fallback);
    }
    try {
      return parseHeader(content);
    } catch (e) {
      if (!previous) throw e;
      log(LOG_LVL.ERROR, `${e.message} (${file}), keeping the previous version`);
      return previous;
    }
  };
  const loadRootHeaders = () => {
    OPTIONS_HEADER = loadRootHeader(optionsHeaderFile, DEFAULT_OPTIONS_HEADER, 'OPTIONS response', OPTIONS_HEADER);
    DEFAULT_HEADER = loadRootHeader(defaultHeaderFile, DEFAULT_DEFAULT_HEADER, 'header', DEFAULT_HEADER);
  };
  loadRootHeaders();

  const lookup = createFileLookup(mockDir, opts.liveCheck);
  const resolve = (req, method, kind) => {
    const file = resolveMockFile(mockDir, lookup, req.url, method, kind, req.headers.accept);
    if (file) log(LOG_LVL.DEBUG, 'FILE FOUND: ' + file);
    return file;
  };

  // pick up added / changed / removed mocks without a restart
  let watcher = null;
  let startupReload = null;
  if (opts.watch) {
    let timer = null;
    const reload = reason => {
      lookup.rebuild();
      loadRootHeaders();
      log(LOG_LVL.DEBUG, `${reason}, reloaded`);
    };
    const onChange = () => {
      clearTimeout(timer);
      // editors and generators write many files at once, rebuild once they are done
      timer = setTimeout(() => reload('mock directory changed'), opts.watchDelay);
    };
    // some watchers start asynchronously (FSEvents on macOS) and miss changes made in their first
    // moments, so reload once more shortly after the start
    startupReload = setTimeout(() => reload('startup check'), opts.startupReloadDelay);
    startupReload.unref();
    try {
      // the live check only needs to know about DEFAULT.header / OPTIONS.header in the root
      watcher = fs.watch(mockDir, { recursive: !opts.liveCheck }, onChange);
      watcher.on('error', e => log(LOG_LVL.WARN, `Watching ${mockDir} failed: ${e.message}`));
      watcher.unref();
    } catch (e) {
      log(LOG_LVL.WARN, `Watching ${mockDir} is not supported (${e.message}), restart to pick up changes`);
    }
  }

  // mock root relative path for the request log
  const rel = file => path.relative(mockDir, file).split(path.sep).join('/');

  /**
   * @param trace collects what answered the request, logged once the response is sent
   */
  async function handleRequest(req, res, trace) {
    log(LOG_LVL.DEBUG, `${req.method} - HTTP Call for: ${req.url}`);
    const method = req.method.toUpperCase();

    // special handling for option calls (CORS preflight)
    if (method === 'OPTIONS') {
      const headerFile = resolve(req, method, 'header');
      const header = headerFile ? parseHeader(await fsp.readFile(headerFile, 'utf8')) : OPTIONS_HEADER;
      trace.source = headerFile ? rel(headerFile) : 'default OPTIONS header';
      await applyHeader(res, header);
      return res.end();
    }

    const find = m => ({
      rulesFile: resolve(req, m, 'rules'),
      headerFile: resolve(req, m, 'header'),
      bodyFile: resolve(req, m, 'body')
    });
    let found = find(method);
    // HEAD answers like GET without a body, unless HEAD mocks exist
    if (method === 'HEAD' && !found.rulesFile && !found.headerFile && !found.bodyFile) {
      found = find('GET');
    }

    // the request body is only read when rules or the proxy need it
    let requestBody = null;
    const getRequestBody = async () => (requestBody ??= await rules.readRequestBody(req));
    // request data for rules and templates
    let info = null;
    const getRequestInfo = async () => {
      if (!info) {
        const parts = splitUrl(req.url);
        info = {
          ...rules.requestInfo(req, await getRequestBody()),
          method,
          url: req.url,
          segments: parts ? parts.segments : []
        };
      }
      return info;
    };

    if (found.rulesFile) {
      const content = await fsp.readFile(found.rulesFile, 'utf8');
      const list = rules.parseRules(content, found.rulesFile);
      const request = await getRequestInfo();
      const counts = ruleCounters(found.rulesFile, content);
      const index = list.findIndex(
        (rule, i) =>
          rules.ruleMatches(rule, request) &&
          (rule.times === undefined || (counts.get(i) || 0) < rule.times) &&
          (rule.probability === undefined || Math.random() < rule.probability)
      );
      if (index >= 0) {
        const rule = list[index];
        counts.set(index, (counts.get(index) || 0) + 1);
        trace.source = `rule #${index} in ${rel(found.rulesFile)}`;
        if (rule.times !== undefined) trace.source += ` (${counts.get(index)}/${rule.times})`;
        if (rule.fault) trace.source += ` fault: ${rule.fault}`;
        return sendRule(res, method, rule, path.dirname(found.rulesFile), request);
      }
      log(LOG_LVL.DEBUG, `no rule matched in ${found.rulesFile}, using the mock files`);
    }

    const { headerFile, bodyFile } = found;
    const [headerContent, fileContent] = await Promise.all([
      headerFile ? fsp.readFile(headerFile, 'utf8') : null,
      bodyFile ? fsp.readFile(bodyFile) : null
    ]);
    const body =
      fileContent && templates.isTemplateFile(bodyFile)
        ? Buffer.from(
            templates.render(fileContent.toString('utf8'), await getRequestInfo(), templates.escapingFor(bodyFile))
          )
        : fileContent;

    if (body === null && !headerFile) {
      // paths rejected by splitUrl (i.e. '..') are not forwarded either
      if (opts.target && splitUrl(req.url)) return proxyRequest(req, res, method, await getRequestBody(), trace);
      trace.source = 'no mock found';
      trace.failed = true;
      await applyHeader(res, DEFAULT_HEADER);
      res.statusCode = 404;
      return res.end();
    }

    // a .header file without a body is a valid mock (i.e. 204 No Content, redirects)
    trace.source = rel(bodyFile || headerFile);
    const header = headerContent !== null ? parseHeader(headerContent) : DEFAULT_HEADER;
    await applyHeader(res, header);
    if (body === null) return res.end();

    // Content-Type: the resource's own .header file wins, then the file extension.
    // .json keeps the DEFAULT.header type, so custom types like application/hal+json still work.
    const ownType = headerContent !== null && header.headers.some(([n]) => n.toLowerCase() === 'content-type');
    if (!ownType && (extensionOf(bodyFile) !== 'json' || !res.hasHeader('content-type'))) {
      res.setHeader('Content-Type', contentTypeFor(bodyFile));
    }
    if (!res.hasHeader('content-length')) res.setHeader('Content-Length', body.length);
    if (method === 'HEAD') return res.end();
    res.end(body);
  }

  // how often each rule answered: rules file -> { hash of its content, rule index -> count }
  const ruleUsage = new Map();
  /**
   * @return the counters of a rules file, they start over when the file content changes
   */
  function ruleCounters(file, content) {
    const hash = crypto.createHash('sha1').update(content).digest('hex');
    let usage = ruleUsage.get(file);
    if (!usage || usage.hash !== hash) {
      usage = { hash, counts: new Map() };
      ruleUsage.set(file, usage);
    }
    return usage.counts;
  }

  /**
   * simulates a broken connection instead of an http answer
   * @param fault 'reset' | 'close' | 'timeout'
   */
  function sendFault(res, fault) {
    const socket = res.socket;
    if (fault === 'timeout') return; // never answer, the client has to give up
    if (!socket) return;
    if (fault === 'reset' && typeof socket.resetAndDestroy === 'function') {
      socket.resetAndDestroy(); // TCP reset, the client sees ECONNRESET
    } else {
      socket.destroy(); // closed without an answer ("socket hang up" / empty reply)
    }
  }

  /**
   * answers a request with a matched rule (see lib/rules.js)
   * @param dir folder of the rules file, "file" is resolved against it
   * @param request request data for the placeholders in headers and body
   */
  async function sendRule(res, method, rule, dir, request) {
    if (rule.delay > 0) await delay(rule.delay);
    if (rule.fault) return sendFault(res, rule.fault);
    const extra = Object.entries(rule.headers || {}).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map(v => [name, templates.render(String(v), request, 'header')])
    );
    const ruleNames = new Set(extra.map(([n]) => n.toLowerCase()));
    const header = {
      statusCode: rule.status || 200,
      headers: [...DEFAULT_HEADER.headers.filter(([n]) => !ruleNames.has(n.toLowerCase())), ...extra]
    };

    let body = null;
    let type = null;
    if (rule.file !== undefined) {
      const file = path.resolve(dir, rule.file);
      const rel = path.relative(mockDir, file);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Rule file '${rule.file}' is outside of the mock directory`);
      }
      body = await fsp.readFile(file);
      if (templates.isTemplateFile(file)) {
        body = Buffer.from(templates.render(body.toString('utf8'), request, templates.escapingFor(file)));
      }
      type = contentTypeFor(file);
    } else if (rule.body !== undefined) {
      if (typeof rule.body === 'string') {
        // sent with the DEFAULT.header content type
        body = Buffer.from(templates.render(rule.body, request, 'raw'));
      } else {
        body = Buffer.from(templates.render(JSON.stringify(rule.body, null, 4), request, 'json'));
        type = contentTypeFor('x.json');
      }
    }

    await applyHeader(res, header);
    if (body === null) return res.end();
    // same precedence as for mock files: rule headers, then DEFAULT.header for JSON, then the extension
    if (
      type &&
      !ruleNames.has('content-type') &&
      (!type.startsWith('application/json') || !res.hasHeader('content-type'))
    ) {
      res.setHeader('Content-Type', type);
    }
    res.setHeader('Content-Length', body.length);
    res.end(method === 'HEAD' ? undefined : body);
  }

  /**
   * forwards a request without a mock to the proxy target, optionally records the answer
   */
  async function proxyRequest(req, res, method, body, trace) {
    let upstream;
    try {
      upstream = await proxy.forward({ target: opts.target, req, method, body, timeout: opts.proxyTimeout });
    } catch (e) {
      const reason = (e.cause && e.cause.message) || e.message;
      trace.source = `proxy to ${opts.target} failed: ${reason}`;
      trace.failed = true;
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(`Proxy to ${opts.target} failed: ${reason}`);
    }
    trace.source = `proxy ${opts.target}`;
    const headers = proxy.withDefaults(upstream.headers, DEFAULT_HEADER.headers);
    // record first, so the files exist when the client sends its next request
    if (opts.record && method !== 'HEAD') {
      const count = recordResponse(req, method, upstream.status, headers, upstream.body);
      if (count) trace.source += `, recorded ${count} file(s)`;
    }
    await applyHeader(res, { statusCode: upstream.status, headers });
    if (method === 'HEAD') return res.end();
    res.setHeader('Content-Length', upstream.body.length);
    res.end(upstream.body);
  }

  /**
   * @return number of written files
   */
  function recordResponse(req, method, status, headers, body) {
    if (status >= 500) {
      log(LOG_LVL.WARN, `NOT RECORDED: ${method} ${req.url} answered ${status}`);
      return 0;
    }
    const parts = splitUrl(req.url);
    if (!parts) return 0;
    const dir = path.join(mockDir, ...parts.segments.map(safeFileName));
    const baseName = parts.query ? method + QUERY_SEPARATOR + safeFileName(parts.query) : method;
    // user defined headers (i.e. a delay from DEFAULT.header) apply anyway, don't copy them into the mock
    const recorded = headers.filter(([n]) => !USER_DEFINED_HEADERS.has(n.toLowerCase()));
    try {
      const written = proxy.record({ dir, baseName, status, headers: recorded, body, mimeTypes: MIME_TYPES });
      written.forEach(f => log(LOG_LVL.SUCCESS, 'RECORDED: ' + f));
      if (written.length) lookup.rebuild();
      return written.length;
    } catch (e) {
      log(LOG_LVL.ERROR, `Recording ${method} ${req.url} failed: ${e.message}`);
      return 0;
    }
  }

  if (opts.record && !opts.target) {
    log(LOG_LVL.WARN, 'Recording (-r) needs a proxy target (-t), nothing will be recorded');
  }

  const server = http.createServer((req, res) => {
    const start = process.hrtime.bigint();
    const trace = { source: '', failed: false };
    // one line per request: method, url, status, duration and what answered it
    res.on('close', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const status = res.writableFinished ? res.statusCode : 'aborted';
      const line =
        `${req.method} ${req.url} ${status} ${ms.toFixed(1)}ms` + (trace.source ? ` <- ${trace.source}` : '');
      log(trace.failed ? LOG_LVL.ERROR : LOG_LVL.INFO, line);
    });
    handleRequest(req, res, trace).catch(err => {
      const status = (err && err.statusCode) || 500;
      trace.source = `error: ${err && err.message}`;
      trace.failed = true;
      log(
        status >= 500 ? LOG_LVL.FATAL : LOG_LVL.ERROR,
        'Error: ' + (status >= 500 && err && err.stack ? err.stack : err)
      );
      if (!res.headersSent) {
        res.statusCode = status;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.end(String(err));
    });
  });
  server.maxConnections = 100;
  server.on('close', () => {
    clearTimeout(startupReload);
    if (watcher) watcher.close();
  });
  return server;
}

// ----------------------- CLI -----------------------
function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const log = createLogger(options.verbose);
  let server;
  try {
    server = createMockServer({ ...options, logger: log });
  } catch (e) {
    log(LOG_LVL.FATAL, e.message);
    process.exit(1);
  }
  server.on('error', err => {
    log(LOG_LVL.FATAL, `Server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(options.port, options.host, () => {
    const { port } = server.address();
    log(LOG_LVL.LOG, `Server running at http://${options.host}:${port}/ serving ${options.mockDir}`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    // requests held open by a "timeout" fault must not block the shutdown
    server.closeAllConnections();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  createMockServer,
  parseArgs,
  parseHeader,
  resolveMockFile,
  splitUrl,
  safeFileName,
  chooseBodyFile,
  contentTypeFor,
  DEFAULTS,
  LOG_LVL
};
