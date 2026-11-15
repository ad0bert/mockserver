# Demo: Swagger Petstore

A mock of the [Swagger Petstore](https://github.com/swagger-api/swagger-petstore) API (OpenAPI 3), generated from
its spec and then edited by hand to show what the mock server can do.

```console
user@local:~$ npm run demo
Server running at http://127.0.0.1:8181/ serving .../demo/mocks
```

All examples below use `curl` against that server. The mocks live in [`mocks/api/v3`](mocks/api/v3).

## How it was made

```console
user@local:~$ npm install
user@local:~$ node generate-mock-structure.js demo/petstore/openapi.yaml demo/mocks
```

The generator turns every operation of [`petstore/openapi.yaml`](petstore/openapi.yaml) into a mock file, for example
`GET /pet/{petId}` → `mocks/api/v3/pet/__/GET.json`, using the examples from the spec. Operations with a request body
also get an example request (`POST.request.json`), which the server never sends. The endpoints below were then edited
to show the other features; everything else is still plain generated output.

## What to try

### Placeholders: the pet you ask for

`pet/__/GET.tpl.json` is a template, so the id comes from the path. `GET.tpl.xml` next to it answers clients that ask
for XML:

```console
user@local:~$ curl localhost:8181/api/v3/pet/42
{ "id": 42, "name": "doggie", ... "photoUrls": ["https://example.com/photos/42.jpg"], ... }
user@local:~$ curl -H 'Accept: application/xml' localhost:8181/api/v3/pet/42
<Pet><id>42</id> ...
```

### Literal folders before wildcards

`pet/404/` exists next to `pet/__/`, so that one id gets its own answer (a `.header` file with the status, plus a body):

```console
user@local:~$ curl -i localhost:8181/api/v3/pet/404
HTTP/1.1 404 Not Found
{ "code": 404, "message": "Pet not found" }
```

### Rules: answers depending on the query

`pet/findByStatus/GET.rules.json` returns different pets per `status`, and a 400 for unknown values:

```console
user@local:~$ curl 'localhost:8181/api/v3/pet/findByStatus?status=sold'
[{ "id": 3, "name": "Rex", ... "status": "sold" }]
user@local:~$ curl 'localhost:8181/api/v3/pet/findByStatus?status=bogus'
{ "code": 400, "message": "Invalid status value 'bogus'" }
```

### Rules with placeholders: login

`user/login/GET.rules.json` accepts one user and fills the session id and expiry per request:

```console
user@local:~$ curl -i 'localhost:8181/api/v3/user/login?username=user1&password=secret'
HTTP/1.1 200 OK
X-Rate-Limit: 100
X-Expires-After: 2026-01-01T12:00:00.000Z
logged in user session:5f9f1d12-8004-465e-81ae-46f5f3c796f4
user@local:~$ curl 'localhost:8181/api/v3/user/login?username=x&password=y'
Invalid username/password supplied
```

### Echoing the request body

`store/order/POST.tpl.json` takes `petId` and `quantity` from the request:

```console
user@local:~$ curl -X POST -H 'Content-Type: application/json' -d '{"petId": 42, "quantity": 3}' localhost:8181/api/v3/store/order
{ "id": 378, "petId": 42, "quantity": 3, "shipDate": "...", "status": "placed", "complete": false }
```

### Sequences: fail twice, then succeed

`store/inventory/GET.rules.json` answers the first two requests with a 503, then the normal `GET.json` takes over.
Good for testing retry logic. The count starts over when you restart the server or edit the rules file.

```console
user@local:~$ for i in 1 2 3; do curl -s -o /dev/null -w '%{http_code}\n' localhost:8181/api/v3/store/inventory; done
503
503
200
```

### Random failures

`store/order/__/GET.rules.json` fails roughly every 4th request (`"probability": 0.25`):

```console
user@local:~$ for i in $(seq 12); do curl -s -o /dev/null -w '%{http_code} ' localhost:8181/api/v3/store/order/1; done
200 500 200 200 500 200 500 500 200 200 200 200
```

### Connection faults and slow answers

`user/__/GET.rules.json` breaks the connection, never answers, or answers slowly, depending on a header:

```console
user@local:~$ curl -H 'X-Demo-Fault: reset' localhost:8181/api/v3/user/ann
curl: (56) Recv failure: Connection reset by peer
user@local:~$ curl -m 3 -H 'X-Demo-Fault: timeout' localhost:8181/api/v3/user/ann
curl: (28) Operation timed out after 3001 milliseconds with 0 bytes received
user@local:~$ curl -H 'X-Demo-Fault: slow' localhost:8181/api/v3/user/ann   # answers after 2 seconds
```

Without the header, `GET.tpl.json` answers with the user from the path.

### Recording the real API

Instead of generating mocks, you can record them from the real Petstore. Requests without a mock are forwarded and
saved into `recorded/`:

```console
user@local:~$ node mockserver.js -m demo/recorded -t https://petstore3.swagger.io -r true
user@local:~$ curl localhost:8181/api/v3/pet/10
```

The folder is created if needed. After that request, `demo/recorded/api/v3/pet/10/` holds a `GET.header` and a
`GET.json`, and the next request for that pet is answered from them without the real API.

## License

The Petstore spec in [`petstore/`](petstore) is from [swagger-api/swagger-petstore](https://github.com/swagger-api/swagger-petstore)
and is licensed under the [Apache License 2.0](petstore/LICENSE). The mock files were generated from it.
