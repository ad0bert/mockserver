'use strict';
/**
 * Placeholders in responses, filled per request.
 *
 * Used in body files named with `.tpl.` before the extension (GET.tpl.json, GET.tpl.html),
 * and in the inline `body` and `headers` of rules.
 *
 *   {{path}}            /users/42          {{path.1}}  42 (segments start at 0)
 *   {{query.page}}      query parameter    {{headers.x-tenant}}  request header (any case)
 *   {{body.user.name}}  JSON or form body  {{body}}    the whole body
 *   {{method}}  {{url}}
 *   {{now}}  ISO date   {{timestamp}}  ms since 1970   {{uuid}}   {{randomInt 1 100}}
 *   {{query.page | 1}}  default when the value is missing or empty
 *
 * Inserted values are escaped for the file type: JSON string escaping in .json, HTML escaping
 * in .html / .xml / .svg. Objects and arrays are inserted as JSON.
 */
const crypto = require('node:crypto');
const path = require('node:path');

const PLACEHOLDER = /\{\{\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g;
const TEMPLATE_MARK = '.tpl.';

/** @return true for body files that are templates (GET.tpl.json) */
function isTemplateFile(file) {
  return path.basename(file).includes(TEMPLATE_MARK);
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const toText = value => (typeof value === 'object' ? JSON.stringify(value) : String(value));

const ESCAPERS = {
  // inside a JSON string: "name": "{{body.name}}" stays valid JSON for any name
  json: value => (typeof value === 'string' ? JSON.stringify(value).slice(1, -1) : JSON.stringify(value)),
  html: value => toText(value).replace(/[&<>"']/g, c => HTML_ESCAPES[c]),
  // header values must not contain line breaks
  header: value => toText(value).replace(/[\r\n]+/g, ' '),
  raw: toText
};

/** @return the escaping to use for a file name ('json', 'html' or 'raw') */
function escapingFor(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === 'json') return 'json';
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) return 'html';
  return 'raw';
}

/**
 * @param request {{method: string, url: string, segments: string[], headers: object, query: object, body: any}}
 */
function evaluate(expression, request) {
  const [name, ...args] = expression.split(/\s+/);
  switch (name) {
    case 'now':
      return new Date().toISOString();
    case 'timestamp':
      return Date.now();
    case 'uuid':
      return crypto.randomUUID();
    case 'randomInt': {
      const min = Number(args[0] ?? 0);
      const max = Number(args[1] ?? 100);
      if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return undefined;
      return min + Math.floor(Math.random() * (max - min + 1));
    }
    case 'method':
      return request.method;
    case 'url':
      return request.url;
    case 'path':
      return '/' + request.segments.join('/');
    case 'body':
      return request.body;
  }
  const [root, ...keys] = name.split('.');
  let value;
  if (root === 'path') value = request.segments;
  else if (root === 'query') value = request.query;
  else if (root === 'headers') value = request.headers;
  else if (root === 'body') value = request.body;
  else return undefined;
  if (root === 'headers') keys[0] = (keys[0] || '').toLowerCase();
  for (const key of keys) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

/**
 * fills the placeholders of a template
 * @param escaping 'json', 'html', 'header' or 'raw'
 */
function render(template, request, escaping = 'raw') {
  const escape = ESCAPERS[escaping] || ESCAPERS.raw;
  return template.replace(PLACEHOLDER, (_all, expression, fallback) => {
    const value = evaluate(expression, request);
    if (value === undefined || value === null || value === '') {
      return fallback !== undefined ? fallback : ''; // the default is written by the mock author, not escaped
    }
    return escape(value);
  });
}

module.exports = { render, isTemplateFile, escapingFor, evaluate };
