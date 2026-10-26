const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('the dashboard has a read-only unmanaged-positions panel fed by the API', () => {
  assert.match(html, /Unmanaged Broker Positions \(read-only\)/);
  assert.match(html, /id="unmanagedPanel"/);
  assert.match(html, /fetch\('\/api\/positions\/unmanaged'\)/);
});

test('the panel never offers a resolve action and only issues a read', () => {
  const fn = html.slice(html.indexOf('async function refreshUnmanaged'), html.indexOf('function openCtrader'));
  assert.ok(fn.length > 100);
  assert.equal(/method\s*:\s*'POST'|resolve|<button/i.test(fn), false);
});

test('broker text is written with textContent, never as markup', () => {
  const fn = html.slice(html.indexOf('async function refreshUnmanaged'), html.indexOf('function openCtrader'));
  assert.equal(/innerHTML/.test(fn), false);
  assert.match(fn, /textContent/);
});
