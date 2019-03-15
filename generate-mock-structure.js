const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

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
      toWrite = __dirname + fileCreate + '/' + fileName.toUpperCase() + '.mock';
      if (!fs.existsSync(toWrite)) {
        fs.writeFile(toWrite, '', function (err) {
          if (err) console.log(err);
        });
      }
    }
  }
}

function handleHttpResponse(response) {
  let body = '';
  response.on('data', function (chunk) {
    body += chunk;
  });
  response.on('end', function () {
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
