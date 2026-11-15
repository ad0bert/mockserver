'use strict';
/**
 * Request matching rules (METHOD.rules.json).
 *
 * A rules file is a JSON array. The first rule whose "match" fits the request is answered,
 * if no rule matches the normal mock files (METHOD.json, ...) are used.
 *
 * [
 *   {
 *     "match": {
 *       "body":    { "username": "admin" },            // partial match on the JSON / form body
 *       "headers": { "authorization": { "$regex": "^Bearer " } },
 *       "query":   { "page": "2" }
 *     },
 *     "status": 200,                                   // default 200
 *     "headers": { "X-Role": "admin" },                // added to / overriding DEFAULT.header
 *     "body": { "token": "abc" },                      // inline body, or:
 *     "file": "admin.json",                            // body file, relative to the rules file
 *     "delay": 500                                     // ms
 *   }
 * ]
 *
 * Matching: objects match partially (only the given keys are compared, nested too), arrays match
 * when every expected element matches some actual element, other values compare strictly.
 * Header and query values are strings, so numbers in the rule are compared as strings there.
 * Operators: { "$regex": "...", "$flags": "i" }, { "$exists": true|false }.
 */

const MAX_RULES_BODY = 10 * 1024 * 1024;

function isOperator(expected) {
  return (
    expected !== null &&
    typeof expected === 'object' &&
    !Array.isArray(expected) &&
    ('$regex' in expected || '$exists' in expected)
  );
}

function matchValue(expected, actual) {
  if (isOperator(expected)) {
    if ('$exists' in expected && Boolean(expected.$exists) !== (actual !== undefined)) return false;
    if ('$regex' in expected) {
      if (actual === undefined || actual === null || typeof actual === 'object') return false;
      return new RegExp(expected.$regex, expected.$flags || '').test(String(actual));
    }
    return true;
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every(e => actual.some(a => matchValue(e, a)));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) => matchValue(value, actual[key]));
  }
  return expected === actual;
}

// header / query values are always strings (or string arrays), compare rule values as strings
function stringify(expected) {
  if (isOperator(expected)) return expected;
  if (Array.isArray(expected)) return expected.map(stringify);
  if (expected !== null && typeof expected === 'object') {
    return Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, stringify(v)]));
  }
  return expected === null ? expected : String(expected);
}

/**
 * @param rule one entry of a rules file
 * @param request {{headers: object, query: object, body: any, rawBody: string}}
 */
function ruleMatches(rule, request) {
  const match = rule.match || {};
  if (match.headers) {
    const expected = Object.fromEntries(
      Object.entries(match.headers).map(([k, v]) => [k.toLowerCase(), stringify(v)])
    );
    if (!matchValue(expected, request.headers)) return false;
  }
  if (match.query && !matchValue(stringify(match.query), request.query)) return false;
  if (match.body !== undefined) {
    // a plain string or a $regex is compared with the raw body text
    const raw = typeof match.body === 'string' || (isOperator(match.body) && '$regex' in match.body);
    if (!matchValue(match.body, raw ? request.rawBody : request.body)) return false;
  }
  return true;
}

/**
 * parses and validates the content of a rules file
 * @return array of rules, throws with a readable message on invalid content
 */
function parseRules(content, file) {
  let rules;
  try {
    rules = JSON.parse(content);
  } catch (e) {
    throw new Error(`Invalid JSON in rules file ${file}: ${e.message}`);
  }
  if (!Array.isArray(rules)) {
    throw new Error(`Rules file ${file} must contain a JSON array`);
  }
  rules.forEach((rule, i) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`Rule #${i} in ${file} must be an object`);
    }
    if (rule.status !== undefined && !(Number.isInteger(rule.status) && rule.status >= 100 && rule.status <= 999)) {
      throw new Error(`Rule #${i} in ${file} has an invalid status '${rule.status}'`);
    }
    if (rule.file !== undefined && typeof rule.file !== 'string') {
      throw new Error(`Rule #${i} in ${file}: "file" must be a string`);
    }
  });
  return rules;
}

/**
 * reads the request body (up to limit bytes)
 * @return Buffer, rejects with an error that has statusCode 413 when the body is too large
 */
function readRequestBody(req, limit = MAX_RULES_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error(`Request body larger than ${limit} bytes`);
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * prepares the request data the rules are matched against
 */
function requestInfo(req, rawBody) {
  const qIdx = req.url.indexOf('?');
  const query = {};
  if (qIdx >= 0) {
    for (const [key, value] of new URLSearchParams(req.url.slice(qIdx + 1))) {
      if (!(key in query)) query[key] = value; // first value wins
    }
  }
  const text = rawBody.toString('utf8');
  const type = String(req.headers['content-type'] || '').toLowerCase();
  let body = text;
  if (type.includes('application/x-www-form-urlencoded')) {
    body = Object.fromEntries(new URLSearchParams(text));
  } else if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON, keep the raw text
    }
  }
  return { headers: req.headers, query, body, rawBody: text };
}

module.exports = { matchValue, ruleMatches, parseRules, readRequestBody, requestInfo };
