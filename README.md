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
user@local:~$ node mockserver.js -p port -H host -m mockdir -v verbose -l livecheck
```
 - `-p` port: the port used (default 8181)
 - `-H` host: the interface to bind to (default `127.0.0.1`; use `0.0.0.0` inside Docker)
 - `-m` mockdir: root path of the mock files. Relative paths are resolved against the current directory.
   Default: `../mocks` relative to `mockserver.js`.
 - `-v` verbose: log level 0-5 (default 2). Errors are always logged; each level adds log, info, success, warn, debug.
 - `-l` livecheck: `true` (default) checks the filesystem on every request. `false` indexes the mock folder once at startup,
   so files added later are not picked up until a restart.

Call `http://localhost:port/$REQUEST-PATH/` and the matching `$HTTP_METHOD` file is served.

## Development

```console
user@local:~$ npm test
```
