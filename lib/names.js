'use strict';

/**
 * makes a path segment or query usable as a file name on every OS: characters Windows does not
 * allow (< > : " | ? * and control characters) and a trailing dot or space are percent encoded,
 * i.e. '10:30' -> '10%3A30'. Lookups also try the unencoded name, so older mocks keep working on Linux / macOS.
 */
function safeFileName(name) {
  return (
    name
      // eslint-disable-next-line no-control-regex -- control characters are not allowed in Windows file names
      .replace(/[<>:"|?*\x00-\x1f]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
      .replace(/[. ]$/, c => (c === '.' ? '%2E' : '%20'))
  );
}

module.exports = { safeFileName };
