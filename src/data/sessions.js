// Session calendar (decision 3). Tells a scheduled market closure from a missing candle.
// Defaults: FX and gold are closed from Friday 22:00 UTC to Sunday 22:00 UTC; BTC trades around the clock.
// Extra closures (holidays, broker maintenance) are configured as explicit UTC intervals; none are set by default.
const DAY = 86400000;
const MINUTE = 60000;

const WEEKEND_CLOSED = { startDay: 5, startHour: 22, endDay: 0, endHour: 22 }; // Fri 22:00 to Sun 22:00 UTC
const ALWAYS_OPEN = new Set(['BTCUSD']);

// Extra closed intervals per symbol: [{ fromMs, toMs, note }]. Empty by default; set only by the owner.
const extraClosures = {};

function inWeekendClosure(ms) {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (day === 6) return true;                                    // all Saturday
  if (day === WEEKEND_CLOSED.startDay && hour >= WEEKEND_CLOSED.startHour) return true; // Friday evening
  if (day === WEEKEND_CLOSED.endDay && hour < WEEKEND_CLOSED.endHour) return true;      // Sunday before reopen
  return false;
}

// Pure. True when the market for this symbol is scheduled to trade at this instant.
function isOpen(symbol, ms) {
  if (ALWAYS_OPEN.has(symbol)) return !(extraClosures[symbol] || []).some(c => ms >= c.fromMs && ms < c.toMs);
  if ((extraClosures[symbol] || []).some(c => ms >= c.fromMs && ms < c.toMs)) return false;
  return !inWeekendClosure(ms);
}

// Pure. Number of candles that should exist between two completed candles but are missing for a reason
// that is NOT a scheduled closure. `periodMs` is the candle length. Gaps over closures return 0.
function unexplainedMissing(symbol, prevTime, nextTime, periodMs) {
  let count = 0;
  const limit = Math.min(nextTime, prevTime + 10 * DAY);  // a gap longer than 10 days is treated as a fault, not a calendar
  for (let t = prevTime + periodMs; t < nextTime; t += periodMs) {
    if (t >= limit) { count += Math.round((nextTime - t) / periodMs); break; }
    if (isOpen(symbol, t)) count++;
  }
  return count;
}

function setExtraClosures(symbol, list) {
  extraClosures[symbol] = (list || []).map(c => {
    if (!Number.isFinite(c.fromMs) || !Number.isFinite(c.toMs) || c.toMs <= c.fromMs) throw new Error('closure needs fromMs < toMs');
    return { fromMs: c.fromMs, toMs: c.toMs, note: String(c.note || '') };
  });
  return extraClosures[symbol];
}

module.exports = { isOpen, unexplainedMissing, setExtraClosures, inWeekendClosure, MINUTE };
