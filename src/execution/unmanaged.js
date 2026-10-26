// Unmanaged broker positions (decision 5). A broker position with no AIS record is a critical discrepancy.
// AIS never closes or adopts it on its own. New entries on the account stay blocked until the owner resolves it:
//   ADOPT   - AIS records it as its own trade (the existing protection is kept; nothing is changed at the broker)
//   CLOSE   - the owner closes it at the broker through AIS (audited)
//   IGNORE  - the owner accepts it with a recorded reason; it stays visible read-only and stops blocking new entries
// Every resolution is an owner action, audited, and only accepted for a position that is currently unmanaged.
const storage = require('../data/storage');
const audit = require('../audit/audit');

const COLLECTION = 'unmanaged_resolutions';
const ACTIONS = ['ADOPT', 'CLOSE', 'IGNORE'];
const MIN_REASON = 10;

// Pure. Protection status of a broker position from its stop-loss and take-profit.
function protectionStatus(p) {
  const sl = Number(p.stopLoss), tp = Number(p.takeProfit);
  if (Number.isFinite(sl) && sl > 0 && Number.isFinite(tp) && tp > 0) return 'PROTECTED';
  if (Number.isFinite(sl) && sl > 0) return 'PARTIAL: stop-loss only';
  return 'UNPROTECTED';
}

// Pure. Read-only view of a broker position, for the dashboard and the alert.
function describe(p, symbolFor = id => String(id)) {
  return {
    positionId: Number(p.positionId),
    symbol: symbolFor(p.tradeData && p.tradeData.symbolId),
    side: p.tradeData && p.tradeData.tradeSide,
    volume: Number(p.tradeData && p.tradeData.volume),
    entryPrice: Number(p.price),
    stopLoss: Number.isFinite(Number(p.stopLoss)) ? Number(p.stopLoss) : null,
    takeProfit: Number.isFinite(Number(p.takeProfit)) ? Number(p.takeProfit) : null,
    protection: protectionStatus(p),
    openedAt: p.tradeData && p.tradeData.openTimestamp ? new Date(Number(p.tradeData.openTimestamp)).toISOString() : null
  };
}

async function resolutions() {
  return storage.load(COLLECTION);
}

// Positions the owner has ignored (they stop blocking new entries but stay visible).
async function ignoredIds() {
  return new Set((await resolutions()).filter(r => r.action === 'IGNORE').map(r => String(r.positionId)));
}

// Resolves one currently unmanaged position. `current` is the broker's current unmanaged list (raw positions).
// `deps` lets the close path call the broker; in production it is trading.closeMarket and orderManager.recordAdopted.
async function resolve({ positionId, action, reason, actor = 'owner', current, deps }) {
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`);
  const pos = (current || []).find(p => String(p.positionId) === String(positionId));
  if (!pos) throw new Error('that position is not currently unmanaged; nothing to resolve');
  if (typeof reason !== 'string' || reason.trim().length < MIN_REASON) {
    throw new Error(`a reason of at least ${MIN_REASON} characters is required`);
  }
  const record = { positionId: Number(pos.positionId), action, reason: reason.trim(), actor, at: new Date().toISOString(), protection: protectionStatus(pos) };
  let outcome = {};
  if (action === 'ADOPT') {
    const intent = { id: `OWNER-${pos.positionId}`, symbol: deps.symbolFor(pos.tradeData.symbolId), action: pos.tradeData.tradeSide, stopLoss: Number(pos.stopLoss), takeProfit: Number(pos.takeProfit) };
    outcome.trade = await deps.recordAdopted(intent, pos);
  } else if (action === 'CLOSE') {
    outcome.close = await deps.closeMarket({ positionId: pos.positionId, volume: pos.tradeData.volume });
  }
  await storage.append(COLLECTION, { ...record, ...outcome.close ? { exitPrice: outcome.close.exitPrice, pnl: outcome.close.pnl } : {} });
  audit.record('OWNER_UNMANAGED_RESOLVED', { positionId: record.positionId, action, actor, reason: record.reason, protection: record.protection });
  return { ...record, ...outcome };
}

module.exports = { protectionStatus, describe, resolve, ignoredIds, resolutions, ACTIONS, MIN_REASON, COLLECTION };
