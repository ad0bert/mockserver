var http = require('https');
var path = require('path');
var fs = require('fs');

async function createDirectories(pathname) {
   const __dirname = path.resolve();
   pathname = pathname.replace(/^\.*\/|\/?[^\/]+\.[a-z]+|\/$/g, ''); // Remove leading directory markers, and remove ending /file-name.extension
   await fs.mkdir(path.resolve(__dirname, pathname), { recursive: true }, e => {
       if (e) {
           console.error('Failed');
       } else {
           console.log('Success');
       }
    });
}  

function get(url) {
  var request = http.get(url, function(response) {
    
    let body = '';
    response.on('data', function(chunk) {
      body += chunk;
    });
    response.on('end', function() {
      let data = JSON.parse(body);
      for (let path in data.paths) {
        let toCreate = '/mocks' + path.replace(/{.*}/g,'__');
	for (let fileName in data.paths[path]) {
          let toWrite = toCreate + '/' + fileName + '.mock';
          createDirectories(toWrite);
          toWrite = __dirname + toWrite;
	  if (!fs.exists(toWrite)) {
	    fs.writeFile(toWrite, null, function(err) {
	      if (err) console.log('err');
              console.log('create file');
	    });
	  }
	}
      }
    });
  });
}

get('https://petstore.swagger.io/v2/swagger.json');


