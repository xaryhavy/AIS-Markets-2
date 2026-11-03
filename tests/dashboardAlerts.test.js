const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// The dashboard used to fetch /api/alerts and keep only the length: the owner saw "alerts open: 1" and had
// no way to find out which alert it was or why it had opened. Every open alert now shows its own message.
function refreshFn() {
  return html.slice(html.indexOf('async function refreshGuardrails'), html.indexOf('async function acknowledgeFence'));
}

test('the safety panel has a place to list open alerts', () => {
  assert.match(html, /id="alertsList"/);
});

test('each open alert is rendered with its code, severity and message', () => {
  const fn = refreshFn();
  assert.match(fn, /alertsList/);
  assert.match(fn, /a\.message/);
  assert.match(fn, /a\.code/);
  assert.match(fn, /a\.severity/);
});

test('the alert count is still shown, so the summary keeps working', () => {
  assert.match(refreshFn(), /alerts open: \$\{al\.length\}/);
});

test('alert text from the backend is escaped before it reaches the DOM', () => {
  const fn = refreshFn();
  const alertBlock = fn.slice(fn.indexOf('alertsList'), fn.indexOf("const props="));
  assert.match(alertBlock, /escAttr\(a\.message/);
  assert.match(alertBlock, /escAttr\(a\.code/);
  // No raw interpolation of a message into markup without escaping.
  assert.equal(/\$\{a\.message\}/.test(alertBlock), false);
});
