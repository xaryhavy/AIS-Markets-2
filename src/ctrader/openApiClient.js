// cTrader Open API client — Protobuf over TLS (TCP port 5035).
// Official message definitions live in ./proto (spotware/openapi-proto-messages).
const tls = require('tls');
const path = require('path');
const protobuf = require('protobufjs');

const PROTO_DIR = path.join(__dirname, 'proto');
const PORT = 5035;
const HOSTS = { demo: 'demo.ctraderapi.com', live: 'live.ctraderapi.com' };
const HEARTBEAT_MS = 10000;
const REQUEST_TIMEOUT_MS = 15000;
const providerErrors = require('./providerErrors');

// Request/response pairs. `enum` is the ProtoOAPayloadType name of the request.
const OPS = {
  appAuth:       { req: 'ProtoOAApplicationAuthReq',            enum: 'PROTO_OA_APPLICATION_AUTH_REQ',            res: 'ProtoOAApplicationAuthRes' },
  accountList:   { req: 'ProtoOAGetAccountListByAccessTokenReq', enum: 'PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ', res: 'ProtoOAGetAccountListByAccessTokenRes' },
  accountAuth:   { req: 'ProtoOAAccountAuthReq',                 enum: 'PROTO_OA_ACCOUNT_AUTH_REQ',                res: 'ProtoOAAccountAuthRes' },
  trader:        { req: 'ProtoOATraderReq',                      enum: 'PROTO_OA_TRADER_REQ',                      res: 'ProtoOATraderRes' },
  symbolsList:   { req: 'ProtoOASymbolsListReq',                 enum: 'PROTO_OA_SYMBOLS_LIST_REQ',                res: 'ProtoOASymbolsListRes' },
  symbolById:    { req: 'ProtoOASymbolByIdReq',                  enum: 'PROTO_OA_SYMBOL_BY_ID_REQ',                res: 'ProtoOASymbolByIdRes' },
  subscribeSpots:{ req: 'ProtoOASubscribeSpotsReq',              enum: 'PROTO_OA_SUBSCRIBE_SPOTS_REQ',             res: 'ProtoOASubscribeSpotsRes' },
  trendbars:     { req: 'ProtoOAGetTrendbarsReq',                enum: 'PROTO_OA_GET_TRENDBARS_REQ',               res: 'ProtoOAGetTrendbarsRes' },
  newOrder:      { req: 'ProtoOANewOrderReq',                    enum: 'PROTO_OA_NEW_ORDER_REQ',                   res: 'ProtoOAExecutionEvent' },
  closePosition: { req: 'ProtoOAClosePositionReq',               enum: 'PROTO_OA_CLOSE_POSITION_REQ',              res: 'ProtoOAExecutionEvent' },
  amendSltp:     { req: 'ProtoOAAmendPositionSLTPReq',           enum: 'PROTO_OA_AMEND_POSITION_SLTP_REQ',         res: 'ProtoOAExecutionEvent' },
  reconcile:     { req: 'ProtoOAReconcileReq',                   enum: 'PROTO_OA_RECONCILE_REQ',                   res: 'ProtoOAReconcileRes' }
};

const ORDER_TYPE_MARKET = 1; // ProtoOAOrderType.MARKET
const EXECUTION = { ORDER_ACCEPTED: 2, ORDER_FILLED: 3, ORDER_REJECTED: 7, ORDER_CANCELLED: 5, ORDER_EXPIRED: 6, ORDER_CANCEL_REJECTED: 8 };
const SPOT_EVENT = 'PROTO_OA_SPOT_EVENT';

let rootPromise = null;
function loadRoot() {
  if (!rootPromise) {
    rootPromise = protobuf.load([
      path.join(PROTO_DIR, 'OpenApiCommonMessages.proto'),
      path.join(PROTO_DIR, 'OpenApiMessages.proto')
    ]);
  }
  return rootPromise;
}

class OpenApiClient {
  constructor(environment = 'demo', { onClose } = {}) {
    if (!HOSTS[environment]) throw new Error(`Unknown cTrader environment: ${environment}`);
    this.host = HOSTS[environment];
    this.onClose = onClose || (() => {});
    this.onSpot = null; // (spotMessage) => void, set by the market feed
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextMsgId = 1;
    this.heartbeatTimer = null;
  }

  async open() {
    const root = await loadRoot();
    this.root = root;
    this.ProtoMessage = root.lookupType('ProtoMessage');
    this.ProtoOAPayload = root.lookupEnum('ProtoOAPayloadType').values;
    this.ProtoPayload = root.lookupEnum('ProtoPayloadType').values;
    for (const op of Object.values(OPS)) {
      if (this.ProtoOAPayload[op.enum] === undefined) throw new Error(`Missing payload type ${op.enum}`);
    }

    await new Promise((resolve, reject) => {
      const socket = tls.connect({ host: this.host, port: PORT, servername: this.host }, () => {
        socket.removeListener('error', reject);
        resolve();
      });
      socket.once('error', reject);
      this.socket = socket;
    });

    this.socket.setKeepAlive(true, 20000);
    this.socket.on('data', chunk => this._onData(chunk));
    this.socket.on('error', err => this._fail(err));
    this.socket.on('close', () => this._fail(new Error('cTrader connection closed')));
    this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), HEARTBEAT_MS);
  }

  close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.socket) { this.socket.destroy(); this.socket = null; }
  }

  applicationAuth(clientId, clientSecret) {
    return this._request('appAuth', { clientId, clientSecret });
  }

  async getAccounts(accessToken) {
    const res = await this._request('accountList', { accessToken });
    return this._plain(OPS.accountList.res, res).ctidTraderAccount || [];
  }

  accountAuth(ctidTraderAccountId, accessToken) {
    return this._request('accountAuth', { ctidTraderAccountId, accessToken });
  }

  async getTrader(ctidTraderAccountId) {
    const res = await this._request('trader', { ctidTraderAccountId });
    return this._plain(OPS.trader.res, res).trader;
  }

  async getSymbolsList(ctidTraderAccountId) {
    const res = await this._request('symbolsList', { ctidTraderAccountId });
    return this._plain(OPS.symbolsList.res, res).symbol || [];
  }

  async getSymbolsById(ctidTraderAccountId, symbolIds) {
    const res = await this._request('symbolById', { ctidTraderAccountId, symbolId: symbolIds });
    return this._plain(OPS.symbolById.res, res).symbol || [];
  }

  subscribeSpots(ctidTraderAccountId, symbolIds) {
    return this._request('subscribeSpots', { ctidTraderAccountId, symbolId: symbolIds });
  }

  async getTrendbars({ ctidTraderAccountId, symbolId, period, count, fromTimestamp, toTimestamp }) {
    const res = await this._request('trendbars', { ctidTraderAccountId, symbolId, period, count, fromTimestamp, toTimestamp });
    return this._plain(OPS.trendbars.res, res).trendbar || [];
  }

  // Market order. Resolves with the filled execution (position + deal); rejects on ORDER_REJECTED.
  async newMarketOrder({ ctidTraderAccountId, symbolId, tradeSide, volume, label, comment }) {
    const ev = await this._request('newOrder', {
      ctidTraderAccountId, symbolId, orderType: ORDER_TYPE_MARKET, tradeSide, volume, label, comment
    }, { accept: isFinalExecution });
    return this._executionResult(ev, 'Order');
  }

  async closePosition({ ctidTraderAccountId, positionId, volume }) {
    const ev = await this._request('closePosition', { ctidTraderAccountId, positionId, volume }, { accept: isFinalExecution });
    return this._executionResult(ev, 'Close');
  }

  // Sets absolute stop-loss / take-profit on an open position.
  async amendSltp({ ctidTraderAccountId, positionId, stopLoss, takeProfit }) {
    // The amend is answered with an execution event whose type is not a fill (e.g. ORDER_REPLACED).
    const ev = await this._request('amendSltp', { ctidTraderAccountId, positionId, stopLoss, takeProfit }, { accept: isAmendReply });
    return this._executionResult(ev, 'Amend SL/TP');
  }

  async reconcile(ctidTraderAccountId) {
    const res = await this._request('reconcile', { ctidTraderAccountId });
    return this._plain(OPS.reconcile.res, res);
  }

  // ---- internals ----

  _plain(typeName, msg) {
    return this.root.lookupType(typeName).toObject(msg, { longs: Number, enums: String });
  }

  _executionResult(ev, action) {
    const plain = this._plain(OPS.newOrder.res, ev);
    if (plain.executionType === 'ORDER_REJECTED' || plain.executionType === 'ORDER_CANCEL_REJECTED') {
      throw new Error(`${action} rejected: ${plain.errorCode || plain.executionType}`);
    }
    return plain;
  }

  // opts.accept(decodedMsg) → true when this response completes the request (default: first reply).
  _request(op, fields, opts = {}) {
    if (!this.socket) return Promise.reject(new Error('cTrader socket not open'));
    const { req, enum: enumName, res } = OPS[op];
    const payloadType = this.ProtoOAPayload[enumName];
    const reqType = this.root.lookupType(req);
    const payload = reqType.encode(reqType.create({ payloadType, ...fields })).finish();
    const clientMsgId = String(this.nextMsgId++);
    const frame = this.ProtoMessage.encode(this.ProtoMessage.create({ payloadType, payload, clientMsgId })).finish();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId);
        providerErrors.record('timeout', req);
        reject(new Error(`cTrader request timed out: ${req}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(clientMsgId, {
        resType: res,
        accept: opts.accept || (() => true),
        resolve: msg => { clearTimeout(timer); this.pending.delete(clientMsgId); resolve(msg); },
        reject: err => { clearTimeout(timer); this.pending.delete(clientMsgId); reject(err); }
      });
      this._write(frame);
    });
  }

  _sendHeartbeat() {
    const frame = this.ProtoMessage.encode(this.ProtoMessage.create({
      payloadType: this.ProtoPayload.HEARTBEAT_EVENT
    })).finish();
    this._write(frame);
  }

  _write(frame) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(frame.length, 0);
    this.socket.write(Buffer.concat([header, Buffer.from(frame)]));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) break;
      const frame = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      try {
        this._onFrame(frame);
      } catch (e) {
        // A bad frame must not take the whole server down; the request it belonged to will time out.
        console.log(`[cTrader] dropped unreadable message: ${e.message}`);
      }
    }
  }

  _onFrame(frame) {
    const wrapper = this.ProtoMessage.decode(frame);
    const id = wrapper.clientMsgId;
    const pending = id ? this.pending.get(id) : null;

    if (wrapper.payloadType === this.ProtoPayload.ERROR_RES || wrapper.payloadType === this.ProtoOAPayload.PROTO_OA_ERROR_RES) {
      const errType = wrapper.payloadType === this.ProtoPayload.ERROR_RES ? 'ProtoErrorRes' : 'ProtoOAErrorRes';
      const err = this.root.lookupType(errType).decode(wrapper.payload);
      const error = new Error(`cTrader error ${err.errorCode || ''}: ${err.description || 'unknown'}`);
      error.code = err.errorCode;
      providerErrors.record('error_response', error.message);
      if (pending) pending.reject(error);
      else this._fail(error);
      return;
    }

    if (wrapper.payloadType === this.ProtoPayload.HEARTBEAT_EVENT) return;

    if (pending) {
      const msg = this.root.lookupType(pending.resType).decode(wrapper.payload);
      if (pending.accept(msg)) pending.resolve(msg);
      return;
    }

    if (wrapper.payloadType === this.ProtoOAPayload[SPOT_EVENT] && this.onSpot) {
      this.onSpot(this._plain('ProtoOASpotEvent', this.root.lookupType('ProtoOASpotEvent').decode(wrapper.payload)));
      return;
    }

    // Server-side session events: this connection is no longer usable.
    if (wrapper.payloadType === this.ProtoOAPayload.PROTO_OA_CLIENT_DISCONNECT_EVENT ||
        wrapper.payloadType === this.ProtoOAPayload.PROTO_OA_ACCOUNTS_TOKEN_INVALIDATED_EVENT) {
      this._fail(new Error('cTrader session ended by server — reauthorization may be required'));
    }
  }

  _fail(err) {
    const wasOpen = !!this.socket;
    if (wasOpen) providerErrors.record('connection', err.message);
    for (const p of [...this.pending.values()]) p.reject(err);
    this.pending.clear();
    this.close();
    if (wasOpen) this.onClose(err);
  }
}

// An execution event that finishes a market order / close (not the intermediate ACCEPTED).
function isFinalExecution(ev) {
  return [EXECUTION.ORDER_FILLED, EXECUTION.ORDER_REJECTED, EXECUTION.ORDER_CANCELLED,
    EXECUTION.ORDER_EXPIRED, EXECUTION.ORDER_CANCEL_REJECTED].includes(ev.executionType);
}

// The broker answers an amend with a single execution event: ACCEPTED when the new levels pass validation,
// REJECTED (handled by _executionResult) when they do not.
function isAmendReply() {
  return true;
}

module.exports = { OpenApiClient, HOSTS, PORT, EXECUTION };
