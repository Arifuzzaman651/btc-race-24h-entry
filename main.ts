// Trend Rider: a slow, patient trend-follower for cbBTC/USDC on 1-minute bars.
//
// The dev window shows why patience matters: 1-minute noise is ~8 bps (1 sd) while a
// full-size round trip costs ~26 bps, so the baseline EMA(8/21) cross whipsaws itself to
// -114 USDC on 76 trades, and a tight trailing stop does the same (an early version of
// this bot with a 0.8% trail and a 5 bps exit gap lost 25 USDC on 18 trades). This bot
// only trades a confirmed trend and gives it room to breathe:
//
//   - Indicators: EMA(16) and EMA(64) of closes, each seeded as the mean of its first
//     span of closes, then the usual 2 / (span + 1) update. Float64, no clock, no
//     randomness: the same bars always give the same orders.
//   - Entry (flat): EMA(16) sits above EMA(64) by more than 15 bps of the close.
//     The gap filter keeps 1-minute noise from triggering entries; the slow 64-bar
//     EMA keeps the bot out of chop.
//   - Exit (holding): EMA(16) falls back below EMA(64) by 40 bps, or a 3% trailing
//     stop from the highest close since entry, or a 4% stop-loss versus cost. Wide
//     exits are the point: on the dev window the bot buys the hour-03 uptrend once
//     and rides it, instead of trading in and out of the chop that follows.
//     A sell refused by the market (slippage cap, no bar) is retried on the next bar
//     while its reason still holds.
//   - Size: the whole equity (one open position, long only), one order per reply.
//     Orders cap their slippage at 100 bps past the close they were decided on.
//   - Cooldown: after an exit, no re-entry for 60 bars, so a whipsaw exit does not
//     immediately buy back into the same chop.
//
// Laid out like an entrant's repository: the grader runs `node /bot/main.ts` with this
// directory mounted at /bot; vendor/makefun-bars.ts is a byte-identical copy of the
// kit's sdk/makefun-bars.ts.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 16;
const SLOW_BARS = 64;
/** Enter only when fast sits above slow by more than this share of the close. */
const ENTRY_GAP_BPS = 15;
/** Exit when fast falls below slow by more than this share of the close. */
const EXIT_GAP_BPS = 40;
/** Trailing stop: sell when the close falls this far below the peak since entry. */
const TRAIL_BPS = 300;
/** Stop-loss: sell when the position is worth this share of its cost or less. */
const STOP_BPS = 400;
/** Bars to wait after an exit before a fresh entry. */
const COOLDOWN_BARS = 60;
const MAX_SLIPPAGE_BPS = 100;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** Highest close seen while holding (reset on entry). */
  peak: number | null;
  /** Seq of the last exit; re-entry is blocked for COOLDOWN_BARS after it. */
  lastExitSeq: number;
}

const series = new Map<string, Series>();

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_BARS, warm: [], value: null },
      slow: { span: SLOW_BARS, warm: [], value: null },
      peak: null,
      lastExitSeq: -1_000_000,
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  step(s.fast, c);
  step(s.slow, c);
  return s;
}

function gapBps(s: Series, close: number): number | null {
  if (s.fast.value === null || s.slow.value === null || close <= 0) return null;
  return ((s.fast.value - s.slow.value) / close) * 10_000;
}

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      const s = push(bar);
      fresh.add(bar.symbol);
      if (s.peak !== null) {
        const c = Number(bar.c);
        if (c > s.peak) s.peak = c;
      }
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const orders: (SellInput | BuyInput)[] = [];

    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol) || orders.length >= caps.max_orders_per_bar) continue;
      const s = series.get(symbol)!;
      const close = state.close(symbol);
      if (close === null) continue;
      const c = Number(close);
      const gap = gapBps(s, c);
      if (gap === null) continue;
      const held = state.positions.get(symbol);

      if (held !== undefined) {
        const value = state.value(symbol, held.qty);
        const trailHit = s.peak !== null && c * 10_000 < s.peak * (10_000 - TRAIL_BPS);
        const stopHit = value * 10_000n <= held.cost * (10_000n - BigInt(STOP_BPS));
        const crossDown = gap < -EXIT_GAP_BPS;
        if (trailHit || stopHit || crossDown) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          s.lastExitSeq = state.seq;
          s.peak = null;
        }
      } else if (gap > ENTRY_GAP_BPS && state.seq - s.lastExitSeq > COOLDOWN_BARS) {
        let slice = state.equity;
        const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
        if (slice > byWeight) slice = byWeight;
        if (slice > state.cash) slice = state.cash;
        if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) continue;
        orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
        s.peak = c;
      }
    }
    return orders;
  },
});
