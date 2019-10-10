const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

// const demoHeader = 'HTTP/1.1 200 OK\nContent-Type: application/json\n\n';
// const demoHeader = 'HTTP/1.1 200 OK\nContent-Type: application/json; charset=utf-8\nAccess-Control-Allow-Origin: *\nAccess-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Cache-Control, Pragma, Expires, Authorization, X-Request-ID\nAccess-Control-Allow-Methods: GET, POST, OPTIONS, DELETE, PUT\n\n';
// TODO generate DEFAULT .header file on mock structure top level
const demoHeader = '';

function createDirectories(pathname) {
  const __dirname = path.resolve();
  let currPath = path.resolve(__dirname, '');
  pathname.split('/').forEach(value => {
    if (!fs.existsSync(currPath)) {
      fs.mkdirSync(path.resolve(__dirname, currPath));
    }
    currPath += '/' + value;
  });
}

function buildDirectoryTree(data) {
  for (let path in data.paths) {
    let toCreate = '/mocks' + data.basePath + path.replace(/{.*}/g, '__');
    let fileCreate = data.basePath + path.replace(/{.*}/g, '__');
    for (let fileName in data.paths[path]) {
      let toWrite = toCreate + '/';
      createDirectories(toWrite);
      toWrite =
        __dirname +
        '/mocks' +
        fileCreate +
        '/' +
        fileName.toUpperCase() +
        '.json';
      let response = data.paths[path][fileName]['responses']['200'];
      let demoFile = demoHeader;
      if (response && response['schema']) {
        let body = createFileBody(data, response['schema']);
        try {
          demoFile += JSON.stringify(JSON.parse(body), null, 4);
        } catch (e) {
          demoFile += body;
        }
      } else {
        demoFile += JSON.stringify(
          JSON.parse('{ "auto_generated": true }'),
          null,
          4
        );
      }
      if (!fs.existsSync(toWrite)) {
        fs.writeFile(toWrite, demoFile, function(err) {
          if (err) console.log(err);
        });
      }
    }
  }
}

function createObject(ref, json) {
  if (ref['type'] == 'object') {
    let res = '{ ';
    for (let props in ref['properties']) {
      res +=
        '"' +
        props +
        '": ' +
        createObject(ref['properties'][props], json) +
        ',';
    }
    res = res.substring(0, res.length - 1);
    return res + ' }';
  } else if (ref['type'] === 'array') {
    return '[' + createObject(ref['items'], json) + ']';
  } else if (ref['type'] === 'string') {
    if (ref['format'] && ref['format'] === 'date-time') {
      return '"' + new Date().toISOString() + '"';
    } else if (ref['format'] && ref['format'] === 'uuid') {
      return '"6c84fb90-12c4-11e1-840d-7b25c5ee775a"';
    } else {
      return '"string"';
    }
  } else if (ref['type'] === 'integer' || ref['type'] === 'number') {
    return '0';
  } else if (ref['type'] === 'boolean') {
    return 'false';
  } else {
    return createObject(getJsonRef(json, ref['$ref']), json);
  }
}

function getJsonRef(json, path) {
  let parts = path.split('/');
  return json[parts[1]][parts[2]];
}

function createFileBody(json, schema) {
  if (schema['type'] && schema['type'] == 'array') {
    return (
      '[' + createObject(getJsonRef(json, schema['items']['$ref']), json) + ']'
    );
  } else if (schema['type'] && schema['type'] == 'object') {
    if (schema['additionalProperties']['type'] == 'integer') {
      return '{ "additonalProperty1": 0, "additionalProperty2": 0 }';
    } else if (schema['additionalProperties']['type'] == 'string') {
      return '{ "additionalProperty1": "string", "additionalProperty2": "string"';
    } else {
      console.error('Cannot create dummy for: ' + schema);
      return '';
    }
  } else if (schema['type'] && schema['type'] == 'string') {
    return 'string';
  } else if (schema['type'] && schema['type'] == 'integer') {
    return '0';
  } else if (schema['type'] && schema['type'] == 'boolean') {
    return 'false';
  } else if (schema['type'] && schema['type'] == 'file') {
    return 'file-not-supported';
  } else {
    return createObject(getJsonRef(json, schema['$ref']), json);
  }
}

function handleHttpResponse(response) {
  let body = '';
  response.on('data', function(chunk) {
    body += chunk;
  });
  response.on('end', function() {
    buildDirectoryTree(JSON.parse(body));
  });
}

function get(url) {
  if (url.startsWith('https')) {
    https.get(url, handleHttpResponse);
  } else if (url.startsWith('http')) {
    http.get(url, handleHttpResponse);
  } else {
    const filePath = path.resolve(__dirname, url);
    if (fs.existsSync(filePath)) {
      buildDirectoryTree(JSON.parse(fs.readFileSync(filePath).toString()));
    }
  }
}

get(process.argv[2]);
