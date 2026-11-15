# mockserver

A local web server that answers HTTP requests from files: put `users/__/GET.json` in a folder and `GET /users/42`
returns it. It's meant for frontend and integration work against an API that isn't there yet, is unreliable, or
shouldn't be called from tests.

- **Mocks are files and folders**, so they live in git next to your code and are easy to review.
- **Generate them** from a Swagger 2.0 / OpenAPI 3 spec (JSON or YAML), or **record them** from a real backend.
- **Answer depending on the request** (body, headers, query), fill in **placeholders** from the request, and
  simulate **failures**: sequences like "fail twice, then succeed", random errors, delays and broken connections.
- Changes to the mock folder apply without a restart.

The idea comes from the [mockserver](https://www.npmjs.com/package/mockserver) npm package, and mock folders work
mostly the same way.

Requires **Node.js 22 or newer**. The server has no runtime dependencies; reading YAML specs needs `npm install`.

## Quick start

Generate mocks from your API's spec and start the server, straight from npm:

```console
user@local:~$ npx -p @ad0bert/mockserver generate-mock-structure ./openapi.yaml   # writes ./mocks
user@local:~$ npx @ad0bert/mockserver                                             # serves ./mocks on port 8181
```

To keep it in a project, install it as a dev dependency; `npx mockserver` and `npx generate-mock-structure` then
use that version:

```console
user@local:~$ npm install --save-dev @ad0bert/mockserver
user@local:~$ npx mockserver -m ./mocks
```

Or with Docker, no Node needed:

```console
user@local:~$ docker build -t mockserver .
user@local:~$ docker run --rm -p 8181:8181 mockserver
```

The [Swagger Petstore demo](demo/README.md) shows every feature. Run it from a clone of this repository:

```console
user@local:~$ npm install
user@local:~$ npm run demo
user@local:~$ curl localhost:8181/api/v3/pet/42
```

## Writing mocks

### Files and folders

The request path is the folder, the HTTP method is the file name:

| Request              | File                           |
| -------------------- | ------------------------------ |
| `GET /users`         | `mocks/users/GET.json`         |
| `POST /users`        | `mocks/users/POST.json`        |
| `GET /users/42`      | `mocks/users/42/GET.json`      |
| `GET /users/7` (any) | `mocks/users/__/GET.json`      |
| `GET /search?q=abc`  | `mocks/search/GET--q=abc.json` |

- **Wildcards:** a folder named `__` matches any path segment. Literal folders are tried first, so `users/42/` can
  answer one id differently while `users/__/` answers all others. If a literal folder doesn't lead to a file, the
  wildcard is tried too.
- **Query strings** map to `METHOD--QUERY.ext`. The query has to match exactly; if there's no such file,
  `METHOD.ext` answers. To answer depending on single query parameters, use [rules](#rules-answers-depending-on-the-request).
- **Other response types:** the body file can have any extension: `GET.xml`, `GET.html`, `GET.csv`, `GET.png`, ...
  The `Content-Type` comes from the extension (unknown ones are sent as `application/octet-stream`), and binary files
  are sent unchanged. If one folder has several (`GET.json` and `GET.xml`), the request's `Accept` header picks one;
  otherwise `.json` is used.
- **`HEAD`** requests use the `GET` mock without the body, unless `HEAD` files exist.
- **Special characters:** path segments are URL decoded (`/with%20space` → folder `with space`). Characters Windows
  doesn't allow in file names are percent encoded, so `/slots?at=10:30` is `slots/GET--at=10%3A30.json`. Requests
  that try to leave the mock folder (`..`) get a 404.

### Status and headers

A `METHOD.header` file next to the body sets the status line and headers:

```
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
Location: /users/42
Access-Control-Allow-Origin: *
```

Without one, `DEFAULT.header` from the mock folder's root is used. Without that, this built-in default:

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Cache-Control, Pragma, Expires, Authorization, X-Request-ID
Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE, PUT, PATCH
```

- A `.header` file without a body file is a complete mock, for example for `204 No Content` or a `302` redirect.
- A header listed several times (for example `Set-Cookie`) is sent several times.
- `User-Defined-Delay: 1000` delays the answer by that many ms. It isn't sent to the client.
- **Content-Type:** a `Content-Type` in the resource's own `.header` file always wins. Otherwise it comes from the body
  file's extension, except that `.json` keeps the type from `DEFAULT.header`, so custom types like
  `application/hal+json` work.
- **CORS preflight:** `OPTIONS` requests are answered with an `OPTIONS.header` next to the resource, or in the root,
  or this default:

  ```
  HTTP/1.1 202 Accepted
  Content-Length: 0
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Cache-Control, Pragma, Expires, Authorization, X-Request-ID
  Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE, PUT
  ```

### Rules: answers depending on the request

A `METHOD.rules.json` file next to the mock files holds a JSON array of rules. The **first** rule whose `match` fits
the request answers. If none fits, the mock files answer as usual. Rules also work in `__` folders.

```json
[
  {
    "match": { "body": { "username": "admin", "password": "secret" } },
    "body": { "token": "admin-token" },
    "headers": { "X-Role": "admin" }
  },
  {
    "match": { "body": { "username": { "$exists": true } } },
    "status": 401,
    "body": { "error": "wrong password" }
  },
  {
    "match": { "headers": { "Authorization": { "$regex": "^Bearer ", "$flags": "i" } }, "query": { "page": "2" } },
    "file": "page2.json",
    "delay": 500
  }
]
```

**`match`** (every part is optional; a rule without `match` fits every request):

- `body`: the JSON body, or a form body (`application/x-www-form-urlencoded`). A plain string or a `$regex` is
  compared with the raw body text instead.
- `headers`: header names are case insensitive.
- `query`: query parameters (the first value counts if one is repeated).

Objects match partially: only the keys you list are compared, at any depth. An array matches when each listed
element matches some element of the request's array. Everything else is compared exactly. Header and query values
are always strings, so `"page": 2` and `"page": "2"` mean the same there. Operators: `{ "$regex": "...", "$flags": "i" }`
and `{ "$exists": true | false }`.

**The answer:**

- `status`: default `200`.
- `headers`: added to the `DEFAULT.header` headers, replacing ones with the same name. Use an array for repeated headers.
- `body`: objects and arrays are sent as JSON, a string as is. Or `file`: a body file relative to the rules file (it
  has to stay inside the mock folder); its extension sets the `Content-Type`.
- `delay`: in ms.

**Sequences and failures:**

- `times`: the rule answers at most this many matching requests, then the next rule or the mock files take over.
  `[{ "times": 2, "status": 503 }]` next to a `GET.json` fails twice, then succeeds, which is good for testing
  retry logic. Counts are kept in memory and start over when the rules file changes or the server restarts.
- `probability`: the rule applies to only this share of matching requests (`0.1` = about every 10th), for random errors.
- `fault`: instead of an answer, `"reset"` resets the connection (`ECONNRESET`), `"close"` closes it without an
  answer, and `"timeout"` never answers.

A rule skipped because of `times` or `probability` works like a rule that doesn't match. An invalid rules file
answers with a `500` that names the problem.

### Placeholders

Body files with `.tpl.` before the extension are templates: `GET.tpl.json`, `POST.tpl.html`, ... Their placeholders
are filled for each request. The type still comes from the last extension, so `GET.tpl.json` is sent as JSON.
Files without `.tpl.` are sent unchanged. In rules, the inline `body` and the `headers` values always support placeholders.

```
{ "id": "{{path.1}}", "page": {{query.page | 1}}, "createdBy": "{{headers.x-user | anonymous}}", "at": "{{now}}" }
```

| Placeholder                       | Value                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `{{path}}`, `{{path.N}}`          | the request path, or its segment N (starting at 0: `/users/42` → `{{path.1}}` is `42`) |
| `{{query.name}}`                  | a query parameter                                                                      |
| `{{headers.name}}`                | a request header (any case)                                                            |
| `{{body}}`, `{{body.a.b}}`        | the JSON or form body, or a value in it (`{{body.items.0}}` for array elements)        |
| `{{method}}`, `{{url}}`           | the request method and full url                                                        |
| `{{now}}`, `{{timestamp}}`        | the current time as ISO date, or as ms since 1970                                      |
| `{{uuid}}`, `{{randomInt 1 100}}` | a random UUID, or a random whole number between the two values                         |
| `{{query.page \| 1}}`             | a default, used when the value is missing or empty                                     |

Values are escaped for the file type, so they can't break the file. In `.json` they're escaped as JSON string content,
so `"name": "{{body.name}}"` stays valid whatever the name is. Without quotes, numbers stay numbers and objects are
written as JSON. In `.html`, `.xml` and `.svg` they're HTML escaped. Header values have line breaks removed.

### How a request is answered

1. A matching rule in `METHOD.rules.json`.
2. Otherwise the mock files: `METHOD.header` and/or the body file.
3. Otherwise, with a proxy target (`-t`), the real backend.
4. Otherwise `404`.

Each step looks in the literal folders first, then in `__` folders. Every request is logged on one line with what
answered it, for example `GET /users/42 200 1.3ms <- users/__/GET.json`.

## Generating mocks from a spec

```console
user@local:~$ npm install
user@local:~$ node generate-mock-structure.js [--overwrite] <spec> [outDir]
```

`<spec>` is a Swagger 2.0 or OpenAPI 3 file or URL, in JSON or YAML. `outDir` defaults to `./mocks`.

- Every operation becomes a mock file; path parameters (`{id}`) become `__` folders.
- The `200` response is used, otherwise the first `2xx`, otherwise `default`. For another status, a matching
  `.header` file is written too (for example `HTTP/1.1 201 Created`). `204` and `304` get only the header file.
- Bodies come from the spec's `example`, `default` and `enum` values, or are built from the schema.
- Operations that take a request body also get `METHOD.request.json` with an example request. It's only there for
  reference, for example as a starting point for a rules file; the server never sends it.
- Existing files are kept, so your edits survive regenerating. `--overwrite` replaces them, for example after the spec changed.

## Proxy and record

```console
user@local:~$ node mockserver.js -t https://api.example.com -r true
```

With `-t`, requests that have no mock are forwarded to that backend, and its answer is returned. The request path and
query are appended to the target, so `-t https://api.example.com/v1` turns `/users` into
`https://api.example.com/v1/users`. Method, headers, body and cookies are forwarded. Redirects go back to the client
instead of being followed. `DEFAULT.header` headers the backend didn't send, such as CORS headers, are added.
If the backend can't be reached, the answer is `502`.

With `-r true`, the forwarded answers are also **recorded** as mocks: `METHOD[--query].header` with the status and the
backend's headers, plus a body file whose extension comes from the `Content-Type` (JSON is pretty printed, compressed
bodies are stored decoded). The next identical request is answered from the recording without the backend. Existing
files are never overwritten, and `5xx` answers aren't recorded. The mock folder is created if it doesn't exist.

Recordings use the real path (`/orders/5` → `orders/5/GET.json`). To reuse one for every id, rename the folder to `__`.

## Options

```console
user@local:~$ node mockserver.js [-p port] [-H host] [-m mockdir] [-v verbose] [-l livecheck] [-w watch] [-t target] [-r record]
```

| Option | Default     | Meaning                                                                                                                                                                                                              |
| ------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p`   | `8181`      | port                                                                                                                                                                                                                 |
| `-H`   | `127.0.0.1` | interface to listen on; `0.0.0.0` makes the server reachable from other machines and containers                                                                                                                      |
| `-m`   | `./mocks`   | mock folder, relative to the current directory                                                                                                                                                                       |
| `-v`   | `2`         | log level 0-5. Errors always show. 1: startup messages, 2: one line per request, 3: recorded files, 4: warnings, 5: debug details                                                                                    |
| `-l`   | `true`      | `true` checks the filesystem on every request. `false` keeps an index of the mock folder, which is faster for large folders                                                                                          |
| `-w`   | `true`      | watch the mock folder, so changes (including `DEFAULT.header` and `OPTIONS.header`) apply without a restart. An invalid edited root header file is ignored and the previous version kept. `false` turns watching off |
| `-t`   | none        | proxy target, an http(s) URL (see [Proxy and record](#proxy-and-record))                                                                                                                                             |
| `-r`   | `false`     | `true` records proxied answers as mocks (needs `-t`)                                                                                                                                                                 |

## Docker

The image serves `/mocks` on port 8181, with the Petstore demo built in as the default:

```console
user@local:~$ docker build -t mockserver .
user@local:~$ docker run --rm -p 8181:8181 mockserver                                  # the demo
user@local:~$ docker run --rm -p 8181:8181 -v "$PWD/mocks:/mocks" mockserver           # your mocks
user@local:~$ docker run --rm -p 8181:8181 -v "$PWD/mocks:/mocks" mockserver -t https://api.example.com -r true
user@local:~$ docker run --rm -v "$PWD:/work" --user "$(id -u):$(id -g)" --entrypoint node mockserver \
                /app/generate-mock-structure.js /work/openapi.yaml /work/mocks          # the generator
```

Arguments after the image name go to the server; later options win, so `-m` and `-H` can be changed too. The server
runs as the `node` user (uid 1000). To write into a mounted folder (recording, the generator), that user needs write
access to it, or run as yourself with `--user "$(id -u):$(id -g)"` as in the generator example.

## Development

```console
user@local:~$ npm install
user@local:~$ npm test          # tests
user@local:~$ npm run lint      # ESLint + Prettier check (npm run format fixes formatting)
user@local:~$ npm run typecheck # JSDoc type check with TypeScript
user@local:~$ npm run check     # all of the above
```

Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE). The Petstore spec in [`demo/petstore`](demo/petstore) is from
[swagger-api/swagger-petstore](https://github.com/swagger-api/swagger-petstore) and is licensed under the
[Apache License 2.0](demo/petstore/LICENSE).
