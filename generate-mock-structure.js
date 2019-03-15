const http = require('http');
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

function get(url) {
  http.get(url, function(response) {
    let body = '';
    response.on('data', function(chunk) {
      body += chunk;
    });
    response.on('end', async function() {
      let data = JSON.parse(body);
      for (let path in data.paths) {
        let toCreate = '/mocks' + data.basePath + path.replace(/{.*}/g,'__');
        let fileCreate = data.basePath + path.replace(/{.*}/g,'__');
        for (let fileName in data.paths[path]) {
          let toWrite = toCreate + '/';
          await createDirectories(toWrite);
          toWrite = __dirname + fileCreate + '/' + fileName.toUpperCase() + '.mock';
          if (!fs.existsSync(toWrite)) {
            fs.writeFile(toWrite, '', function(err) {
              if (err) console.log(err);
            });
          }
        }
      }
    });
  });
}

get(process.argv[2]);
