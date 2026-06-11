require("dotenv").config();

const WebSocket = require("ws");

const DERIV_APP_ID = process.env.DERIV_APP_ID || "1089";
const SYMBOL = process.env.SYMBOL || "R_100";
const GRANULARITY = Number(process.env.GRANULARITY || 300);
const CANDLE_COUNT = Number(process.env.CANDLE_COUNT || 100);
const SMCStrategy = require("./strategy");
const DERIV_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`;
const DERIV_API_TOKEN = process.env.DERIV_API_TOKEN;
const { requestProposal } = require("./derivTrade");
let ws;
let candles = [];

const STAKE = Number(process.env.STAKE || 1);
const CURRENCY = process.env.CURRENCY || "USD";
const MULTIPLIER = Number(process.env.MULTIPLIER || 100);
const ENABLE_PROPOSALS = process.env.ENABLE_PROPOSALS === "true";
const ENABLE_BUY = process.env.ENABLE_BUY === "true";

function connect() {
  ws = new WebSocket(DERIV_WS_URL);

 ws.on("open", () => {
   console.log("Connected to Deriv WebSocket");
   console.log(`Symbol: ${SYMBOL}`);
   console.log(`Granularity: ${GRANULARITY} seconds`);

   if (!DERIV_API_TOKEN) {
     console.log("No DERIV_API_TOKEN found. Running market-data only.");
     requestCandles();
     return;
   }

   authorize();
 });

  ws.on("message", (data) => {
    const msg = JSON.parse(data);

    if (msg.error) {
      console.error("Deriv error:", msg.error);
      return;
    }

    if (msg.msg_type === "authorize") {
      console.log("Deriv authorization successful.");
      console.log("Account:", msg.authorize.loginid);
      console.log("Currency:", msg.authorize.currency);
      console.log("Balance:", msg.authorize.balance);

      requestCandles();
    }

    if (msg.msg_type === "candles") {
      candles = msg.candles.map(normalizeCandle);

      console.log(`Loaded ${candles.length} historical candles`);

      const last = candles[candles.length - 1];
      console.log("Last historical candle:", last);
      console.log("Waiting for live candle updates...");
    }

    if (msg.msg_type === "ohlc") {
      const candle = normalizeOhlc(msg.ohlc);
      handleLiveCandle(candle);
    }
  });

  ws.on("close", () => {
    console.log("Disconnected from Deriv. Reconnecting in 5 seconds...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
}

const strategy = new SMCStrategy({
  pivotLen: 5,
  minBodyPerc: 60.0,
  atrMult: 1.5,
  lookback: 20,
  tpStrategy: "Fixed RR",
  rr1: 2.0,
  rr2: 3.0,
  majorPivot: 15,
});

function requestCandles() {
  const request = {
    ticks_history: SYMBOL,
    style: "candles",
    granularity: GRANULARITY,
    count: CANDLE_COUNT,
    end: "latest",
    subscribe: 1,
  };

  ws.send(JSON.stringify(request));
}

function authorize() {
  const request = {
    authorize: DERIV_API_TOKEN,
  };

  ws.send(JSON.stringify(request));
}

function normalizeCandle(c) {
  return {
    time: Number(c.epoch),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
  };
}

function normalizeOhlc(c) {
  return {
    time: Number(c.open_time),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
  };
}

function handleLiveCandle(candle) {
  const last = candles[candles.length - 1];

  if (!last) {
    candles.push(candle);
    console.log("First live candle:", candle);
    return;
  }

  if (candle.time === last.time) {
    candles[candles.length - 1] = candle;
    return;
  }

  const closedCandle = candles[candles.length - 1];

  console.log("Closed candle:..", closedCandle);

  candles.push(candle);

  if (candles.length > CANDLE_COUNT) {
    candles.shift();
  }

  const signal = strategy.update(candles);

  if (signal) {
    console.log("======================================");
    console.log("SMC SIGNAL DETECTED");
    console.log(signal);
    console.log("======================================");

    if (ENABLE_PROPOSALS) {
      requestProposal(ws, signal, {
        stake: STAKE,
        currency: CURRENCY,
        symbol: SYMBOL,
        multiplier: MULTIPLIER,
      }).catch((error) => {
        console.error("Proposal error:", error);
      });
    }

    if (!ENABLE_BUY) {
      console.log("ENABLE_BUY=false, so no trade was placed.");
    }
  }

  console.log("New active candle:", candle);
}

connect();
