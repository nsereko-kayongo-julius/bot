class SMCStrategy {
  constructor(config = {}) {
    // SMC Parameters
    this.pivotLen = config.pivotLen || 5;
    this.minBodyPerc = config.minBodyPerc || 60.0;
    this.atrMult = config.atrMult || 1.5;
    this.lookback = config.lookback || 20;

    // TP/SL Settings
    this.tpStrategy = config.tpStrategy || "Fixed RR";
    this.rr1 = config.rr1 || 2.0;
    this.rr2 = config.rr2 || 3.0;
    this.majorPivot = config.majorPivot || 15;

    // Optimized 1-Minute Filters
    this.useTrend = config.useTrend !== undefined ? config.useTrend : true;
    this.emaLen = config.emaLen || 200;
    // Session times formatted as UTC hour arrays: [[startHour, startMin, endHour, endMin], ...]
    // Default handles London (07:00-11:00 UTC) and NY (13:00-16:30 UTC)
    this.allowedSessions = [
      { startH: 7, startM: 0, endH: 11, endM: 0 },
      { startH: 13, startM: 0, endH: 16, endM: 30 },
    ];

    // State Tracking Arrays & Objects
    this.bullBoxes = [];
    this.bearBoxes = [];
    this.lastHigh = null;
    this.lastLow = null;
    this.keyHigh = null;
    this.keyLow = null;

    this.pendingLong = false;
    this.longSL = null;
    this.longAge = 0;

    this.pendingShort = false;
    this.shortSL = null;
    this.shortAge = 0;

    this.lastSignalTime = null;
  }

  update(candles) {
    // Require enough data to establish an accurate 200 EMA trend line
    if (candles.length < Math.max(50, this.emaLen)) {
      return null;
    }

    const i = candles.length - 1;
    const c = candles;
    const curr = c[i];
    const prev = c[i - 1];

    // Calculate Core Metrics
    const atr = this.calculateATR(c, 14);
    const ema200 = this.calculateEMA(c, this.emaLen);

    if (!atr || !ema200) {
      return null;
    }

    // Evaluate Environment Conditions (Time Filter)
    const inSession = this.checkSession(curr.time);

    // Calculate FVGs
    const bullFVG = this.isBullFVG(c, i, atr);
    const bearFVG = this.isBearFVG(c, i, atr);

    if (bullFVG) {
      this.bullBoxes.push({
        leftIndex: i - 2,
        rightIndex: i,
        top: c[i].low,
        bottom: c[i - 2].high,
        createdAt: c[i].time,
      });
    }

    if (bearFVG) {
      this.bearBoxes.push({
        leftIndex: i - 2,
        rightIndex: i,
        top: c[i - 2].low,
        bottom: c[i].high,
        createdAt: c[i].time,
      });
    }

    // Track Pivot Levels
    const ph = this.pivotHigh(c, i, this.pivotLen);
    const pl = this.pivotLow(c, i, this.pivotLen);

    if (ph !== null) this.lastHigh = ph;
    if (pl !== null) this.lastLow = pl;

    const majorHigh = this.pivotHigh(c, i, this.majorPivot);
    const majorLow = this.pivotLow(c, i, this.majorPivot);

    if (majorHigh !== null) this.keyHigh = majorHigh;
    if (majorLow !== null) this.keyLow = majorLow;

    if (this.lastHigh === null || this.lastLow === null) {
      return null;
    }

    // Structure Breaks & Liquidity Sweeps
    const bullSweep =
      curr.low < this.lastLow &&
      curr.close > this.lastLow &&
      prev.low >= this.lastLow;
    const bearSweep =
      curr.high > this.lastHigh &&
      curr.close < this.lastHigh &&
      prev.high <= this.lastHigh;
    const bullBOS = curr.close > this.lastHigh && prev.close <= this.lastHigh;
    const bearBOS = curr.close < this.lastLow && prev.close >= this.lastLow;

    // Setup Validation via FVG Taps
    if (bullSweep) {
      let tapped = false;
      for (const box of this.bullBoxes) {
        if (curr.low <= box.top && curr.low >= box.bottom) {
          tapped = true;
          break;
        }
      }
      if (tapped) {
        this.pendingLong = true;
        this.longSL = curr.low;
        this.longAge = 0;
        console.log("Bullish sweep tapped FVG. Pending LONG armed.");
      }
    }

    if (bearSweep) {
      let tapped = false;
      for (const box of this.bearBoxes) {
        if (curr.high >= box.bottom && curr.high <= box.top) {
          tapped = true;
          break;
        }
      }
      if (tapped) {
        this.pendingShort = true;
        this.shortSL = curr.high;
        this.shortAge = 0;
        console.log("Bearish sweep tapped FVG. Pending SHORT armed.");
      }
    }

    let signal = null;

    // Entry Evaluations incorporating Time Filters and EMA Trend Confirmations
    if (this.pendingLong) {
      this.longAge += 1;

      // Filter Condition: Must break structure during active market sessions above the 200 EMA
      if (bullBOS && inSession && (!this.useTrend || curr.close > ema200)) {
        const entry = curr.close;
        const risk = entry - this.longSL;

        if (risk > 0) {
          let tp1, tp2;
          if (this.tpStrategy === "Key Level Target") {
            tp1 =
              this.keyHigh !== null && this.keyHigh > entry
                ? this.keyHigh
                : entry + risk * 2.0;
            tp2 = tp1;
          } else {
            tp1 = entry + risk * this.rr1;
            tp2 = entry + risk * this.rr2;
          }

          signal = {
            strategy: "SMC_FVG_SWEEP_BOS",
            action: "buy",
            entry,
            sl: this.longSL,
            tp1,
            tp2,
            risk,
            time: curr.time,
            reason: "Bullish FVG + sweep + BOS (Session & Trend Validated)",
          };
          this.pendingLong = false;
        }
      }

      if (this.longAge > this.lookback || curr.close < this.longSL) {
        this.pendingLong = false;
      }
    }

    if (this.pendingShort) {
      this.shortAge += 1;

      // Filter Condition: Must break structure during active market sessions below the 200 EMA
      if (bearBOS && inSession && (!this.useTrend || curr.close < ema200)) {
        const entry = curr.close;
        const risk = this.shortSL - entry;

        if (risk > 0) {
          let tp1, tp2;
          if (this.tpStrategy === "Key Level Target") {
            tp1 =
              this.keyLow !== null && this.keyLow < entry
                ? this.keyLow
                : entry - risk * 2.0;
            tp2 = tp1;
          } else {
            tp1 = entry - risk * this.rr1;
            tp2 = entry - risk * this.rr2;
          }

          signal = {
            strategy: "SMC_FVG_SWEEP_BOS",
            action: "sell",
            entry,
            sl: this.shortSL,
            tp1,
            tp2,
            risk,
            time: curr.time,
            reason: "Bearish FVG + sweep + BOS (Session & Trend Validated)",
          };
          this.pendingShort = false;
        }
      }

      if (this.shortAge > this.lookback || curr.close > this.shortSL) {
        this.pendingShort = false;
      }
    }

    this.cleanupBoxes(curr.close);

    if (signal) {
      if (this.lastSignalTime === signal.time) {
        return null;
      }
      this.lastSignalTime = signal.time;
      return signal;
    }

    return null;
  }

  // Helper function to calculate Exponential Moving Average
  calculateEMA(candles, period) {
    if (candles.length < period) return null;
    let k = 2 / (period + 1);
    // Use simple moving average as baseline entry point for first index
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += candles[j].close;
    }
    let ema = sum / period;

    for (let j = period; j < candles.length; j++) {
      ema = candles[j].close * k + ema * (1 - k);
    }
    return ema;
  }

  // Helper method validating UTC entry times against target sessions
  checkSession(epochTime) {
    const date = new Date(epochTime * 1000);
    const minSinceMidnight = date.getUTCHours() * 60 + date.getUTCMinutes();

    for (const session of this.allowedSessions) {
      const startMin = session.startH * 60 + session.startM;
      const endMin = session.endH * 60 + session.endM;
      if (minSinceMidnight >= startMin && minSinceMidnight <= endMin) {
        return true;
      }
    }
    return false;
  }

  isDisplaced(candles, idx, atr) {
    const candle = candles[idx];
    const bodySize = Math.abs(candle.close - candle.open);
    const candleRange = candle.high - candle.low;
    if (candleRange <= 0) return false;
    const bodyPercent = (bodySize / candleRange) * 100;
    return candleRange > atr * this.atrMult && bodyPercent >= this.minBodyPerc;
  }

  isBullFVG(candles, i, atr) {
    if (i < 2) return false;
    return (
      candles[i].low > candles[i - 2].high &&
      candles[i - 1].close > candles[i - 1].open &&
      this.isDisplaced(candles, i - 1, atr)
    );
  }

  isBearFVG(candles, i, atr) {
    if (i < 2) return false;
    return (
      candles[i].high < candles[i - 2].low &&
      candles[i - 1].close < candles[i - 1].open &&
      this.isDisplaced(candles, i - 1, atr)
    );
  }

  calculateATR(candles, period) {
    if (candles.length < period + 2) return null;
    let trs = [];
    const start = candles.length - period;
    for (let i = start; i < candles.length; i++) {
      const curr = candles[i];
      const prev = candles[i - 1];
      const tr = Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close),
      );
      trs.push(tr);
    }
    return trs.reduce((sum, value) => sum + value, 0) / trs.length;
  }

  pivotHigh(candles, currentIndex, len) {
    const pivotIndex = currentIndex - len;
    if (pivotIndex - len < 0 || pivotIndex + len >= candles.length) return null;
    const pivotValue = candles[pivotIndex].high;
    for (let j = pivotIndex - len; j <= pivotIndex + len; j++) {
      if (j === pivotIndex) continue;
      if (candles[j].high >= pivotValue) return null;
    }
    return pivotValue;
  }

  pivotLow(candles, currentIndex, len) {
    const pivotIndex = currentIndex - len;
    if (pivotIndex - len < 0 || pivotIndex + len >= candles.length) return null;
    const pivotValue = candles[pivotIndex].low;
    for (let j = pivotIndex - len; j <= pivotIndex + len; j++) {
      if (j === pivotIndex) continue;
      if (candles[j].low <= pivotValue) return null;
    }
    return pivotValue;
  }

  cleanupBoxes(close) {
    this.bullBoxes = this.bullBoxes.filter((box) => close >= box.bottom);
    this.bearBoxes = this.bearBoxes.filter((box) => close <= box.top);
    const maxBoxes = 100;
    if (this.bullBoxes.length > maxBoxes)
      this.bullBoxes = this.bullBoxes.slice(this.bullBoxes.length - maxBoxes);
    if (this.bearBoxes.length > maxBoxes)
      this.bearBoxes = this.bearBoxes.slice(this.bearBoxes.length - maxBoxes);
  }
}

module.exports = SMCStrategy;
