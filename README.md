# mockserver

This packages provides a local webserver delivering mock responses for http requests.
The basic idea of the node package [Mockserver](https://www.npmjs.com/package/mockserver) was used.
Defining mocks work most like the way as described for the mockserver package.

## Howto

 - Create a file $REQUEST-PATH/$HTTP_METHOD.json under the Mock root.
 - It is also possible to auto generate a full mock folder from a swagger 2.0 spec by using:
    ```console
    user@local:~$node generate-mock-structure.js /test/swagger.json
    or
    user@local:~$node generate-mock-structure.js http(s)://swagger.server.com/swagger.json
    ```
 - The file contains the desired response i.e.:
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

In addition it is also possible to add a http ".header" file on the same folder level for the resource i.e.:
~~~~
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Cache-Control, Pragma, Expires, Authorization, X-Request-ID
Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE, PUT
~~~~
If not provided the example is taken as default. The default can be overwritten by providing a DEFAULT.header file in the mock root directory
 #### User defined headers
 Alongside the default HTTP header types the following user defined headers can be defined
 - User-Defined-Delay: 1000 (the request answer is delayed for the amount given in ms to  simulate server load)
 ## Special Request Types
 
 In case of an OPTIONS request (for CORS) a OPTIONS.json file in the Mock root directory can be used. 
 If not provided this default is used:
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
user@local:~$node mockserver -p port -m mockdir -v verbose -l livecheck
```
 - port: the port used (default 8181)
 - mockdir: root path of the mock files (default '../mocks')
 - verbose: log level 0-4 (default 2)
 - livecheck: check for each request if the called file is available (default 'true')

Call http://localhost:port/$REQUEST-PATH/ with the files $HTTP_METHOD
