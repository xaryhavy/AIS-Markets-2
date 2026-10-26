const test = require('node:test');
const assert = require('node:assert/strict');
const feed = require('../src/ctrader/marketFeed');

// A broker bar as the protocol returns it: minute index, low and deltas in 1/100000.
const raw = minute => ({ utcTimestampInMinutes: minute, low: 110000, deltaOpen: 0, deltaHigh: 10, deltaClose: 5 });

test('a broker that repeats the same bars cannot make the fetch run forever', async () => {
  let calls = 0;
  const client = { getTrendbars: async () => { calls++; return [raw(1000), raw(1001)]; } };
  const bars = await feed.fetchBars(client, 1, 1, 1, 1, 3000, { deadlineMs: 60000 });
  assert.equal(bars.length, 2, 'only the distinct bars are kept');
  assert.ok(calls <= 2, `stopped after no progress (calls=${calls})`);
});

test('a broker that runs out of history ends the fetch with what exists', async () => {
  const nowMin = Math.floor(Date.now() / 60000);
  const history = Array.from({ length: 1200 }, (_, i) => nowMin - i);
  const client = {
    getTrendbars: async ({ count, toTimestamp }) => {
      const minuteTo = Math.floor(toTimestamp / 60000);
      return history.filter(m => m <= minuteTo && m > minuteTo - count).map(raw);
    }
  };
  const bars = await feed.fetchBars(client, 1, 1, 1, 1, 3000, { deadlineMs: 60000, now: () => Date.now() });
  assert.equal(bars.length <= 1200, true);
  assert.ok(bars.length > 0);
  for (let i = 1; i < bars.length; i++) assert.ok(bars[i].time > bars[i - 1].time, 'sorted, no duplicates');
});

test('the deadline stops a slow broker with a clear error', async () => {
  let t = 0;
  const client = { getTrendbars: async () => { t += 30000; return [raw(t)]; } };
  await assert.rejects(
    feed.fetchBars(client, 1, 1, 1, 1, 5000, { deadlineMs: 60000, now: () => t }),
    /timed out/
  );
});

test('bars are converted to prices using the protocol scale', async () => {
  const client = { getTrendbars: async () => [{ utcTimestampInMinutes: 5, low: 110000, deltaOpen: 0, deltaHigh: 10000, deltaClose: 5000 }] };
  const [b] = await feed.fetchBars(client, 1, 1, 1, 1, 1);
  assert.equal(b.time, 5 * 60000);
  assert.equal(b.low, 1.1);
  assert.equal(b.high, 1.2);
  assert.equal(b.close, 1.15);
});
