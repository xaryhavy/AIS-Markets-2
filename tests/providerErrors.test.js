const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenApiClient } = require('../src/ctrader/openApiClient');
const providerErrors = require('../src/ctrader/providerErrors');

// A stand-in for the protobuf layer: frames are passed through as objects, so the request path runs unchanged.
function fakeClient() {
  const passthrough = { create: x => x, encode: () => ({ finish: () => Buffer.alloc(0) }), decode: p => p };
  const c = new OpenApiClient('demo', {});
  c.socket = { write() {}, destroy() {} };
  c.root = { lookupType: () => passthrough };
  c.ProtoOAPayload = new Proxy({}, { get: () => 1 });
  c.ProtoPayload = { ERROR_RES: 2 };
  c.ProtoMessage = passthrough;
  return c;
}

test('a broker error response is counted and rejects only its own request', async () => {
  providerErrors.reset();
  const c = fakeClient();
  const p = c._request('trader', {});
  c._onFrame({ clientMsgId: '1', payloadType: 2, payload: { errorCode: 'CH_ACCESS_TOKEN_INVALID', description: 'bad token' } });
  await assert.rejects(p, /cTrader error CH_ACCESS_TOKEN_INVALID: bad token/);
  const s = providerErrors.snapshot();
  assert.equal(s.byKind.error_response, 1);
  assert.equal(s.total, 1);
  assert.equal(s.last.kind, 'error_response');
});

test('a request with no reply is counted as a timeout', async t => {
  providerErrors.reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = fakeClient();
  const p = c._request('trader', {});
  t.mock.timers.tick(15000);
  await assert.rejects(p, /timed out/);
  assert.equal(providerErrors.snapshot().byKind.timeout, 1);
});

test('a dropped session is counted as a connection error', () => {
  providerErrors.reset();
  const c = fakeClient();
  c._fail(new Error('socket reset'));
  assert.equal(providerErrors.snapshot().byKind.connection, 1);
});

test('the counter keeps totals per kind and the latest message, truncated', () => {
  providerErrors.reset();
  providerErrors.record('timeout', 'a');
  providerErrors.record('timeout', 'b');
  providerErrors.record('error_response', 'x'.repeat(500));
  const s = providerErrors.snapshot();
  assert.equal(s.total, 3);
  assert.deepEqual(s.byKind, { timeout: 2, error_response: 1 });
  assert.equal(s.last.message.length, 200);
});
