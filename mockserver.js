#!/usr/bin/env node
/**
 * Local webserver delivering mock responses for http requests.
 *
 * @author Peter Ortner
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// ----------------------- program defaults -----------------------
const DEFAULTS = Object.freeze({
  port: 8181,
  host: '127.0.0.1',
  mockDir: path.resolve(__dirname, '../mocks'),
  verbose: 2,
  liveCheck: true
});

const WILDCARD = '__';
const QUERY_SEPARATOR = '--';

const DEFAULT_OPTIONS_HEADER = [
  'HTTP/1.1 202 Accepted',
  'Content-Length: 0',
  'X-Powered-By: Undertow/1',
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
const VERBOSITY_ORDER = [
  LOG_LVL.LOG,
  LOG_LVL.INFO,
  LOG_LVL.SUCCESS,
  LOG_LVL.WARN,
  LOG_LVL.DEBUG
];

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
    const text = stream.isTTY
      ? `${COLORS[type] || COLORS[LOG_LVL.FATAL]}${message}${COLOR_RESET}`
      : String(message);
    stream.write(text + '\n');
  };
}

// ----------------------- parse program arguments -----------------------
const USAGE =
  'Usage: mockserver [-p PORT] [-H HOST] [-m MOCK_DIR] [-v VERBOSE(0-5)] [-l LIVE_CHECK(true|false)]';

/**
 * parses the command line arguments
 * @param argv arguments without node binary and script name
 * @return options object or throws on invalid input
 */
function parseArgs(argv) {
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
 * builds a lookup function for files and directories below the mock root
 * @param mockDir mock root
 * @param liveCheck true: check the filesystem on every request, false: index once at startup
 */
function createFileLookup(mockDir, liveCheck) {
  if (liveCheck) {
    return p => fs.existsSync(p);
  }
  const known = new Set([mockDir]);
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      known.add(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(mockDir);
  return p => known.has(p);
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
    if (
      segment === '.' ||
      segment === '..' ||
      /[/\\\0]/.test(segment)
    ) {
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
 * @return absolute file path or null when nothing matches
 */
function resolveMockFile(mockDir, exists, url, method, ext) {
  const parts = splitUrl(url);
  if (!parts) return null;
  const { segments, query } = parts;
  const candidates = [];
  if (query) candidates.push(method + QUERY_SEPARATOR + query + ext);
  candidates.push(method + ext);

  const search = (dir, i) => {
    if (i === segments.length) {
      for (const name of candidates) {
        const file = path.join(dir, name);
        if (exists(file)) return file;
      }
      return null;
    }
    for (const name of new Set([segments[i], WILDCARD])) {
      const next = path.join(dir, name);
      if (exists(next)) {
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
 * @param options see DEFAULTS
 * @return http.Server
 */
function createMockServer(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const log = opts.logger || createLogger(opts.verbose);

  if (!fs.existsSync(opts.mockDir) || !fs.statSync(opts.mockDir).isDirectory()) {
    throw new Error(`Mock directory '${opts.mockDir}' does not exist`);
  }
  const mockDir = fs.realpathSync(opts.mockDir);

  const optionsHeaderFile = path.join(mockDir, 'OPTIONS.header');
  const optionsHeaderContent = readOptionalFile(optionsHeaderFile);
  if (optionsHeaderContent === null) {
    log(LOG_LVL.LOG, `File: --> ${optionsHeaderFile}\nis not provided, default OPTIONS response is used:\n${DEFAULT_OPTIONS_HEADER}\n`);
  }
  const OPTIONS_HEADER = parseHeader(optionsHeaderContent ?? DEFAULT_OPTIONS_HEADER);

  const defaultHeaderFile = path.join(mockDir, 'DEFAULT.header');
  const defaultHeaderContent = readOptionalFile(defaultHeaderFile);
  if (defaultHeaderContent === null) {
    log(LOG_LVL.LOG, `File: --> ${defaultHeaderFile}\nis not provided, default header is used:\n${DEFAULT_DEFAULT_HEADER}\n`);
  }
  const DEFAULT_HEADER = parseHeader(defaultHeaderContent ?? DEFAULT_DEFAULT_HEADER);

  const exists = createFileLookup(mockDir, opts.liveCheck);
  const resolve = (url, method, ext) => {
    const file = resolveMockFile(mockDir, exists, url, method, ext);
    if (file) log(LOG_LVL.SUCCESS, 'FILE FOUND: ' + file);
    return file;
  };

  async function handleRequest(req, res) {
    log(LOG_LVL.INFO, `${req.method} - HTTP Call for: ${req.url}`);
    const method = req.method.toUpperCase();

    // special handling for option calls (CORS preflight)
    if (method === 'OPTIONS') {
      const headerFile = resolve(req.url, method, '.header');
      const header = headerFile ? parseHeader(await fsp.readFile(headerFile, 'utf8')) : OPTIONS_HEADER;
      await applyHeader(res, header);
      return res.end();
    }

    const headerFile = resolve(req.url, method, '.header');
    const bodyFile = resolve(req.url, method, '.json');
    const [headerContent, body] = await Promise.all([
      headerFile ? fsp.readFile(headerFile, 'utf8') : null,
      bodyFile ? fsp.readFile(bodyFile) : null
    ]);

    if (!body && !headerFile) {
      log(LOG_LVL.ERROR, `NOT FOUND: ${method} ${req.url}`);
      await applyHeader(res, DEFAULT_HEADER);
      res.statusCode = 404;
      return res.end();
    }

    // a .header file without a .json body is a valid mock (i.e. 204 No Content, redirects)
    await applyHeader(res, headerContent !== null ? parseHeader(headerContent) : DEFAULT_HEADER);
    if (method === 'HEAD' || !body) return res.end();
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      log(LOG_LVL.FATAL, 'Error: ' + (err && err.stack ? err.stack : err));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.end(String(err));
    });
  });
  server.maxConnections = 100;
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
  const shutdown = () => server.close(() => process.exit(0));
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
  DEFAULTS,
  LOG_LVL
};
