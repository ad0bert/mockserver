# mockserver
Inspired by https://github.com/namshi/mockserver

## quick start
```
$ git clone https://github.com/ad0bert/mockserver.git
$ cd mockserver
$ node generate-mock-structure.js https://petstore.swagger.io/v2/swagger.json
$ node mockserver.js -p 8181 -m ./mocks
```
Open your browser and explore the routes for example: localhost:8181/v2/pet/1

