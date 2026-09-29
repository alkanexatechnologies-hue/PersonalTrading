import type { IndexProbability, Bias } from "./types";

// ============================ Index direction probability (model estimate) ============================
// A TRANSPARENT, evidence-based blend of the real signals available this cycle —
// NOT a trading strategy and NOT a guaranteed prediction. Each factor contributes
// a bounded lean in [-1,+1] (bull positive) with a fixed, documented weight. Only
// factors that are actually present are counted; with fewer than three real
// factors the model returns DATA INSUFFICIENT rather than manufacturing a number.

export interface ProbInputs {
  index: string;
  changePct: number | null;   // index move so far (pre-market / last)
  vix: number | null;         // India VIX level
  vixChangePct: number | null;
  newsLean: number | null;    // -1..+1  (net high-impact news skew)
  globalLean: number | null;  // -1..+1  (global markets)
  fiiLean: number | null;     // -1..+1  (FII futures pressure)
  bankingLean: number | null; // -1..+1
  breadthLean: number | null; // -1..+1  (advancers vs decliners)
  spot: number | null;        // for the VIX-implied expected-move band
}

// Fixed weights (sum≈1 when all present). Documented, not arbitrary per-run tuning.
const W = { change: 0.20, global: 0.20, fii: 0.20, banking: 0.15, breadth: 0.15, news: 0.10 };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function computeProbability(inp: ProbInputs): IndexProbability {
  const factors: IndexProbability["factors"] = [];
  const leans: { w: number; lean: number }[] = [];
  const add = (present: boolean, w: number, lean: number, label: string, value: string) => {
    if (!present) return;
    const l = clamp(lean, -1, 1);
    leans.push({ w, lean: l });
    factors.push({ label, value, lean: l > 0.1 ? "bull" : l < -0.1 ? "bear" : "neutral" });
  };

  // Index move: normalise ±1.5% ⇒ full lean.
  add(inp.changePct != null, W.change, (inp.changePct ?? 0) / 1.5, "Index Move",
    inp.changePct != null ? `${inp.changePct >= 0 ? "+" : ""}${inp.changePct.toFixed(2)}%` : "—");
  add(inp.globalLean != null, W.global, inp.globalLean ?? 0, "Global Markets", leanWord(inp.globalLean));
  add(inp.fiiLean != null, W.fii, inp.fiiLean ?? 0, "FII Futures", leanWord(inp.fiiLean));
  add(inp.bankingLean != null, W.banking, inp.bankingLean ?? 0, "Banking", leanWord(inp.bankingLean));
  add(inp.breadthLean != null, W.breadth, inp.breadthLean ?? 0, "Sector Breadth", leanWord(inp.breadthLean));
  add(inp.newsLean != null, W.news, inp.newsLean ?? 0, "News Flow", leanWord(inp.newsLean));

  // VIX is a risk/range input rather than a directional one — it widens the band
  // and, when spiking, lowers confidence.
  const vixHot = inp.vix != null && inp.vix >= 18;
  if (inp.vix != null) factors.push({ label: "India VIX", value: `${inp.vix.toFixed(2)}${inp.vixChangePct != null ? ` (${inp.vixChangePct >= 0 ? "+" : ""}${inp.vixChangePct.toFixed(1)}%)` : ""}`, lean: "neutral" });

  if (leans.length < 3) {
    return { index: inp.index, available: false, upside: null, range: null, downside: null,
      expectedLow: null, expectedHigh: null, confidence: null, bias: null, factors,
      note: "DATA INSUFFICIENT — fewer than three real inputs available this cycle." };
  }

  // Weighted mean lean over the PRESENT factors (re-normalise weights).
  const wsum = leans.reduce((a, x) => a + x.w, 0) || 1;
  const score = leans.reduce((a, x) => a + x.w * x.lean, 0) / wsum; // -1..+1

  // Conviction shrinks the RANGE bucket and splits the rest by direction.
  const range = clamp(40 - Math.abs(score) * 26 + (vixHot ? -6 : 0), 12, 46);
  const remaining = 100 - range;
  let upside = remaining * (0.5 + score * 0.5);
  let downside = remaining - upside;
  // round + normalise to exactly 100
  upside = Math.round(upside); downside = Math.round(downside);
  const rng = 100 - upside - downside;

  // Expected-move band from VIX (daily sigma ≈ VIX% / sqrt(252)).
  let expectedLow: number | null = null, expectedHigh: number | null = null;
  if (inp.spot != null && inp.vix != null) {
    const sigmaDay = (inp.vix / 100) / Math.sqrt(252);
    expectedLow = Math.round(inp.spot * (1 - sigmaDay));
    expectedHigh = Math.round(inp.spot * (1 + sigmaDay));
  }

  // Agreement → confidence (plus factor count, minus VIX spike).
  const agree = 1 - stdev(leans.map((l) => l.lean)); // 1 = all agree
  let confScore = leans.length * 0.12 + agree * 0.5 - (vixHot ? 0.15 : 0);
  const confidence: IndexProbability["confidence"] = confScore >= 0.75 ? "HIGH" : confScore >= 0.5 ? "MEDIUM" : "LOW";

  const disagree = stdev(leans.map((l) => l.lean)) > 0.6;
  const bias: Bias = disagree ? "MIXED" : score > 0.2 ? "BULLISH" : score < -0.2 ? "BEARISH" : "NEUTRAL";

  return { index: inp.index, available: true, upside, range: rng, downside,
    expectedLow, expectedHigh, confidence, bias, factors, note: "Model estimate — not a guaranteed prediction." };
}

export function overallBiasFromLeans(leans: (number | null)[]): Bias {
  const present = leans.filter((l): l is number => l != null);
  if (present.length < 2) return "NEUTRAL";
  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  if (stdev(present) > 0.6) return "MIXED";
  return mean > 0.2 ? "BULLISH" : mean < -0.2 ? "BEARISH" : "NEUTRAL";
}

function leanWord(l: number | null): string { return l == null ? "—" : l > 0.15 ? "Bullish" : l < -0.15 ? "Bearish" : "Neutral"; }
function stdev(xs: number[]): number { if (xs.length < 2) return 0; const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); }
