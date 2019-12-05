/**
 * @author Peter Ortner
 */

// imports
const http = require('http');
const fs = require('fs');
const path = require('path');
const util = require('util');

// Convert fs.readFile into Promise version of same
const readFile = util.promisify(fs.readFile);
const hostname = '127.0.0.1';

// program defaults
const DEFAULT_PORT = 8181;
const DEFAULT_LIVE = 'true';
const DEFAULT_PATH = '../mocks';
const DEFAULT_VERB = 2;

const paramMap = new Map();
paramMap.set('-p', DEFAULT_PORT);
paramMap.set('-m', DEFAULT_PATH);
paramMap.set('-l', DEFAULT_LIVE);
paramMap.set('-v', DEFAULT_VERB);

// ----------------------- logging util -----------------------
const LOG_LVL = {
  DEBUG: 'debug',
  INFO: 'info',
  LOG: 'log',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal'
};
const logLvlMap = new Map();
logLvlMap.set(LOG_LVL.LOG, '\x1b[39m');
logLvlMap.set(LOG_LVL.INFO, '\x1b[34m');
logLvlMap.set(LOG_LVL.SUCCESS, '\x1b[32m');
logLvlMap.set(LOG_LVL.DEBUG, '\x1b[32m');
logLvlMap.set(LOG_LVL.WARN, '\x1b[33m');
logLvlMap.set(LOG_LVL.ERROR, '\x1b[31m');
logLvlMap.set(LOG_LVL.FATAL, '\x1b[31m');

function log(type, message) {
  if (IGNORE_LOG.includes(type)) return;
  switch (type) {
    case LOG_LVL.LOG:
      console.log(logLvlMap.get(type), message);
      break;
    case LOG_LVL.INFO:
      console.info(logLvlMap.get(type), message);
      break;
    case LOG_LVL.SUCCESS:
      console.info(logLvlMap.get(type), message);
      break;
    case LOG_LVL.DEBUG:
      console.debug(logLvlMap.get(type), message);
      break;
    case LOG_LVL.WARN:
      console.warn(logLvlMap.get(type), message);
      break;
    case LOG_LVL.ERROR:
      console.error(logLvlMap.get(type), message);
      break;
    case LOG_LVL.FATAL:
      console.error(logLvlMap.get(type), message);
      break;
    default:
      console.error(logLvlMap.get(LOG_LVL.FATAL), message);
      break;
  }
}

// ----------------------- parse program arguments -----------------------

if (process.argv.length % 2 !== 0) {
  log(
    LOG_LVL.LOG,
    'Usage: ' +
      __filename +
      ' -p PORT -m PATH -v VERBOSE(0-4) -l DISABLE LIVE PATH CHECK(true)'
  );
  process.exit(-1);
}

for (let i = 2; i < process.argv.length; i += 2) {
  if (paramMap.get(process.argv[i]) === undefined) {
    log(
      LOG_LVL.LOG,
      'Usage: ' +
        __filename +
        ' -p PORT -m PATH -v VERBOSE(0-4) -l DISABLE LIVE PATH CHECK(true)'
    );
    process.exit(-1);
  } else {
    paramMap.set(process.argv[i], process.argv[i + 1]);
  }
}

const isLiveCheck = paramMap.get('-l') === 'true';
const port = paramMap.get('-p');
const MOCK_PATH = fs
  .realpathSync(__dirname + '/' + paramMap.get('-m'))
  .replace(/\\/g, '/');

const IGNORE_LOG = [
  LOG_LVL.LOG,
  LOG_LVL.INFO,
  LOG_LVL.SUCCESS,
  LOG_LVL.WARN,
  LOG_LVL.DEBUG
].slice(paramMap.get('-v'));

// ----------------------- read default files -----------------------

const DEFAULT_OPTIONS_HEADER =
  'HTTP/1.1 202 Accepted\n' +
  'Content-Length: 0\n' +
  'X-Powered-By: Undertow/1\n' +
  'Access-Control-Allow-Origin: *\n' +
  'Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Cache-Control, Pragma, Expires, Authorization, X-Request-ID\n' +
  'Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE, PUT';
const hasOptionsHeader = fs.existsSync(MOCK_PATH + '/OPTIONS.header');
if (!hasOptionsHeader) {
  log(
    LOG_LVL.LOG,
    'File: --> ' +
      MOCK_PATH +
      '/OPTIONS.header\nis not provided default OPTIONS response is used:\n' +
      DEFAULT_OPTIONS_HEADER +
      '\n'
  );
}
const OPTIONS_HEADER = hasOptionsHeader
  ? fs.readFileSync(MOCK_PATH + '/OPTIONS.header').toString()
  : DEFAULT_OPTIONS_HEADER;

const DEFAULT_DEFAULT_HEADER =
  'HTTP/1.1 200 OK\n' +
  'Content-Type: application/json; charset=utf-8\n' +
  'Access-Control-Allow-Origin: *\n' +
  'Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Cache-Control, Pragma, Expires, Authorization, X-Request-ID\n' +
  'Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE, PUT';
// 'User-Defined-Delay: 1000';
const hasDefaultHeader = fs.existsSync(MOCK_PATH + '/DEFAULT.header');
if (!hasDefaultHeader) {
  log(
    LOG_LVL.LOG,
    'File: --> ' +
      MOCK_PATH +
      '/DEFAULT.header\nis not provided default header is used:\n' +
      DEFAULT_DEFAULT_HEADER +
      '\n'
  );
}
const DEFAULT_HEADER = hasDefaultHeader
  ? fs.readFileSync(MOCK_PATH + '/DEFAULT.header').toString()
  : DEFAULT_DEFAULT_HEADER;

// ----------------------- handle user defined headers ----------------------- //

const userDefinedHeaders = new Map();
userDefinedHeaders.set('User-Defined-Delay', ms => {
  return new Promise(resolve => setTimeout(resolve, ms));
});

// ----------------------- build file list to reduce I/O ----------------------- //
const MOCK_FILE_PATH_LIST = [];

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = path.join(dir, f);
    let isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
}
if (!isLiveCheck) {
  walkDir(MOCK_PATH, function(filePath) {
    MOCK_FILE_PATH_LIST.push(filePath.replace(/\\/g, '/'));
  });
}

function doesFileExist(file) {
  if (isLiveCheck) {
    return fs.existsSync(file);
  }
  for (let i = 0; i < MOCK_FILE_PATH_LIST.length; ++i) {
    if (MOCK_FILE_PATH_LIST[i].startsWith(file)) {
      return true;
    }
  }
  return false;
}

// ----------------------- startup server ----------------------- //
const server = http.createServer();
server.maxConnections = 100;
server.on('request', handleRequest);
server.listen(port, hostname, () => {
  log(LOG_LVL.LOG, `Server running at http://${hostname}:${port}/`);
});

/**
 * handle server requests
 * @param req server request
 * @param res server result
 */
async function handleRequest(req, res) {
  // special handling for option calls
  if (req.method === 'OPTIONS') {
    return fillHeader(res, OPTIONS_HEADER).then(() => {
      res.end();
    });
  }

  // normal request handling (PUT, GET, POST, ...)
  log(LOG_LVL.INFO, req.method + ' - HTTP Call for: ' + req.url);
  const filePath = checkAndFixPath(
    buildPathFromUrl(req.url, req.method, '.json')
  );
  const headerPath = checkAndFixPath(
    buildPathFromUrl(req.url, req.method, '.header')
  );
  return getFileContent(headerPath)
    .then(header => {
      const fileContent = header ? header.toString() : DEFAULT_HEADER;
      return fillHeader(res, fileContent).then(() => {
        return getFileContent(filePath).then(resource => {
          if (resource) {
            res.write(resource.toString());
          } else {
            log(
              LOG_LVL.ERROR,
              'NOT FOUND: ' + buildPathFromUrl(req.url, req.method, '.json')
            );
            res.statusCode = 404;
          }
        });
      });
    })
    .catch(ex => {
      log(LOG_LVL.FATAL, 'Error: ' + ex.toString());
      res.statusCode = 500;
      res.write(ex.toString());
    })
    .finally(() => {
      res.end();
    });
}

/**
 * fills the server response with header information
 * @param res server response
 * @param headerContent header information + custom headers
 */
async function fillHeader(res, headerContent) {
  const lines = headerContent.split(/\r?\n/g);
  // SET HTTP STATUS
  res.statusCode = parseInt(lines[0].split(/\s+/g)[1]);
  // SET HTTP HEADERS
  for (let i = 1; i < lines.length; ++i) {
    if (lines[i].trim() === '') break;
    const headerLine = lines[i].split(':');
    if (userDefinedHeaders.get(headerLine[0])) {
      await userDefinedHeaders.get(headerLine[0])(headerLine[1]);
    } else {
      res.setHeader(headerLine[0].trim(), headerLine[1].trim());
    }
  }
}

/**
 * try to open the given resource.
 * @param filePath resource to pen
 * @return file content or null when nothing is found
 */
async function getFileContent(filePath) {
  return (await filePath) ? readFile(filePath) : null;
}

/**
 * checks if the given path is available if not try to resolve wildcards
 * @param filePath to check
 * @return resolved file path
 */
function checkAndFixPath(filePath) {
  let result = filePath;
  if (!doesFileExist(result)) {
    log(LOG_LVL.WARN, 'NOT FOUND: ' + result);
    log(LOG_LVL.WARN, '    --> check for wildcards ...');
    result = resolveWildcards(filePath);
  }
  if (result) {
    log(LOG_LVL.SUCCESS, 'FILE FOUND: ' + result);
  }
  return result;
}

/**
 * creates the corresponding filesystem path to the requested resource.
 * if the given request type is OPTIONS the corresponding resource must be located top level in the mock file structure
 *
 * @param url request url
 * @param type request type (i.e. GET, POST, PUT, DELETE, OPTIONS)
 * @param fileType file ending (i.e. '.json', '.headers'
 * @return path to the requested resource
 */
function buildPathFromUrl(url, type, fileType) {
  let pathParam = '';
  if (url.includes('?')) {
    pathParam = '--' + url.split('?')[1];
    url = url.split('?')[0];
  }
  if (!url.endsWith('/')) {
    url = url + '/';
  }
  return MOCK_PATH + url + type + pathParam + fileType;
}

/**
 * check the whole path from left to right to find where a folder is missing
 * then replace the missing folder with the wildcard '__'. This is redone until
 * the searched file is found in the wildcard directory.
 *
 * example:
 *   Filesystem:
 *   - TEST
 *       |- 00
 *       |   |- GET.json
 *       |
 *       |- 01
 *       |   |- GET.json
 *       |
 *       |- __
 *           |- GET.json
 *
 *   File requested /TEST/ABCD/GET.json
 *   Folder 02 is not available
 *   Replace 02 with __
 *   New Path is /TEST/__/GET.json
 *
 * @param filePath to resolve
 * @return new file path or null if no matching file is found
 */
function resolveWildcards(filePath) {
  const fileType = '.' + filePath.split('.').pop();
  const filePathParts = filePath.replace(MOCK_PATH, '').split('/');
  let currPathToCheck = MOCK_PATH + filePathParts[0];
  for (let i = 1; i < filePathParts.length - 1; ++i) {
    const checkNext = currPathToCheck + '/' + filePathParts[i];
    if (doesFileExist(checkNext)) {
      currPathToCheck = checkNext;
    } else {
      currPathToCheck += '/__';
      if (!doesFileExist(currPathToCheck)) {
        return null;
      }
    }
  }
  let fileName = filePathParts[filePathParts.length - 1];
  if (filePathParts[filePathParts.length - 1].includes('--')) {
    fileName =
      filePathParts[filePathParts.length - 1].substring(
        0,
        fileName.indexOf('--')
      ) + fileType;
  }
  const result = currPathToCheck + '/' + fileName;
  if (!doesFileExist(result)) {
    return null;
  }
  return result;
}
