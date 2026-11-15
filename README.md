# mockserver

This package provides a local webserver delivering mock responses for http requests.
The basic idea of the node package [Mockserver](https://www.npmjs.com/package/mockserver) was used.
Defining mocks works mostly the way described for the mockserver package.

Requires **Node.js 22 or newer**. There are no runtime dependencies.

## Howto

 - Create a file `$REQUEST-PATH/$HTTP_METHOD.json` under the mock root.
 - It is also possible to auto generate a full mock folder from a Swagger 2.0 or OpenAPI 3.x (JSON) spec:
    ```console
    user@local:~$ node generate-mock-structure.js ./swagger.json [outDir]
    or
    user@local:~$ node generate-mock-structure.js https://swagger.server.com/swagger.json [outDir]
    ```
   `outDir` defaults to `./mocks` in the current directory. Existing files are never overwritten.
   Path parameters (`{id}`) become wildcard folders (`__`). For each operation the `200` response is used
   (otherwise the first `2xx`, otherwise `default`). If that status is not `200`, a matching `.header` file is
   written as well (for example `HTTP/1.1 201 Created`). Spec `example`, `default` and `enum` values are used where present.
 - The file contains the desired response, for example:
~~~~
{
   "data": {
        "anonymous": false,
        "name": "string",
        "permissions": {},
        "roles": [
            "string"
        ]
    }
}
~~~~

### Other response types

The body file can have any extension, not just `.json`: `GET.xml`, `GET.html`, `GET.csv`, `GET.png`, `GET.pdf`, ...
The `Content-Type` comes from the extension (unknown extensions are sent as `application/octet-stream`),
and binary files are sent unchanged. A `Content-Type` in the resource's own `.header` file always wins.
For `.json` the type from `DEFAULT.header` is kept, so custom types such as `application/hal+json` still work.

If a folder has several body files for the same method (for example `GET.json` and `GET.xml`), the request's
`Accept` header picks one (`Accept: application/xml` returns `GET.xml`). Without a match `.json` is used.

`HEAD` requests use the `GET` mock (headers only) unless `HEAD` files exist.

### Matching on body, headers and query (rules)

Add a `$HTTP_METHOD.rules.json` file next to the mock files to answer differently depending on the request.
It holds a JSON array. The **first** rule whose `match` fits is used. If no rule matches, the normal mock
files (`POST.json`, `POST.header`, ...) answer as usual. Rules files also work in `__` wildcard folders.

~~~~
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
    "match": {
      "headers": { "Authorization": { "$regex": "^Bearer ", "$flags": "i" } },
      "query": { "page": "2" }
    },
    "file": "page2.json",
    "delay": 500
  }
]
~~~~

`match` (every part is optional, a rule without `match` always matches):
 - `body`: compared with the JSON body (or a form-encoded body, `application/x-www-form-urlencoded`).
   A plain string or a `$regex` is compared with the raw body text instead.
 - `headers`: header names are case insensitive.
 - `query`: query parameters (the first value counts if a parameter is repeated).

Objects match partially: only the keys you list are compared, at any depth. An array matches when every listed
element matches some element of the request's array. Everything else is compared exactly. Header and query values
are always strings, so `"page": 2` and `"page": "2"` mean the same there.
Operators: `{ "$regex": "...", "$flags": "i" }` and `{ "$exists": true | false }`.

Response fields:
 - `status`: default `200`.
 - `headers`: added to the `DEFAULT.header` headers, replacing ones with the same name. Use an array for repeated headers.
 - `body`: inline body. Objects and arrays are sent as JSON; a string is sent as is.
 - `file`: or a body file, relative to the rules file (it has to stay inside the mock folder). Its extension sets the `Content-Type`.
 - `delay`: in ms.

An invalid rules file answers with a `500` that names the problem.

### Proxy and record

```console
user@local:~$ node mockserver.js -m ./mocks -t https://api.example.com -r true
```

With `-t`, every request that has no mock (no rule match, no `.header` and no body file) is forwarded to that backend,
and its answer is returned. The request path and query are appended to the target, so `-t https://api.example.com/v1`
turns `/users` into `https://api.example.com/v1/users`. Method, headers, body and cookies are forwarded. Redirects are
passed back to the client instead of being followed. Headers from `DEFAULT.header` the backend didn't send, such as
CORS headers, are added. If the backend can't be reached the answer is `502`.

With `-r true` the forwarded answers are also **recorded** as mocks: `METHOD[--query].header` with the status and the
backend's headers, plus `METHOD[--query].<ext>` with the body (the extension comes from the `Content-Type`; JSON is
pretty printed, compressed bodies are stored decoded). The next identical request is answered from the recording
without the backend. Existing files are never overwritten, and `5xx` answers are not recorded.

Recordings use the real path (`/orders/5` → `orders/5/GET.json`). To reuse a recording for every id, rename the
folder to `__`.

### Headers

You can also add an http `$HTTP_METHOD.header` file in the same folder as the resource, for example:
~~~~
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Cache-Control, Pragma, Expires, Authorization, X-Request-ID
Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE, PUT, PATCH
~~~~
If no header file is provided, the example above is used as the default. You can override the default by providing
a `DEFAULT.header` file in the mock root directory.

A `.header` file without a `.json` file is a valid mock, for example for `204 No Content` or redirects (`302` + `Location`).
A header that is listed several times (for example `Set-Cookie`) is sent several times.

#### User defined headers
In addition to the standard HTTP headers, the following user defined headers can be used:
 - `User-Defined-Delay: 1000` delays the response by the given number of ms to simulate server load. The header itself is not sent.

### Wildcards and query parameters

 - A folder named `__` matches any path segment: `/users/42/GET.json` falls back to `/users/__/GET.json`.
   Literal folders are tried first, and if they don't lead to a file the wildcard is tried (with backtracking).
 - A query string maps to `$HTTP_METHOD--$QUERY.json`, for example `/search?q=abc` → `search/GET--q=abc.json`.
   If that file doesn't exist, `search/GET.json` is used.
 - Path segments are URL decoded (`/with%20space` → folder `with space`). Requests that try to leave the mock root (`..`) get a 404.

## Special Request Types

For an `OPTIONS` request (CORS preflight), an `OPTIONS.header` file next to the resource, or in the mock root directory, is used.
If neither is provided, this default is used:
~~~~
HTTP/1.1 202 Accepted
Content-Length: 0
X-Powered-By: Undertow/1
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Cache-Control, Pragma, Expires, Authorization, X-Request-ID
Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE, PUT
~~~~

## Usage

```console
user@local:~$ node mockserver.js -p port -H host -m mockdir -v verbose -l livecheck -w watch -t target -r record
```
 - `-p` port: the port used (default 8181)
 - `-H` host: the interface to bind to (default `127.0.0.1`; use `0.0.0.0` inside Docker)
 - `-m` mockdir: root path of the mock files. Relative paths are resolved against the current directory.
   Default: `../mocks` relative to `mockserver.js`.
 - `-v` verbose: log level 0-5 (default 2). Errors are always logged; each level adds log, info, success, warn, debug.
 - `-l` livecheck: `true` (default) checks the filesystem on every request. `false` indexes the mock folder once at startup,
   which is faster for large mock folders. Changes are picked up automatically while `-w` is on.
 - `-t` target: proxy requests without a mock to this http(s) URL (see *Proxy and record*).
 - `-r` record: `true` writes proxied answers as mock files (default `false`, needs `-t`).
 - `-w` watch: `true` (default) watches the mock folder, so added, changed or removed mocks and edits to
   `DEFAULT.header` / `OPTIONS.header` apply without a restart. If an edited root header file is invalid,
   the previous version is kept and an error is logged. `false` disables watching.

Call `http://localhost:port/$REQUEST-PATH/` and the matching `$HTTP_METHOD` file is served.

## Development

```console
user@local:~$ npm test
```
