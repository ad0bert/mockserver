var http = require('https');

function get(url) {
  var request = http.get(url, function(response) {
    
    let body = '';
    response.on('data', function(chunk) {
      body += chunk;
    });
    response.on('end', function() {
      let data = JSON.parse(body);
      console.log(data);
    });
  });
}

get('https://petstore.swagger.io/v2/swagger.json');


