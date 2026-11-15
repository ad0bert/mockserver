# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-15

First release. Compared with the original scripts:

### Added

- **Rules** (`METHOD.rules.json`): answer depending on the request body, headers and query, with partial matching and
  `$regex` / `$exists`. Rules can set the status, headers, an inline body or a file, and a delay.
- **Sequences and failures** in rules: `times` (e.g. fail twice, then succeed), `probability` (random errors) and
  `fault` (`reset`, `close`, `timeout`).
- **Placeholders** in `.tpl.` body files and in rules: path, query, headers, body, `now`, `uuid`, `randomInt` and
  defaults, escaped for the file type.
- **Proxy and record** (`-t`, `-r`): forward requests without a mock to a real backend and save its answers as mocks.
- **Any response type**: `.xml`, `.html`, `.png`, ... with the `Content-Type` from the extension, chosen by the `Accept`
  header when there are several.
- **Watching** (`-w`): changes in the mock folder, `DEFAULT.header` and `OPTIONS.header` apply without a restart.
- Header-only mocks (e.g. `204`, redirects), repeated headers (`Set-Cookie`), per-resource `OPTIONS.header`, `HEAD`
  answered from the `GET` mock.
- One log line per request with status, duration and what answered it.
- `-H` option for the interface to listen on.
- **Generator**: OpenAPI 3 and YAML specs, `example` / `enum` / `allOf` values, `.header` files for statuses other than
  `200`, example requests (`METHOD.request.json`), `--overwrite`, and an optional output folder.
- MIT license.
- Swagger Petstore demo (`npm run demo`), Dockerfile, tests, ESLint, Prettier, type checking and CI on Linux, Windows and macOS.

### Changed

- The default mock folder is `./mocks` in the current directory (before: `../mocks` next to the script), and `-m`
  paths are relative to the current directory. The generator writes to `./mocks` too.
- Wildcard folders (`__`) are tried after literal folders, with backtracking, and several wildcards per path work.
- Path segments are URL decoded. Characters Windows doesn't allow in file names are percent encoded
  (`/slots?at=10:30` → `slots/GET--at=10%3A30.json`); unencoded names still work on Linux and macOS.
- The built-in `OPTIONS` answer no longer sends `X-Powered-By: Undertow/1`; `PATCH` is in the default
  `Access-Control-Allow-Methods`.
- `-v` takes 0-5.
- Requires Node.js 22 or newer.

### Fixed

- Header values containing `:` (e.g. `Location: http://...`) were cut off.
- Absolute `-m` paths crashed at startup.
- With `-l false`, a path that is the start of an existing folder name skipped the wildcard fallback.
- Requests with `..` in the path could read files outside the mock folder.
- Generator: several path parameters in one path collapsed into one folder; it crashed on path-level keys such as
  `parameters`; specs without `basePath` wrote into a `mocksundefined` folder; some output wasn't valid JSON;
  self-referencing schemas never finished; folders and files went to different places when run from another directory.

[1.0.0]: https://github.com/ad0bert/mockserver/releases/tag/v1.0.0
