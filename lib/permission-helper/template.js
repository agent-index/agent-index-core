// template.js — Render the review page from the template + spec.
//
// The template is a static HTML file at templates/page.html that contains
// placeholders __SPEC__ and __TOKEN__. We substitute those at render time.
// The page itself reads its spec from a <script type="application/json">
// block; render-side substitution does not run agent-supplied content
// through any string interpolation that could create XSS.

'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.resolve(__dirname, 'templates', 'page.html');

let _cached = null;
function _readTemplate() {
  if (_cached !== null) return _cached;
  _cached = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return _cached;
}

/**
 * Render the page. Returns HTML string.
 * @param {object} spec   The validated permission-change spec.
 * @param {string} token  The one-time session token.
 */
function render(spec, token) {
  const template = _readTemplate();
  // JSON.stringify produces a safe-for-HTML string when used inside
  // <script type="application/json"> because </script> can only appear
  // in a string literal if the slash is escaped. Be defensive anyway:
  // replace </ with <\/ in the JSON output.
  const specJson = JSON.stringify(spec).replace(/<\//g, '<\\/');
  // Token is a UUID, so no escaping needed, but be defensive.
  const safeToken = String(token).replace(/[^a-zA-Z0-9-]/g, '');
  return template
    .replace('__SPEC__', specJson)
    .replace('__TOKEN__', safeToken);
}

module.exports = { render };
