class SMCStrategy {
  constructor(config = {}) {
    this.pivotLen = config.pivotLen || 5;
    this.minBodyPerc = config.minBodyPerc || 60.0;
    this.atrMult = config.atrMult || 1.5;
    this.lookback = config.lookback || 20;

    this.tpStrategy = config.tpStrategy || "Fixed RR";
    this.rr1 = config.rr1 || 2.0;
    this.rr2 = config.rr2 || 3.0;
    this.majorPivot = config.majorPivot || 15;

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
    if (candles.length < 50) {
      return null;
    }

    const i = candles.length - 1;
    const c = candles;

    const atr = this.calculateATR(c, 14);

    if (!atr) {
      return null;
    }

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

    const ph = this.pivotHigh(c, i, this.pivotLen);
    const pl = this.pivotLow(c, i, this.pivotLen);

    if (ph !== null) {
      this.lastHigh = ph;
    }

    if (pl !== null) {
      this.lastLow = pl;
    }

    const majorHigh = this.pivotHigh(c, i, this.majorPivot);
    const majorLow = this.pivotLow(c, i, this.majorPivot);

    if (majorHigh !== null) {
      this.keyHigh = majorHigh;
    }

    if (majorLow !== null) {
      this.keyLow = majorLow;
    }

    if (this.lastHigh === null || this.lastLow === null) {
      return null;
    }

    const prev = c[i - 1];
    const curr = c[i];

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

    if (this.pendingLong) {
      this.longAge += 1;

      if (bullBOS) {
        const entry = curr.close;
        const risk = entry - this.longSL;

        if (risk > 0) {
          let tp1;
          let tp2;

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
            reason: "Bullish FVG + liquidity sweep + bullish BOS",
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

      if (bearBOS) {
        const entry = curr.close;
        const risk = this.shortSL - entry;

        if (risk > 0) {
          let tp1;
          let tp2;

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
            reason: "Bearish FVG + liquidity sweep + bearish BOS",
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

  isDisplaced(candles, idx, atr) {
    const candle = candles[idx];

    const bodySize = Math.abs(candle.close - candle.open);
    const candleRange = candle.high - candle.low;

    if (candleRange <= 0) {
      return false;
    }

    const bodyPercent = (bodySize / candleRange) * 100;

    return candleRange > atr * this.atrMult && bodyPercent >= this.minBodyPerc;
  }

  isBullFVG(candles, i, atr) {
    if (i < 2) {
      return false;
    }

    return (
      candles[i].low > candles[i - 2].high &&
      candles[i - 1].close > candles[i - 1].open &&
      this.isDisplaced(candles, i - 1, atr)
    );
  }

  isBearFVG(candles, i, atr) {
    if (i < 2) {
      return false;
    }

    return (
      candles[i].high < candles[i - 2].low &&
      candles[i - 1].close < candles[i - 1].open &&
      this.isDisplaced(candles, i - 1, atr)
    );
  }

  calculateATR(candles, period) {
    if (candles.length < period + 2) {
      return null;
    }

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

    if (pivotIndex - len < 0 || pivotIndex + len >= candles.length) {
      return null;
    }

    const pivotValue = candles[pivotIndex].high;

    for (let j = pivotIndex - len; j <= pivotIndex + len; j++) {
      if (j === pivotIndex) {
        continue;
      }

      if (candles[j].high >= pivotValue) {
        return null;
      }
    }

    return pivotValue;
  }

  pivotLow(candles, currentIndex, len) {
    const pivotIndex = currentIndex - len;

    if (pivotIndex - len < 0 || pivotIndex + len >= candles.length) {
      return null;
    }

    const pivotValue = candles[pivotIndex].low;

    for (let j = pivotIndex - len; j <= pivotIndex + len; j++) {
      if (j === pivotIndex) {
        continue;
      }

      if (candles[j].low <= pivotValue) {
        return null;
      }
    }

    return pivotValue;
  }

  cleanupBoxes(close) {
    this.bullBoxes = this.bullBoxes.filter((box) => close >= box.bottom);
    this.bearBoxes = this.bearBoxes.filter((box) => close <= box.top);

    const maxBoxes = 100;

    if (this.bullBoxes.length > maxBoxes) {
      this.bullBoxes = this.bullBoxes.slice(this.bullBoxes.length - maxBoxes);
    }

    if (this.bearBoxes.length > maxBoxes) {
      this.bearBoxes = this.bearBoxes.slice(this.bearBoxes.length - maxBoxes);
    }
  }
}

module.exports = SMCStrategy;
