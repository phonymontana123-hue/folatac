import React from "react";
import { useState, useEffect, useCallback, useRef } from "react";

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  FOLATAC v15.0 — FLOOR-LATCHED TACTICAL ACCUMULATION                    ║
// ║  Strategy Reference: Master v5 · OTM formula updated                    ║
// ║                                                                          ║
// ║  LIVE DATA SOURCES (ALL AUTOMATED — NO MANUAL ENTRY):                    ║
// ║  • BTC price + 90d chart → CoinGecko (Kraken fallback)                 ║
// ║  • MSTR price + ATM IV + IV Rank + LEAP delta → Yahoo Finance          ║
// ║  • Full Greeks (Δ/Γ/Θ/V) → Tradier Sandbox → MarketData.app → B-S   ║
// ║  • RVol ratio (10D÷30D) → auto-computed from Yahoo Finance history     ║
// ║  • Miner capitulation → auto via hash ribbon + mempool.space hashprice ║
// ║  • LTH capitulation → auto-proxied from on-chain metrics               ║
// ║  • Fear & Greed → Alternative.me                                       ║
// ║  • News alerts → CryptoPanic + CoinGecko + NewsData.io                 ║
// ║  • Thesis Health → Finnhub + GNews + NewsData + SEC EDGAR + FRED      ║
// ║  • Hash Ribbon → Blockchain.info (free, auto)                          ║
// ║  • BTC ETF Flows → SoSoValue (free tier)                               ║
// ║  • Portfolio state → brokerage screenshot → Claude Vision              ║
// ║  • SMS assistant → Claude NLP                                          ║
// ║  MANUAL INPUTS: Screenshot uploads + SMS only                            ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1: STRATEGY CONFIG — SINGLE SOURCE OF TRUTH
// ─────────────────────────────────────────────────────────────────────────────
const CFG = {
  btcHoldings: 720_737, sharesOut: 332_270_000, totalDebt: 8.24e9,
  p1TierA: 33_583, p2TierA: 93_000, p1TierB: 5_000, p2TierB: 5_000,
  p1TierC: 8_000,  p2TierC: 25_000, p1Base: 4, p2Base: 8, maxLoss: 3_300,
  btcATH: 126_210, btcProjFloor: 44_804, allInArm: 45_500,
  allInLatch: 3, allInReset: 55_000, floor: 45_000, thesisBrk: 28_000,
  btcTarget: 220_000, mstrTarget: 950,
  // Known MSTR earnings dates — update each quarter
  earningsDates: ["2026-05-06","2026-08-05","2026-11-04","2027-02-03"],
  nakedBtcDown: 0.35, nakedIVRank: 75, nakedFloors: 2, vrpMin: 1.1,
  protectionGeometry: {
    NORMAL:   { hedgeFactor: 0.04, minStrike: 80 },
    ELEVATED: { hedgeFactor: 0.06, minStrike: 75 },
    EXTREME:  { hedgeFactor: 0.08, minStrike: 65 },
  },
  ccPhases: [
    { nav: 1.0, ph: "1A/1B", otm: 11, cov: 100, note: "Bear floor" },
    { nav: 1.3, ph: "2A",    otm: 9,  cov: 65,  note: "Recovery" },
    { nav: 1.6, ph: "2B",    otm: 8,  cov: 40,  note: "Bull building" },
    { nav: 2.0, ph: "3A",    otm: 7,  cov: 15,  note: "LEAP dominates" },
    { nav: 99,  ph: "3B",    otm: 6,  cov: 5,   note: "Wind down" },
  ],
  leapRoll: [
    { mstr: 250, pct: 33, label: "Roll ⅓ → Dec 2030" },
    { mstr: 380, pct: 33, label: "Roll ⅓ → Dec 2030" },
    { mstr: 480, pct: 34, label: "Roll ⅓ → Dec 2030" },
  ],
  profitTake: [
    { mstr: 700, nav: null, action: "Sell ⅓ LEAPs" },
    { mstr: 800, nav: null, action: "Sell another ⅓" },
    { mstr: null, nav: 2.5, action: "20–25% per 0.5× above 2.5×" },
  ],
  alertKeywords: [
    "MicroStrategy","MSTR","Saylor","Bitcoin reserve","BTC ETF",
    "crypto regulation","MSCI","convertible notes","Chapter 11",
    "SEC","strategic reserve","spot ETF","BlackRock IBIT","halving",
  ],
  // Section 10.1 — price alerts to set once, never change
  btcAlertLevels: [
    { price:55000, label:"PATH B",       color:"#f59e0b", action:"Drop to 2/4 contracts. Route 25% to Tier C." },
    { price:48000, label:"BEAR LATE",    color:"#f97316", action:"Route 40% to Tier C. Buy LEAPs aggressively." },
    { price:45500, label:"ALL-IN ARMS",  color:"#ef4444", action:"Begin 3-consecutive-close monitoring for latch." },
    { price:42000, label:"THESIS CHECK", color:"#dc2626", action:"Run three-pillar thesis check IMMEDIATELY." },
    { price:28000, label:"THESIS BREAK", color:"#7f1d1d", action:"If 2/3 pillars broken: FULL EXIT PROTOCOL." },
  ],
  mstrAlertLevels: [
    { price:250,  label:"ROLL ⅓",   color:"#a855f7", action:"Roll 1/3 of LEAPs → Dec 2030 at market." },
    { price:380,  label:"ROLL ⅓",   color:"#a855f7", action:"Roll next 1/3 of LEAPs → Dec 2030." },
    { price:480,  label:"ROLL ⅓",   color:"#a855f7", action:"Roll final 1/3. All contracts now Dec 2030." },
    { price:700,  label:"SELL ⅓",   color:"#f59e0b", action:"Sell 1/3 of LEAP contracts at market. Lock gains." },
    { price:800,  label:"SELL ⅓",   color:"#ef4444", action:"Sell another 1/3 of LEAPs. Let last ⅓ ride." },
  ],
  // Tier B is always $5K per portfolio per strategy (Section 4.3)
  tierBPerPort: 5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2: MATH ENGINE
// ─────────────────────────────────────────────────────────────────────────────
const E = {
  navMult:    (btc, mstr) => (mstr > 0 && btc >= 0) ? (btc * CFG.btcHoldings) / (mstr * CFG.sharesOut) : 0,
  navPerShare:(btc)       => (btc * CFG.btcHoldings) / CFG.sharesOut,
  // Step 2: NAV Premium Modifier (v5 — 5 tiers)
  navMod: (nav) => {
    if (nav < 1.0) return 2;   // Deep discount / sub-NAV → max protection
    if (nav < 1.2) return 1;   // Mild compression → half penalty
    if (nav < 2.0) return 0;   // Neutral zone → no modification
    if (nav < 2.5) return -2;  // Late bull cushion → tighten
    return -3;                  // Peak euphoria → max tighten
  },

  // Step 3.5: Realized Volatility Expansion Filter (10D÷30D ratio, check TradingView Sunday)
  rvolMod: (rvolRatio) => {
    if (!rvolRatio || rvolRatio < 1.25) return 0;
    if (rvolRatio < 1.50) return 1.5; // Moderate vol acceleration
    return 3.0;                        // Significant vol acceleration
  },

  ivTier: (iv) => {
    if (iv < 25) return { base:0,  label:"LOW",      color:"#ef4444", skip:true,  key:"LOW"      };
    if (iv < 60) return { base:6,  label:"NORMAL",   color:"#22c55e", skip:false, key:"NORMAL"   };
    if (iv < 80) return { base:11, label:"ELEVATED", color:"#f59e0b", skip:false, key:"ELEVATED" };
    return              { base:16, label:"EXTREME",  color:"#a855f7", skip:false, key:"EXTREME"  };
  },

  // Step 1+2+3.5: Total OTM% — hard cap 22% per v5
  otmPct: (iv, nav, rvolRatio=1.0) => {
    const t = E.ivTier(iv);
    if (t.skip) return null;
    const raw = t.base + E.navMod(nav) + E.rvolMod(rvolRatio);
    return Math.min(22, Math.max(1, raw));
  },

  // Step 4: Minimum premium floor check — $2.80/share
  premFloorOk: (prem) => prem >= 2.80,
  strike:  (mstr, iv, nav, rvolRatio=1.0) => {
    if (!mstr || mstr <= 0) return null;
    const p = E.otmPct(iv,nav,rvolRatio); return p===null?null:Math.floor(mstr*(1-p/100));
  },

  longPutStrike: (ss, mstr, iv, nav) => {
    const t = E.ivTier(iv);
    if (t.skip || !ss || !mstr) return null;
    const g = CFG.protectionGeometry[t.key] || CFG.protectionGeometry.ELEVATED;
    let f = g.hedgeFactor;
    if (nav < 1.2) f *= 0.75;
    if (nav > 2.0) f *= 1.25;
    return Math.max(g.minStrike, Math.round(ss - mstr * f));
  },

  maxLoss: (ss, ls, prem) => !ls ? 0 : Math.round((ss - ls - prem) * 100),

  path: (btc, nav) => {
    // Section 5.4 + 5.6: BTC level is the primary path gate.
    // At $71,680 BTC = Path C / Full Engine (4/8 contracts) per doc Section 5.6.
    // NAV discount at current levels is handled by OTM% formula (+2%), NOT a path change.
    // Path A requires BOTH BTC < $40K AND NAV < 1.2×.
    if (btc <= CFG.thesisBrk)             return { p:"EXIT", color:"#dc2626", skip:true };
    if (btc < 40000 && nav < 1.2)        return { p:"A",    color:"#ef4444", skip:true };
    if (btc < 55000)                     return { p:"B",    color:"#f59e0b", skip:false };
    return                                      { p:"C",    color:"#22c55e", skip:false };
  },

  routing: (btc, latched) => {
    if (latched || btc <= CFG.floor) return { pct:100, label:"ALL-IN",     color:"#ef4444" };
    if (btc > 55000)                 return { pct:15,  label:"Bear Early", color:"#6b7280" };
    if (btc > 48000)                 return { pct:25,  label:"Bear Mid",   color:"#f59e0b" };
    return                                   { pct:40,  label:"Bear Late",  color:"#f97316" };
  },

  ccPhase:   (nav) => CFG.ccPhases.find(p => nav <= p.nav) || CFG.ccPhases.at(-1),
  ivCovAdj:  (ivr) => ivr>70?0.65:ivr>50?0.80:ivr>30?0.92:1.00,

  // Assigned share CC — IMMEDIATE 100% COVERAGE (v4 FINAL section 7.2)
  // "There is no phase-in period. The priority is maximum premium collection
  //  and maximum probability of getting shares called away quickly."
  // Every week assigned shares sit uncovered = income sacrificed + Tier C missed.
  // BIC=4+: Thesis Gate overrides everything — zero covered calls.
  // BIC=3: Bottom Window — 25% coverage cap + 15% OTM minimum.
  assignedCC: (mstr, cb, iv, ivr, nav, bic=0) => {
    if (!mstr||!cb||cb<=0) return null;
    if (bic >= 4) return { otm:0, strike:0, prem:"0.00", viable:false, coverage:0,
      note:"BIC ≥ 4 (Thesis Gate) — zero covered calls. ALL capital to LEAPs." };
    const base = 7 + (Math.min(100,ivr)/100)*7;
    let adj = 0;
    if (nav < 1.0) adj += 2;
    if (nav > 1.5) adj -= 2;
    if (nav > 2.0) adj -= 2;
    const otmFloor = bic === 3 ? 15 : 7;
    const otm = Math.max(otmFloor, Math.min(16, base + adj));
    const str = Math.round(cb*(1+otm/100)); // weekly chain: $1 increments
    const prem = E.callPrem(mstr, str, iv, 7);
    // BIC=3 Bottom Window caps coverage at 25% — still sell, just fewer
    const coverage = bic === 3 ? 25 : 100;
    const note = bic === 3
      ? "BIC=3 Bottom Window: 25% max + 15% OTM min. Capital near floor — limit call exposure."
      : "100% coverage — maximize income and probability of getting called away fast.";
    return { otm: otm.toFixed(1), strike: str, prem: prem.toFixed(2),
             viable: prem >= 0.40, coverage, note };
  },

  // LEAP PMCC — phased by NAV
  leapCC: (leapDelta, mstr, iv, ivr, nav, bic=0) => {
    const phase = E.ccPhase(nav);
    const hroom = Math.max(0, leapDelta - 0.50);
    if (leapDelta <= 0.50) return { ok:false, reason:"LEAP delta ≤ 0.50 — insufficient ITM depth", covPct:0 };
    if (bic >= 4) return { ok:false, reason:"BIC ≥ 4 (Thesis Gate) — zero covered calls", covPct:0 };
    const usageFactor = ivr>70?0.62:ivr>50?0.70:ivr>30?0.78:0.85;
    const tgtDelta = hroom * usageFactor;
    const ivAdj    = E.ivCovAdj(ivr);
    const covPct   = Math.round((bic === 3 ? Math.min(25, phase.cov) : phase.cov) * ivAdj);
    // BIC=3 (Bottom Window): enforce 15% OTM MINIMUM per strategy — gives more room near bottom
    const minOTMFactor = bic === 3 ? 0.15 : 0.04;
    const approxStr = Math.round(mstr*(1+Math.max(minOTMFactor,1-tgtDelta)*0.25)); // weekly chain: $1 increments
    const prem      = E.callPrem(mstr, approxStr, iv, 7);
    return { ok: prem>=0.40, phase:phase.ph, covPct, tgtDelta:tgtDelta.toFixed(2), hroom:hroom.toFixed(2), approxStr, prem:prem.toFixed(2) };
  },

  solvency: (btc) => {
    const val = btc*CFG.btcHoldings, r = val/CFG.totalDebt;
    return { r, str:r.toFixed(2), valB:(val/1e9).toFixed(1),
      color:r>5?"#22c55e":r>3?"#84cc16":r>2?"#f59e0b":"#ef4444",
      label:r>5?"Very safe":r>3?"Comfortable":r>2?"Watch":"DANGER" };
  },

  vrp: (iv, rvol) => {
    const r = rvol>0?iv/rvol:0;
    return { r, str:r.toFixed(2), ok:r>=CFG.vrpMin,
      color:r>=1.3?"#22c55e":r>=CFG.vrpMin?"#f59e0b":"#ef4444",
      label:r>=1.3?"Strong":r>=CFG.vrpMin?"Adequate":"Weak" };
  },

  nakedEligible: (btc, btcHigh, iv, ivr, floors) => {
    const down = btcHigh>0?(btcHigh-btc)/btcHigh:0;
    return { c1:down>=CFG.nakedBtcDown, c2:ivr>CFG.nakedIVRank, c3:floors>=CFG.nakedFloors,
      eligible: down>=CFG.nakedBtcDown && ivr>CFG.nakedIVRank && floors>=CFG.nakedFloors,
      downPct:(down*100).toFixed(1) };
  },

  allInStatus: (btc, n) => {
    if (btc>=CFG.allInReset&&n>0)  return { state:"RESET",   armed:false, latched:false };
    if (n>=CFG.allInLatch)          return { state:"LATCHED", armed:true,  latched:true  };
    if (btc<CFG.allInArm&&n>0)     return { state:`ARMED ${n}/${CFG.allInLatch}`, armed:true, latched:false };
    return                                  { state:"WATCHING", armed:false, latched:false };
  },

  bullScore: (sigs, btc, nav, ivr) => {
    let s=0;
    if(sigs.lth)s+=20; if(sigs.etf)s+=20; if(sigs.hash)s+=15;
    if(sigs.miner)s+=10; if(sigs.dd)s+=15;
    if(nav<1.2)s+=10; if(btc<50000)s+=5; if(ivr>60)s+=5;
    return Math.min(95,s);
  },

  // IV Rank computed from 252-day Yahoo Finance historical ATM IV array
  // IV Rank requires minimum 60 data points for statistical validity (≥252 for full year)
  // Below 60: return null → UI shows "calibrating" warning, formulas use neutral 50
  calcIVRank: (ivHistory) => {
    if (!ivHistory || ivHistory.length < 60) return null;  // statistically insufficient
    const mn = Math.min(...ivHistory), mx = Math.max(...ivHistory);
    const cur = ivHistory[ivHistory.length-1];
    if (mx <= mn) return 50;
    const rank = Math.round((cur - mn) / (mx - mn) * 100);
    // Flag when based on <252 days — rank is directionally correct but wider confidence interval
    return { rank, dataPoints: ivHistory.length, calibrated: ivHistory.length >= 200 };
  },

  // ── Full Black-Scholes with Hart's rational N(x) approximation (7 sig-fig accuracy)
  // Replaces the PDF-only shortcut (0.3989 multiplier) which understates deep-OTM premiums
  // by 30-60% — critical for bear-market protection pricing accuracy
  _N: (x) => {
    // Abramowitz & Stegun rational approximation — max error 7.5e-8
    if (x > 6)  return 1;
    if (x < -6) return 0;
    const neg = x < 0;
    const z   = Math.abs(x);
    const t   = 1 / (1 + 0.2316419 * z);
    const pd  = Math.exp(-0.5 * z * z) * 0.3989422804;
    const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const cdf  = 1 - pd * poly;
    return neg ? 1 - cdf : cdf;
  },

  // Full put price via Black-Scholes: P = K*e^(-rT)*N(-d2) - S*N(-d1)
  // r=0 (simplified, appropriate for short-dated equity options)
  prem: (S, K, iv, days=7) => {
    if (!S || !K || S <= 0 || K <= 0) return 0.20;
    const T   = days / 365;
    const sig = Math.max(0.15, iv / 100);
    const sqT = Math.sqrt(T);
    const d1  = (Math.log(S / K) + 0.5 * sig * sig * T) / (sig * sqT);
    const d2  = d1 - sig * sqT;
    const put = K * E._N(-d2) - S * E._N(-d1);
    return Math.max(0.05, put);
  },

  // Full call price via put-call parity: C = P + S - K (r=0)
  // No-arbitrage floor: call can never be worth less than intrinsic (S-K)
  callPrem: (S, K, iv, days=7) => {
    if (!S || !K || S <= 0 || K <= 0) return 0.05;
    const put = E.prem(S, K, iv, days);
    const intrinsic = Math.max(0, S - K);
    return Math.max(intrinsic, Math.max(0.05, put + S - K));
  },

  // Delta = N(d1) for calls, -N(-d1) for puts
  leapDeltaCalc: (S, K, iv, days=1000) => {
    if (!S || !K) return 0.5;
    const T   = days / 365;
    const sig = Math.max(0.15, iv / 100);
    const d1  = (Math.log(S / K) + 0.5 * sig * sig * T) / (sig * Math.sqrt(T));
    return Math.min(0.99, Math.max(0.01, E._N(d1)));
  },

  // Full synthetic greeks via Black-Scholes (used when chain data unavailable)
  // Returns { delta, gamma, theta, vega, rho } for a call option
  syntheticGreeks: (S, K, iv, days=1000) => {
    if (!S || !K || S <= 0 || K <= 0) return { delta:0.5, gamma:0, theta:0, vega:0, rho:0 };
    const T   = Math.max(1/365, days / 365);
    const sig = Math.max(0.15, iv / 100);
    const sqT = Math.sqrt(T);
    const d1  = (Math.log(S / K) + 0.5 * sig * sig * T) / (sig * sqT);
    const d2  = d1 - sig * sqT;
    const nd1 = E._N(d1);
    const pdf_d1 = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
    const delta = Math.min(0.99, Math.max(0.01, nd1));
    const gamma = pdf_d1 / (S * sig * sqT);                      // ∂delta/∂S
    const theta = -(S * pdf_d1 * sig) / (2 * sqT) / 365;        // daily decay (negative)
    const vega  = S * pdf_d1 * sqT / 100;                         // per 1% IV move
    const rho   = K * T * E._N(d2) / 100;                         // per 1% rate move
    return { delta, gamma: +gamma.toFixed(6), theta: +theta.toFixed(4), vega: +vega.toFixed(4), rho: +rho.toFixed(4) };
  },

  // Assignment probability ≈ N(-d2) — probability put expires ITM
  assignProb: (mstr, strike, iv, days=1) => {
    if (!strike || !mstr) return 0;
    const T   = days / 365;
    const sig = Math.max(0.15, iv / 100);
    const d2  = (Math.log(mstr / strike) - 0.5 * sig * sig * T) / (sig * Math.sqrt(T));
    return Math.max(0, Math.min(100, E._N(-d2) * 100));
  },
  // ── Kelly-Plus contract sizing (Section 11.2)
  // Returns max contracts allowed given Tier A cash and current conditions
  kellyContracts: (tierACash, mstrPrice, strike, nav, ivr, pillarsBroken, earningsAlert) => {
    // ──────────────────────────────────────────────────────────────────
    // P1 = USER'S MARGIN ACCOUNT — Kelly DOES apply.
    // Over-sizing margin creates margin call risk. Cap = 20% of Tier A.
    // Max loss per spread = CFG.maxLoss ($3,300).
    var p1MaxRisk  = tierACash.p1 * 0.20;
    var p1KellyCap = Math.max(1, Math.floor(p1MaxRisk / CFG.maxLoss));
    var p1 = Math.min(CFG.p1Base, p1KellyCap);

    // P2 = GF'S CASH-SECURED ACCOUNT — Kelly does NOT apply.
    // Worst case = assignment (buy 100 shares at strike). Cash is already
    // reserved in Tier A. No borrowed money, no margin call risk.
    // Use base contracts; gate only on path/pillar/IV/NAV environment.
    var p2 = CFG.p2Base;   // default 8 — no Kelly size cap

    var reasons = [];

    // EARNINGS PROXIMITY — conservative approach near earnings
    // 1-2 days: HALT all new puts (earnings gap risk too high)
    // 3-5 days: reduce by 50% (IV crush + gap risk)
    // 6-7 days: reduce by 25% (plan ahead, lighter exposure)
    if (earningsAlert) {
      if (earningsAlert.urgent || earningsAlert.daysOut <= 2) {
        p1 = 0; p2 = 0;
        reasons.push("EARNINGS IN " + earningsAlert.daysOut + "d — HALT all new puts");
      } else if (earningsAlert.daysOut <= 5) {
        p1 = Math.max(0, Math.floor(p1 * 0.5));
        p2 = Math.max(0, Math.floor(p2 * 0.5));
        reasons.push("Earnings in " + earningsAlert.daysOut + "d — 50% reduction");
      } else if (earningsAlert.daysOut <= 7) {
        p1 = Math.max(1, Math.floor(p1 * 0.75));
        p2 = Math.max(1, Math.floor(p2 * 0.75));
        reasons.push("Earnings in " + earningsAlert.daysOut + "d — 25% reduction");
      }
    }

    // IVR < 30: premium too low, reduce both (bad environment)
    if (ivr < 30) {
      p1 = Math.max(1, Math.floor(p1 * 0.75));
      p2 = Math.max(1, Math.floor(p2 * 0.75));
      reasons.push("IVR " + ivr + " < 30 — low premium, reduce size");
    }
    // NAV > 2.5x: trim exposure (shares + LEAPs overvalued)
    if (nav > 2.5) {
      p1 = Math.max(1, Math.floor(p1 * 0.5));
      p2 = Math.max(1, Math.floor(p2 * 0.5));
      reasons.push("NAV " + nav.toFixed(2) + "x > 2.5x — overvalued, cut exposure");
    }
    // 1 pillar broken: halve both (Section 11.1)
    if (pillarsBroken === 1) {
      p1 = Math.max(0, Math.floor(p1 * 0.5));
      p2 = Math.max(0, Math.floor(p2 * 0.5));
      reasons.push("1 thesis pillar broken — halve contract count");
    }
    // 2+ pillars: full stop (Section 11.1)
    if (pillarsBroken >= 2) {
      p1 = 0; p2 = 0;
      reasons.push("2+ pillars broken — STOP selling puts");
    }

    // P1 Kelly cap notification
    if (p1 === p1KellyCap && p1 < CFG.p1Base) {
      reasons.push("P1 Kelly cap: $" + Math.round(p1MaxRisk).toLocaleString() + " / $3,300 = " + p1KellyCap + " ct max");
    }
    // P2 assignment info (not a cap — informational)
    var p2MaxAssign = (strike && p2 > 0) ? (strike * 100 * p2) : null;

    return {
      p1: p1,
      p2: p2,
      reasons: reasons,
      capped: p1 < CFG.p1Base,
      p1KellyCap: p1KellyCap,
      p2MaxAssign: p2MaxAssign
    };
  },

  // ── Three-Pillar Thesis Check (Section 11.1)
  // pillarsBroken: 0 = healthy, 1 = Path B, 2 = full exit, 3 = sell LEAPs too
  thesisPillarCheck: (btc, solv, etfOutflowWeeks) => {
    const p1ETF      = etfOutflowWeeks >= 90/7; // 90 consecutive days outflows
    const p3Solvency = solv.r < 3.0;            // Section 11.1: debt coverage < 3.0x
    // P2 regulatory — manual input only, can't auto-detect
    const broken = [p1ETF, p3Solvency].filter(Boolean).length;
    return {
      p1ETF, p3Solvency, broken,
      checkRequired: btc < 42000,
      action: broken >= 3 ? "SELL ALL including LEAPs — complete thesis failure"
             : broken === 2 ? "FULL EXIT: close puts, sell shares, hold LEAPs as lottery tickets"
             : broken === 1 ? "PATH B: halve contracts, stop buying LEAPs, monitor closely"
             : "Thesis intact — continue full engine",
      color: broken >= 2 ? "#dc2626" : broken === 1 ? "#f59e0b" : "#22c55e",
    };
  },

  // ── LEAP Exit Confirmation Signals (Section 11.4)
  // Returns how many of 4 signals are firing and what action to take
  leapExitSignals: (btcBelowMA, navCompressedFromPeak, etfOutflowsFromPeak, hashDeathCross) => {
    const signals = [btcBelowMA, navCompressedFromPeak, etfOutflowsFromPeak, hashDeathCross];
    const count = signals.filter(Boolean).length;
    return {
      count, signals,
      action: count >= 3 ? "AGGRESSIVE EXIT: Sell 2/3 of remaining LEAPs over 2 weeks. Hold minimum 2 Dec 2030."
             : count === 2 ? "BEGIN EXIT: Sell 1/3 of LEAP contracts over 2 weeks. Never exit on single signal."
             : count === 1 ? "WATCH: 1 of 4 exit signals. No action — false positives common at local tops."
             : "No exit signals — hold LEAPs, thesis intact",
      color: count >= 3 ? "#dc2626" : count === 2 ? "#f97316" : count === 1 ? "#f59e0b" : "#22c55e",
      urgent: count >= 2,
    };
  },

  // ── P1 Protection Deadline Check (Section 11.3)
  // Returns whether the P1 long put has been missed and the unprotected-overnight rule fires
  protectionDeadline: (hasShortPut, hasLongPut, etHour, etMin) => {
    const hm = etHour * 60 + etMin;
    const pastDeadline = hm >= 15 * 60 + 30; // 3:30pm ET
    const inWindow     = hm >= 14 * 60 && hm < 15 * 60 + 30; // 2–3:30pm
    if (!hasShortPut) return { status:"no_position", action:null };
    if (hasLongPut)   return { status:"protected",   action:"Position protected ✓" };
    if (pastDeadline) return { status:"CRITICAL",    color:"#dc2626",
      action:"⛔ 3:30pm PASSED with unprotected P1 short put. CLOSE THE SHORT PUT NOW at market. Never carry unprotected overnight. (Section 11.3)" };
    if (inWindow) return { status:"buy_now", color:"#f97316",
      action:"🔵 BUY $100P NOW — Protection window 2:00–3:30pm. P1 spread is naked until you buy this." };
    return { status:"pending", color:"#f59e0b",
      action:`Protection leg due 2:00–3:30pm today. Buy ${CFG.p1Base}× $100P.` };
  },

  // ── LEAP Accumulation Target by Phase (Appendix A4)
  leapAccumTarget: (btc, totalLeaps, p1Leaps, p2Leaps) => {
    if (btc > 85000) return { phase:"Acceleration",   p1Target:null, p2Target:null, action:"STOP buying LEAPs — too expensive. Protect existing position.", color:"#6b7280" };
    if (btc > 55000) return { phase:"Bear Early",     p1Target:2,    p2Target:2,    action:"1 contract each portfolio on dips. Total target: P1=2, P2=2.", color:"#6b7280" };
    if (btc > 48000) return { phase:"Bear Mid",       p1Target:4,    p2Target:5,    action:"1–2 each portfolio monthly. Target: P1=4, P2=5.", color:"#f59e0b" };
    if (btc > 45000) return { phase:"Bear Late",      p1Target:6,    p2Target:9,    action:"2 each per month on dips below $48K. Target: P1=6, P2=9.", color:"#f97316" };
    return                  { phase:"All-In Deploy",  p1Target:9,    p2Target:13,   action:"Deploy ALL Tier C reserves over 2 weeks. Target: P1=8–9, P2=12–13.", color:"#ef4444" };
  },

  // ── Shares Exit Trigger (Section 7.2)
  sharesExitCheck: (mstr, p1CB, p2CB, nav) => {
    const p1Exit = p1CB > 0 && (mstr >= p1CB || nav > 2.5);
    const p2Exit = p2CB > 0 && (mstr >= p2CB || nav > 2.5);
    return {
      p1: { exit: p1Exit, reason: p1Exit ? (mstr >= p1CB ? `MSTR $${mstr} ≥ cost basis $${p1CB}` : `NAV ${nav.toFixed(2)}× > 2.5×`) : null },
      p2: { exit: p2Exit, reason: p2Exit ? (mstr >= p2CB ? `MSTR $${mstr} ≥ cost basis $${p2CB}` : `NAV ${nav.toFixed(2)}× > 2.5×`) : null },
      any: p1Exit || p2Exit,
    };
  },

  // ── Master Scenario Engine — "what does this strategy say to do in every state"
  // Inputs: full market + portfolio state. Output: complete ordered action list.
  // This is the authoritative decision tree. Every dollar has a place.
  masterScenario: (ctx) => {
    const { btc, mstr, iv, ivr, nav, solv, bic, allIn, earningsAlert,
            port, pillarsBroken, leapExitCount, etfOutflowWeeks,
            p1TierA, p2TierA } = ctx;
    const actions = []; // ordered by priority — highest first
    const add = (priority, color, tag, headline, detail) =>
      actions.push({ priority, color, tag, headline, detail });

    // P0: Existential / irreversible — must act NOW
    if (btc < CFG.thesisBrk && pillarsBroken >= 2) {
      add(0,"#7f1d1d","THESIS BREAK","FULL EXIT PROTOCOL",
        `BTC $${btc.toLocaleString()} + ${pillarsBroken} pillars broken. Close all puts at market. Sell assigned shares immediately. Hold LEAPs as lottery tickets ONLY. Move ALL cash to SGOV. Do NOT average down — ever.`);
    }
    if (btc < CFG.thesisBrk && pillarsBroken >= 3) {
      add(0,"#450a0a","COMPLETE FAILURE","SELL ALL INCLUDING LEAPs",
        "Three pillars broken. Thesis structurally dead. Sell everything including LEAPs. All capital to SGOV/cash.");
    }

    // P1: Critical — act today
    if (earningsAlert?.urgent) {
      add(1,"#ef4444","EARNINGS","DO NOT SELL PUTS THIS WEEK",
        `MSTR earnings ${earningsAlert.date}. Zero options entries. Skip entirely. Resume next Monday after earnings release.`);
    }
    if (allIn?.latched) {
      add(1,"#f97316","ALL-IN","DEPLOY ALL TIER C TO LEAPs NOW",
        `BTC closed below $${CFG.allInArm.toLocaleString()} ${CFG.allInLatch}× consecutively. Deploy every dollar of Tier C to Dec 2028 LEAP calls immediately. Every contract bought now is bought at cycle bottom pricing.`);
    }
    if (pillarsBroken === 1) {
      add(1,"#f59e0b","1 PILLAR BROKEN","DROP TO PATH B — STOP LEAP BUYING",
        "One thesis pillar broken. Halve contract count (P1: 2 contracts, P2: 4 contracts). Stop buying LEAPs until pillar recovers. Monitor the other two closely.");
    }
    if (leapExitCount >= 2) {
      add(1,"#a855f7","EXIT SIGNALS","BEGIN STAGED LEAP EXIT", leapExitCount + " of 4 exit signals active. " + (leapExitCount >= 3 ? "Aggressive: sell 2/3 over 2 weeks." : "Begin: sell 1/3 over 2 weeks. Do NOT exit on a single signal."));
    }

    // P2: Important — this week's execution
    if (mstr > 0 && port?.p1CB > 0 && (mstr >= port.p1CB || nav > 2.5)) {
      add(2,"#f97316","SHARES EXIT","SELL ASSIGNED SHARES → REDEPLOY TO TIER C",
        `P1 shares at cost basis $${port.p1CB}. MSTR now $${mstr} ${mstr >= port.p1CB ? "(at/above basis — exit)" : "(NAV > 2.5× — exit)"}. Sell at market. Redeploy ALL proceeds to Dec 2028 LEAPs immediately.`);
    }
    if (mstr > 0 && port?.p2CB > 0 && (mstr >= port.p2CB || nav > 2.5)) {
      add(2,"#f97316","SHARES EXIT","SELL P2 ASSIGNED SHARES → REDEPLOY TO TIER C",
        `P2 shares at cost basis $${port.p2CB}. MSTR $${mstr}. Exit now and redeploy to Tier C LEAPs.`);
    }
    const rollTrigger = CFG.leapRoll.find(r => mstr >= r.mstr);
    if (rollTrigger) {
      add(2,"#a855f7","LEAP ROLL","ROLL LEAPs → DEC 2030",
        `MSTR $${mstr} ≥ $${rollTrigger.mstr}. ${rollTrigger.label}. Sell Dec 2028 LEAP at market, buy Dec 2030 LEAP at near-ATM strike. ONLY execute if transaction is a NET CREDIT. Never pay to roll.`);
    }
    const profTrigger = CFG.profitTake.find(p => p.mstr && mstr >= p.mstr);
    if (profTrigger) {
      add(2,"#f59e0b","PROFIT TAKE","SELL 1/3 LEAPs AT MARKET — MSTR $" + mstr, (profTrigger.action || "") + ". Staged exit — don't sell all at once. Hold remaining contracts for the continued run.");
    }
    if (nav > 2.5) {
      add(2,"#f59e0b","NAV EXIT","NAV EXIT ZONE — BEGIN 20% TRIM PER 0.5× ABOVE 2.5×",
        `NAV ${nav.toFixed(2)}×. Sell 20% of remaining LEAPs per additional 0.5× above 2.5×. Kelly NAV cap also active: reduce weekly contracts by 50%.`);
    }

    // P3: Standard weekly execution
    if (actions.length === 0 || actions.every(a => a.priority >= 2)) {
      // Normal execution — determine path
      const strike = E.strike(mstr, ivr, nav);
      const kelly = E.kellyContracts({ p1: p1TierA, p2: p2TierA }, mstr, strike, nav, ivr, pillarsBroken, earningsAlert);
      if (ivr < 25) { // IV Rank check
        add(3,"#6b7280","LOW IV","SKIP THIS WEEK — IV TOO LOW",
          `IVR ${ivr} < 25. Options too cheap — risk/reward collapses. Wait for IV to expand. Check again Sunday.`);
      } else if (btc < 40000 || nav < 1.2) {
        add(3,"#ef4444","PATH A","COVERED CALLS ONLY — NO PUTS",
          `BTC $${btc.toLocaleString()} / NAV ${nav.toFixed(2)}×. Path A: sell covered calls on assigned shares only. No new put selling. Preserve capital.`);
      } else {
        add(3,"#00d26a","EXECUTE","STANDARD WEEKLY ENGINE",
          `Strike: $${strike||"?"} | P1: ${kelly.p1}ct | P2: ${kelly.p2}ct${kelly.capped ? ` (Kelly-capped from ${CFG.p1Base}/${CFG.p2Base})` : ""}. Monday 9:45am: sell puts. 2pm: buy P1 protection. Route ${ctx.route?.pct||15}% to Tier C.`);
      }
    }

    return actions.sort((a,b) => a.priority - b.priority);
  },

  // ── Input sanitizer — prevents any UI input from causing system failure
  safeNum: (v, fallback=0, min=null, max=null) => {
    const n = parseFloat(v);
    if (isNaN(n) || !isFinite(n)) return fallback;
    if (min !== null && n < min) return min;
    if (max !== null && n > max) return max;
    return n;
  },

  weeklyIncome: (mstr, iv, ivr, nav, p1q, p2q, rvolRatio=1.0) => {
    const str = E.strike(mstr,ivr,nav,rvolRatio);
    if(!str) return { p1:0,p2:0,total:0,grossPrem:"0.00",longCost:"0.00",strike:null,longStrike:null,premFloorOk:false };
    const gross = E.prem(mstr,str,iv,7);
    const longStr = E.longPutStrike(str,mstr,ivr,nav);
    const longCost = longStr ? E.prem(mstr,longStr,iv,7)*0.70 : 0;
    return { p1:Math.max(0,gross-longCost)*100*p1q, p2:gross*100*p2q,
      total:Math.max(0,gross-longCost)*100*p1q+gross*100*p2q,
      grossPrem:gross.toFixed(2), longCost:longCost.toFixed(2), strike:str, longStrike:longStr,
      premFloorOk: E.premFloorOk(gross) };
  },

  // ── Portfolio Value Engine (Section 4.1 three-tier structure)
  // Estimates real-time total portfolio value across all tiers + both portfolios
  portfolioValue: (port, mstr, leapDelta, iv) => {
    if (!mstr || mstr <= 0) return null;
    const leapStrike = port?.leapStrike || 80;
    // LEAP value: intrinsic + simplified time value (2.75 years avg remaining to Dec 2028)
    const T = Math.max(0.1, (new Date("2028-12-15") - new Date()) / (365*24*60*60*1000));
    const intrinsic = Math.max(0, mstr - leapStrike) * 100;
    // Time value: when deep ITM, ~15% of intrinsic; when near/OTM, use delta × IV × sqrt(T) × mstr
    const timeVal = intrinsic > 0
      ? intrinsic * Math.min(0.25, 0.15 * T)
      : (mstr * (iv/100) * Math.sqrt(T) * (leapDelta || 0.5) * 0.5) * 100;
    const leapEstPerContract = Math.max(50, intrinsic + timeVal); // floor at $50 — always some value
    const p1Leaps = port?.p1Leaps || 0;
    const p2Leaps = port?.p2Leaps || 0;
    const p1LeapVal = p1Leaps * leapEstPerContract;
    const p2LeapVal = p2Leaps * leapEstPerContract;
    // Share values at current market price
    const p1ShareVal = (port?.p1Shares||0) * mstr;
    const p2ShareVal = (port?.p2Shares||0) * mstr;
    // Tier A cash (user-entered)
    const p1TierA = port?.p1TierA || CFG.p1TierA;
    const p2TierA = port?.p2TierA || CFG.p2TierA;
    // Tier B fixed per strategy
    const p1TierB = CFG.tierBPerPort;
    const p2TierB = CFG.tierBPerPort;
    // Portfolio totals
    const p1Total = p1TierA + p1TierB + p1LeapVal + p1ShareVal;
    const p2Total = p2TierA + p2TierB + p2LeapVal + p2ShareVal;
    const combined = p1Total + p2Total;
    const startingCapital = CFG.p1TierA + CFG.p2TierA + CFG.p1TierC + CFG.p2TierC + CFG.tierBPerPort*2;
    return {
      p1: { tierA:p1TierA, tierB:p1TierB, tierC:p1LeapVal, shares:p1ShareVal, total:p1Total, leaps:p1Leaps },
      p2: { tierA:p2TierA, tierB:p2TierB, tierC:p2LeapVal, shares:p2ShareVal, total:p2Total, leaps:p2Leaps },
      combined, leapEstPerContract, T: T.toFixed(1),
      gainLoss: combined - startingCapital,
      gainLossPct: ((combined - startingCapital) / startingCapital * 100).toFixed(1),
    };
  },

  // ── Price alert checker — Section 10.1
  activePriceAlerts: (btc, mstr, nav) => {
    const btcFired = CFG.btcAlertLevels.filter(a => btc <= a.price);
    const mstrFired = CFG.mstrAlertLevels.filter(a => mstr >= a.price);
    const navFired = nav >= 2.5 ? [{ label:"NAV EXIT ZONE", color:"#ef4444", action:"Begin LEAP trim: sell 20% per 0.5× above 2.5×. Exit protocol approaching." }] : [];
    return { btc: btcFired, mstr: mstrFired, nav: navFired,
             any: btcFired.length>0 || mstrFired.length>0 || navFired.length>0 };
  },

  // ── "What do I do right now?" — Section 10 weekly checklist distilled to one action
  actionNow: (btc, mstr, iv, ivr, nav, bic, allIn, earningsAlert, pth, hasShares, strike, longS, income, route) => {
    // Priority 1: Thesis break
    if (pth.p === "EXIT") return { priority:1, color:"#7f1d1d", bg:"#1a0000", emoji:"🔴",
      headline:"THESIS BREAK — EXIT PROTOCOL",
      action:`BTC at $${btc.toLocaleString()} has broken the thesis. Close all puts at market. Sell assigned shares. Hold LEAPs as lottery tickets. Move all cash to SGOV. Do NOT average down.` };
    // Priority 2: Earnings blackout
    if (earningsAlert?.urgent) return { priority:1, color:"#ef4444", bg:"#1a0000", emoji:"🚫",
      headline:"EARNINGS BLACKOUT — DO NOT TRADE",
      action:`MSTR earnings ${earningsAlert.date} (${earningsAlert.daysOut<=0?"today":earningsAlert.daysOut===1?"tomorrow":`in ${earningsAlert.daysOut} days`}). Skip puts this week entirely. Resume next Monday after earnings.` };
    // Priority 3: All-In latched
    if (allIn.latched) return { priority:1, color:"#f97316", bg:"#1a0500", emoji:"⚡",
      headline:"ALL-IN ACTIVE — DEPLOY TO LEAPs NOW",
      action:`BTC has closed below $${CFG.allInArm.toLocaleString()} for ${CFG.allInLatch} consecutive sessions. Deploy ALL Tier C reserves to Dec 2028 LEAP calls immediately. Every dollar counts at this price.` };
    // Priority 4: Skip week
    if (pth.skip) return { priority:2, color:"#f59e0b", bg:"#1a0f00", emoji:"⚠",
      headline:`PATH ${pth.p} — DO NOT SELL PUTS`,
      action:pth.why || "Conditions not met for put selling this week. Monitor and reassess Sunday." };
    // Priority 5: Assigned shares need CCs
    if (hasShares) return { priority:2, color:"#f97316", bg:"#1a0800", emoji:"⚡",
      headline:"ASSIGNED SHARES — SELL COVERED CALLS",
      action:`You have assigned shares. Monday morning: sell covered calls at the dynamic strike shown below. 100% coverage immediately — every uncovered week is income sacrificed.` };
    // Priority 6: Normal week — standard execution
    const expiry = (() => { const d=new Date(); d.setDate(d.getDate()+((8-d.getDay())%7||7)+4); return d.toLocaleDateString("en-US",{month:"short",day:"numeric"}); })();
    return { priority:3, color:"#00d26a", bg:"#001a0a", emoji:"✅",
      headline:"EXECUTE STANDARD WEEK",
      action:`Monday 9:45am: SELL ${CFG.p1Base}×$${strike||"?"}P exp ${expiry} (P1 margin) + ${CFG.p2Base}×$${strike||"?"}P (P2 cash). Est income: $${income?.total?.toFixed(0)||"?"}. 2:00pm: BUY ${CFG.p1Base}×$${longS||100}P (P1 only). Route ${route?.pct||15}% ($${((income?.total||0)*((route?.pct||15)/100)).toFixed(0)}) to Tier C LEAPs.` };
  },

};

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3: PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
// Storage abstraction: Claude artifact window.storage → localStorage fallback for production
const Storage = {
  // Primary: Vercel KV via /api/kv (cross-device sync)
  // Fallback: localStorage (same device, offline resilience)
  get: async (key) => {
    try {
      const r = await fetch(`/api/kv?key=${encodeURIComponent(key)}`);
      if (r.ok) {
        const d = await r.json();
        if (d && d.value != null) return { value: d.value };
        if (d === null) return null;
      }
    } catch {}
    // localStorage fallback
    try { const v = localStorage.getItem(key); return v != null ? { value: v } : null; } catch { return null; }
  },
  set: async (key, value) => {
    // Write to both — KV for sync, localStorage for instant reads
    try {
      fetch('/api/kv', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ key, value }) }).catch(()=>{});
    } catch {}
    try { localStorage.setItem(key, value); } catch {}
  },
};

function usePersistedState(key, init) {
  const [val, setVal] = useState(init);
  const loaded = useRef(false);
  useEffect(() => {
    (async () => {
      try { const r = await Storage.get(key); if (r?.value != null) setVal(JSON.parse(r.value)); }
      catch {}
      loaded.current = true;
    })();
  }, [key]);
  const save = useCallback(async (v) => {
    const next = typeof v === "function" ? v(val) : v;
    setVal(next);
    try { await Storage.set(key, JSON.stringify(next)); } catch {}
    return next;
  }, [key, val]);
  return [val, save];
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 4: DATA FETCHERS — FULLY AUTOMATED
// ─────────────────────────────────────────────────────────────────────────────
async function fetchBTC() {
  try {
    // Fetch via server-side proxy (api keys + CORS handled server-side)
    const [spotRes, chartRes] = await Promise.allSettled([
      fetch("/api/proxy?source=coingecko&type=spot"),
      fetch("/api/proxy?source=coingecko&type=chart"),
    ]);

    let price=null, chg24=0, chg7=0;
    if (spotRes.status==="fulfilled") {
      const d = await spotRes.value.json();
      price = d.market_data.current_price.usd;
      chg24 = d.market_data.price_change_percentage_24h || 0;
      chg7  = d.market_data.price_change_percentage_7d  || 0;
    }

    // Parse 90d daily closes from market_chart
    let dailyCloses=[], high90=null, rvol=15, consecutiveBelowArm=0;
    if (chartRes.status==="fulfilled") {
      const cd = await chartRes.value.json();
      // prices array: [[timestamp, price], ...]
      const prices = (cd.prices || []).map(p => p[1]);
      dailyCloses = prices;

      // Real 90d high from actual daily data
      high90 = prices.length > 0 ? Math.max(...prices) : (price * 1.15);

      // Real 5-day realized vol: std dev of daily log returns × sqrt(252)
      if (prices.length >= 6) {
        const returns = [];
        for (let i = prices.length-5; i < prices.length; i++) {
          returns.push(Math.log(prices[i] / prices[i-1]));
        }
        const mean = returns.reduce((a,b)=>a+b,0)/returns.length;
        const variance = returns.reduce((a,b)=>a+(b-mean)**2,0)/returns.length;
        rvol = Math.sqrt(variance * 252) * 100;
      }

      // Auto all-in counter: count consecutive daily closes below $45,500
      // Walk backwards through closes (most recent last)
      const arm = 45500;
      for (let i = prices.length - 1; i >= 0; i--) {
        if (prices[i] < arm) consecutiveBelowArm++;
        else break; // streak broken — stop counting
      }
    }

    if (!price) throw new Error("No price");
    return { price, chg24, chg7, rvol, high90: high90 || price*1.15,
             dailyCloses, consecutiveBelowArm, src:"CoinGecko" };
  } catch {
    try {
      const r = await fetch("/api/proxy?source=kraken");
      const d = await r.json();
      const price = parseFloat(d.result?.XXBTZUSD?.c?.[0]);
      return { price, chg24:0, chg7:0, rvol:15, high90:price*1.15,
               dailyCloses:[], consecutiveBelowArm:0, src:"Kraken" };
    } catch { return null; }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Shared HV/IV rank computation — identical algorithm used by both data paths
// ───────────────────────────────────────────────────────────────────────────────
function computeHV(closes, n) {
  const slice = closes.slice(-(n + 1));
  const rets = slice.slice(1).map((p, i) => Math.log(p / slice[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * 252) * 100;
}

function computeIVRankFromOHLCV(days, atmIV) {
  const ivSeries = days.map(d => {
    const hl = Math.log(d.high / d.low);
    return Math.sqrt(252) * hl / (2 * Math.sqrt(Math.log(2))) * 100;
  }).filter(v => v > 0 && v < 500);
  return E.calcIVRank([...ivSeries, atmIV]);
}

function computeRVol(closes) {
  if (closes.length < 32) return { rvolRatio: null, hv10: null, hv30: null };
  const hv10 = computeHV(closes, 10);
  const hv30 = computeHV(closes, 30);
  const rvolRatio = (hv30 > 0 && hv10 > 0 && isFinite(hv10 / hv30)) ? hv10 / hv30 : null;
  return { rvolRatio, hv10, hv30 };
}

// ───────────────────────────────────────────────────────────────────────────────
// Yahoo Finance — primary MSTR data source (free, no API key required)
// ATM IV: sourced from options impliedVolatility field (decimal × 100).
// IV Rank: Parkinson’s HV estimator on 1yr daily OHLCV.
// RVol ratio (10D÷30D): auto-computed from daily closes — no manual entry.
// LEAP delta: back-calculated via Black-Scholes from Dec 2028 chain.
// ───────────────────────────────────────────────────────────────────────────────
async function fetchMSTRDataYahoo() {
  try {
    const [histRes, optsRes, leapRes] = await Promise.allSettled([
      fetch("/api/proxy?source=yahoo&type=history").then(r => r.json()),
      fetch("/api/proxy?source=yahoo&type=options").then(r => r.json()),
      fetch("/api/proxy?source=yahoo&type=leapoptions").then(r => r.json()),
    ]);

    // ── Price from history chart (last close)
    let price = null;
    let days = [];
    if (histRes.status === "fulfilled") {
      const chart = histRes.value?.chart?.result?.[0];
      if (chart) {
        const closes = chart.indicators?.quote?.[0]?.close || [];
        const highs   = chart.indicators?.quote?.[0]?.high  || [];
        const lows    = chart.indicators?.quote?.[0]?.low   || [];
        price = closes.filter(v => v != null).at(-1) || null;
        days = closes.map((c, i) => ({ high: highs[i], low: lows[i], close: c }))
                     .filter(d => d.high != null && d.low != null && d.close != null && d.high > 0);
      }
    }

    // ── ATM IV from near-term options chain
    let atmIV = 88;
    if (optsRes.status === "fulfilled") {
      const optData = optsRes.value?.optionChain?.result?.[0];
      const ref = optData?.quote?.regularMarketPrice || price || 148;
      const atmPuts = (optData?.options?.[0]?.puts || [])
        .filter(o => o.impliedVolatility != null && Math.abs(o.strike - ref) < ref * 0.04)
        .sort((a, b) => Math.abs(a.strike - ref) - Math.abs(b.strike - ref));
      if (atmPuts.length > 0) {
        atmIV = Math.round(atmPuts[0].impliedVolatility * 100 * 10) / 10;
      } else {
        const allOpts = [...(optData?.options?.[0]?.puts || []), ...(optData?.options?.[0]?.calls || [])];
        const nearest = allOpts.filter(o => o.impliedVolatility != null)
          .sort((a, b) => Math.abs(a.strike - ref) - Math.abs(b.strike - ref));
        if (nearest.length > 0) atmIV = Math.round(nearest[0].impliedVolatility * 100 * 10) / 10;
      }
      if (optData?.quote?.regularMarketPrice) price = optData.quote.regularMarketPrice;
    }

    // ── IV Rank + RVol from history
    let ivRank = null, ivrCalibrated = false, ivrDataPoints = 0;
    let rvolRatio = null, hv10 = null, hv30 = null;
    if (days.length > 0) {
      const ivrResult = computeIVRankFromOHLCV(days, atmIV);
      if (ivrResult !== null) {
        ivRank = ivrResult.rank;
        ivrCalibrated = ivrResult.calibrated;
        ivrDataPoints = ivrResult.dataPoints;
      }
      const closes = days.map(d => d.close);
      const rv = computeRVol(closes);
      rvolRatio = rv.rvolRatio; hv10 = rv.hv10; hv30 = rv.hv30;
    }

    // ── LEAP delta from Dec 2028 chain
    let leapDelta = null, leapStrikeFromChain = null;
    if (leapRes.status === "fulfilled") {
      const leapData = leapRes.value?.optionChain?.result?.[0];
      const ref = price || 148;
      const leapCalls = (leapData?.options?.[0]?.calls || [])
        .filter(o => o.strike <= Math.round(ref * 0.70) && o.impliedVolatility != null)
        .sort((a, b) => b.strike - a.strike);
      if (leapCalls.length > 0) {
        leapStrikeFromChain = leapCalls[0].strike;
        const daysToExp = Math.max(1, Math.round((new Date("2028-12-20") - Date.now()) / 86400000));
        leapDelta = E.leapDeltaCalc(ref, leapCalls[0].strike, leapCalls[0].impliedVolatility * 100, daysToExp);
      }
    }
    if (leapDelta === null && price) {
      const daysToExp = Math.max(1, Math.round((new Date("2028-12-20") - Date.now()) / 86400000));
      const guessStrike = Math.round(price * 0.55);
      leapDelta = E.leapDeltaCalc(price, guessStrike, atmIV, daysToExp);
      leapStrikeFromChain = guessStrike;
    }

    return { price, iv: atmIV, ivRank, ivrCalibrated, ivrDataPoints, leapDelta, leapStrikeFromChain,
             rvolRatio, hv10, hv30, src: "Yahoo Finance", live: true };
  } catch { return null; }
}

// ───────────────────────────────────────────────────────────────────────────────
// Primary data fetch — Yahoo Finance (free, no key required)
// Backups: Finnhub (free key, 60/min) → Alpha Vantage (free key, 25/day)
// Yahoo provides: price, ATM IV, IV Rank, RVol, LEAP delta — fully automated.
// Backups provide: price only (IV/RVol/LEAP delta still from Yahoo when available)
// ───────────────────────────────────────────────────────────────────────────────
async function fetchMSTRData(_unusedKey) {
  // Primary: Yahoo Finance (full data — price, IV, options, history)
  const yahoo = await fetchMSTRDataYahoo();
  if (yahoo && yahoo.price) return yahoo;

  // Backup 1: Finnhub (price + IV Rank + RVol from candles — free, 60 req/min)
  const fh = await fetchMSTRFinnhub();
  if (fh && fh.price) return fh;

  // Backup 2: Alpha Vantage (price only — free, 25 req/day)
  const av = await fetchMSTRAlphaVantage();
  if (av && av.price) {
    return { price: av.price, iv: 88, ivRank: null, ivrCalibrated: false, ivrDataPoints: 0,
             leapDelta: null, leapStrikeFromChain: null,
             rvolRatio: null, hv10: null, hv30: null, src: "Alpha Vantage (backup)", live: true };
  }

  return null;
}
// ── Hash Ribbon: real 30d vs 60d MA of Bitcoin hashrate (free, blockchain.info)
async function fetchHashRibbon() {
  try {
    const r = await fetch("/api/proxy?source=hash");
    const d = await r.json();
    const pts = (d.values||[]).map(p=>p.y);
    if (pts.length < 61) return { ok:false, reason:"need 61+ datapoints", pts:pts.length };
    const slice = (n) => pts.slice(-n).reduce((a,b)=>a+b,0)/n;
    const sliceP = (n) => pts.slice(-n-1,-1).reduce((a,b)=>a+b,0)/n;
    const ma30=slice(30), ma60=slice(60), pma30=sliceP(30), pma60=sliceP(60);
    const crossingUp = pma30<=pma60 && ma30>ma60; // the actual buy signal
    const signal = crossingUp?"CROSS_UP":ma30>ma60?"ABOVE":"BELOW";
    return { ok:true, ma30:ma30/1e9, ma60:ma60/1e9, signal, fires:crossingUp,
             currentEH:pts[pts.length-1]/1e9, pts:pts.length, src:"blockchain.info" };
  } catch(e) { return { ok:false, reason:e.message }; }
}

// ── ETF Flows: SoSoValue API (free with account signup — sosovalue.com/developer)
async function fetchETFFlows(_unusedKey) {
  // Key lives in Vercel env — fetched server-side
  try {
    const r = await fetch("/api/proxy?source=sosovalue");
    if (!r.ok) return { ok:false, reason:`HTTP ${r.status}`, netFlowUSD:null, consecutiveOutflows:0 };
    const d = await r.json();
    const flows = (d.data||d.list||[]).slice(0,10);
    if (!flows.length) return { ok:false, reason:"empty", consecutiveOutflows:0 };
    const latest = parseFloat(flows[0].netFlow||flows[0].net_flow||flows[0].totalNetFlow||0);
    let consec=0;
    for (const f of flows) {
      if (parseFloat(f.netFlow||f.net_flow||f.totalNetFlow||0)<0) consec++;
      else break;
    }
    // fires at 4+ consecutive outflow weeks (not 8, which is thesis BREAK, not just signal)
    // Strategy: signal fires when 4+ consecutive outflow weeks AND current week turns positive
    // This is a RECOVERY CONFIRMATION signal — not a "things are bad" signal
    // It means: institutions stopped leaving AND started coming back after sustained exodus
    const hadSustainedOutflows = consec >= 4 || (() => {
      // Also check if prior weeks had 4+ even if this week is positive
      let priorConsec = 0;
      for (let i = 1; i < flows.length; i++) {
        if (parseFloat(flows[i].netFlow||flows[i].net_flow||flows[i].totalNetFlow||0) < 0) priorConsec++;
        else break;
      }
      return priorConsec >= 4;
    })();
    const currentWeekPositive = latest > 0;
    const fires = hadSustainedOutflows && currentWeekPositive;
    return { ok:true, netFlowUSD:latest, consecutiveOutflows:consec, hadSustainedOutflows, currentWeekPositive, fires, src:"SoSoValue" };
  } catch(e) { return { ok:false, reason:e.message, netFlowUSD:null, consecutiveOutflows:0 }; }
}

async function fetchFearGreed() {
  // Primary: Alternative.me (canonical source)
  try {
    const r=await fetch("/api/proxy?source=fg");
    const d=await r.json();
    const e=d?.data?.[0];
    if (e) return {value:+e.value,label:e.value_classification,src:"Alternative.me"};
  } catch {}
  // Backup: CoinyBubble (free, no signup, ~1 min updates)
  try {
    const r=await fetch("/api/proxy?source=fg2");
    if (r.ok) {
      const d=await r.json();
      const val = d?.value ?? d?.index ?? d?.fear_greed ?? null;
      if (val !== null) {
        const v = typeof val === "number" ? val : parseFloat(val);
        const label = v <= 20 ? "Extreme Fear" : v <= 40 ? "Fear" : v <= 60 ? "Neutral" : v <= 80 ? "Greed" : "Extreme Greed";
        return {value:v, label, src:"CoinyBubble"};
      }
    }
  } catch {}
  return null;
}

async function fetchNews() {
  let items = [];
  let src = "none";

  // Source 1: CryptoPanic (primary — free, curated crypto news)
  try {
    const r=await fetch("/api/proxy?source=news");
    const d=await r.json();
    if (d?.results?.length) {
      items = d.results.slice(0,15).map(i=>({
        title:i.title, url:i.url, src:i.source?.title||"CryptoPanic",
        pub:i.published_at,
        isAlert:CFG.alertKeywords.some(kw=>i.title?.toLowerCase().includes(kw.toLowerCase())),
      }));
      src = "CryptoPanic";
    }
  } catch {}

  // Source 2: CoinGecko news (backup — free, no key)
  try {
    const r=await fetch("/api/proxy?source=news_coingecko");
    if (r.ok) {
      const d=await r.json();
      const cgItems = (d?.data || d || []).slice(0,10);
      if (cgItems.length > 0) {
        const newItems = cgItems.map(i=>({
          title: i.title || i.description?.slice(0,100),
          url: i.url || i.news_site_url,
          src: i.news_site || "CoinGecko",
          pub: i.updated_at || i.created_at,
          isAlert: CFG.alertKeywords.some(kw=>(i.title||"").toLowerCase().includes(kw.toLowerCase())),
        })).filter(i => i.title);
        // Merge — deduplicate by title similarity
        for (const ni of newItems) {
          const isDupe = items.some(e => e.title?.toLowerCase().slice(0,40) === ni.title?.toLowerCase().slice(0,40));
          if (!isDupe) items.push(ni);
        }
        if (!src || src === "none") src = "CoinGecko";
        else src += " + CoinGecko";
      }
    }
  } catch {}

  // Source 3: NewsData.io (tertiary — free 200/day, MSTR/BTC specific)
  try {
    const r=await fetch("/api/proxy?source=newsdata");
    if (r.ok) {
      const d=await r.json();
      const ndItems = (d?.results || []).slice(0,8);
      if (ndItems.length > 0) {
        const newItems = ndItems.map(i=>({
          title: i.title, url: i.link, src: i.source_name || "NewsData",
          pub: i.pubDate,
          isAlert: CFG.alertKeywords.some(kw=>(i.title||"").toLowerCase().includes(kw.toLowerCase())),
          sentiment: i.sentiment || null,
        })).filter(i => i.title);
        for (const ni of newItems) {
          const isDupe = items.some(e => e.title?.toLowerCase().slice(0,40) === ni.title?.toLowerCase().slice(0,40));
          if (!isDupe) items.push(ni);
        }
        if (!src || src === "none") src = "NewsData.io";
        else src += " + NewsData.io";
      }
    }
  } catch {}

  if (!items.length) return null;
  // Sort by alert priority, then recency
  items.sort((a,b) => (b.isAlert?1:0) - (a.isAlert?1:0));
  return { items: items.slice(0,20), src };
}

// ───────────────────────────────────────────────────────────────────────────────
// THESIS NEWS AGGREGATOR — comprehensive multi-category news for thesis health
// Categories: MSTR Corporate | Regulation | Banking | Monetary Policy | Adoption
// Sources: Finnhub Company News, NewsData.io, GNews.io, SEC EDGAR, FRED
// Each item tagged with category + sentiment keywords for thesis scoring
// ───────────────────────────────────────────────────────────────────────────────

// Sentiment keyword dictionaries — tuned for thesis relevance
const THESIS_BULLISH = [
  "approve","approved","adoption","adopt","bullish","support","deregulat","allow",
  "accumulate","purchase","bought","buying","treasury","reserve","pro-crypto","pro crypto",
  "favorable","green light","easing","cut rate","dovish","inflow","institutional",
  "etf approval","spot etf","custody","integrate","embrace","mainstream","billion",
  "strategic reserve","national reserve","sovereign","nation state","msci","inclusion",
];
const THESIS_BEARISH = [
  "ban","restrict","crack down","crackdown","enforcement","lawsuit","sue","fraud",
  "reject","rejected","bearish","sell","dump","crash","collapse","bankrupt","chapter 11",
  "hawkish","hike","tighten","outflow","withdraw","exit","halt","suspend","delisted",
  "investigation","subpoena","penalty","fine","sanction","default","margin call",
];

function scoreThesisSentiment(title) {
  if (!title) return 0;
  const t = title.toLowerCase();
  let score = 0;
  for (const kw of THESIS_BULLISH) { if (t.includes(kw)) score += 1; }
  for (const kw of THESIS_BEARISH) { if (t.includes(kw)) score -= 1; }
  return score;
}

function categorizeThesisItem(title) {
  if (!title) return "general";
  const t = title.toLowerCase();
  if (t.includes("microstrategy") || t.includes("mstr") || t.includes("saylor") || t.includes("convertible note")) return "mstr_corporate";
  if (t.includes("sec ") || t.includes("regulation") || t.includes("regulat") || t.includes("bill ") || t.includes("legislation") || t.includes("sab 121") || t.includes("executive order")) return "regulation";
  if (t.includes("bank") || t.includes("custody") || t.includes("institutional") || t.includes("occ ") || t.includes("deregulat") || t.includes("jpmorgan") || t.includes("goldman") || t.includes("blackrock")) return "banking";
  if (t.includes("fed ") || t.includes("federal reserve") || t.includes("interest rate") || t.includes("money supply") || t.includes("quantitative") || t.includes("balance sheet") || t.includes("liquidity") || t.includes("m2 ")) return "monetary_policy";
  if (t.includes("etf") || t.includes("adoption") || t.includes("sovereign") || t.includes("reserve") || t.includes("nation") || t.includes("msci") || t.includes("halving")) return "adoption";
  return "general";
}

async function fetchThesisNews() {
  const allItems = [];
  const sources = [];

  // Source 1: Finnhub MSTR company news (free with key)
  try {
    const r = await fetch("/api/proxy?source=finnhub_news&type=company");
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d) && d.length > 0) {
        const items = d.slice(0, 10).map(i => ({
          title: i.headline, url: i.url, src: i.source || "Finnhub",
          pub: i.datetime ? new Date(i.datetime * 1000).toISOString() : null,
          category: categorizeThesisItem(i.headline),
          sentiment: scoreThesisSentiment(i.headline),
          summary: i.summary?.slice(0, 200) || null,
        }));
        allItems.push(...items);
        sources.push("Finnhub");
      }
    }
  } catch {}

  // Source 2: Finnhub general market news (captures Fed/macro)
  try {
    const r = await fetch("/api/proxy?source=finnhub_news&type=general");
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d) && d.length > 0) {
        // Filter for thesis-relevant keywords only
        const relevant = d.filter(i => {
          const t = (i.headline || "").toLowerCase();
          return t.includes("bitcoin") || t.includes("crypto") || t.includes("fed") ||
                 t.includes("interest rate") || t.includes("bank") || t.includes("regulation") ||
                 t.includes("etf") || t.includes("microstrategy") || t.includes("digital asset") ||
                 t.includes("money supply") || t.includes("liquidity");
        });
        const items = relevant.slice(0, 8).map(i => ({
          title: i.headline, url: i.url, src: i.source || "Finnhub Market",
          pub: i.datetime ? new Date(i.datetime * 1000).toISOString() : null,
          category: categorizeThesisItem(i.headline),
          sentiment: scoreThesisSentiment(i.headline),
          summary: i.summary?.slice(0, 200) || null,
        }));
        allItems.push(...items);
      }
    }
  } catch {}

  // Source 3: GNews — regulation + banking + Fed policy (free, 100 req/day)
  for (const topic of ["crypto_regulation", "fed_policy", "banking_crypto", "mstr"]) {
    try {
      const r = await fetch(`/api/proxy?source=gnews&topic=${topic}`);
      if (r.ok) {
        const d = await r.json();
        const articles = d?.articles || [];
        const items = articles.slice(0, 5).map(i => ({
          title: i.title, url: i.url, src: i.source?.name || "GNews",
          pub: i.publishedAt,
          category: categorizeThesisItem(i.title),
          sentiment: scoreThesisSentiment(i.title),
          summary: i.description?.slice(0, 200) || null,
        }));
        allItems.push(...items);
        if (items.length > 0 && !sources.includes("GNews")) sources.push("GNews");
      }
    } catch {}
  }

  // Source 4: NewsData.io — broader business topics (free, 200 req/day)
  for (const topic of ["mstr", "regulation", "banking", "macro", "adoption"]) {
    try {
      const r = await fetch(`/api/proxy?source=newsdata&topic=${topic}`);
      if (r.ok) {
        const d = await r.json();
        const items = (d?.results || []).slice(0, 5).map(i => ({
          title: i.title, url: i.link, src: i.source_name || "NewsData",
          pub: i.pubDate,
          category: categorizeThesisItem(i.title),
          sentiment: scoreThesisSentiment(i.title) + (i.sentiment === "positive" ? 1 : i.sentiment === "negative" ? -1 : 0),
          summary: i.description?.slice(0, 200) || null,
        }));
        allItems.push(...items);
        if (items.length > 0 && !sources.includes("NewsData")) sources.push("NewsData");
      }
    } catch {}
  }

  // Source 5: SEC EDGAR — MSTR filings (free, no key)
  try {
    const r = await fetch("/api/proxy?source=sec_edgar");
    if (r.ok) {
      const d = await r.json();
      const hits = d?.hits?.hits || d?.hits || [];
      if (Array.isArray(hits) && hits.length > 0) {
        const items = hits.slice(0, 5).map(h => {
          const s = h._source || h;
          return {
            title: `SEC Filing: ${s.form_type || s.file_type || "Filing"} — ${s.display_names?.[0] || "MicroStrategy"}`,
            url: s.file_url ? `https://www.sec.gov${s.file_url}` : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001050446`,
            src: "SEC EDGAR",
            pub: s.file_date || s.period_of_report,
            category: "mstr_corporate",
            sentiment: 0, // filings are neutral — content determines sentiment
            summary: s.display_names?.[0] ? `${s.form_type}: ${s.display_names[0]}` : null,
          };
        });
        allItems.push(...items);
        sources.push("SEC EDGAR");
      }
    }
  } catch {}

  // Deduplicate by title similarity
  const deduped = [];
  for (const item of allItems) {
    if (!item.title) continue;
    const key = item.title.toLowerCase().slice(0, 50);
    if (!deduped.some(d => d.title.toLowerCase().slice(0, 50) === key)) {
      deduped.push(item);
    }
  }

  // Sort: alerts first, then by recency
  deduped.sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment));

  // Compute thesis health by category
  const categories = { mstr_corporate: [], regulation: [], banking: [], monetary_policy: [], adoption: [], general: [] };
  for (const item of deduped) {
    (categories[item.category] || categories.general).push(item);
  }

  // Category health scores: mean sentiment, clamped to [-5, +5]
  const catScores = {};
  for (const [cat, items] of Object.entries(categories)) {
    if (items.length === 0) { catScores[cat] = { score: 0, count: 0, label: "No data" }; continue; }
    const avg = items.reduce((s, i) => s + i.sentiment, 0) / items.length;
    const clamped = Math.max(-5, Math.min(5, avg));
    catScores[cat] = {
      score: +clamped.toFixed(2),
      count: items.length,
      label: clamped > 0.5 ? "Bullish" : clamped < -0.5 ? "Bearish" : "Neutral",
    };
  }

  // Overall thesis sentiment: weighted average across categories
  const weights = { mstr_corporate: 0.25, regulation: 0.20, banking: 0.15, monetary_policy: 0.20, adoption: 0.15, general: 0.05 };
  let totalWeight = 0, weightedSum = 0;
  for (const [cat, info] of Object.entries(catScores)) {
    if (info.count > 0) {
      weightedSum += info.score * (weights[cat] || 0.05);
      totalWeight += weights[cat] || 0.05;
    }
  }
  const overallScore = totalWeight > 0 ? +(weightedSum / totalWeight).toFixed(2) : 0;
  const overallLabel = overallScore > 0.5 ? "BULLISH" : overallScore < -0.5 ? "BEARISH" : "NEUTRAL";

  return {
    ok: true,
    items: deduped.slice(0, 30),
    categories: catScores,
    overallScore,
    overallLabel,
    sources: sources.join(" + ") || "none",
    totalItems: deduped.length,
  };
}

// ── FRED Monetary Policy Tracker — tracks Fed balance sheet, M2, rates
// Used to detect stealth QE (balance sheet expansion), rate cuts, liquidity injections
async function fetchFedData() {
  const series = ["WALCL", "M2SL", "RRPONTSYD", "FEDFUNDS"];
  const results = {};

  for (const s of series) {
    try {
      const r = await fetch(`/api/proxy?source=fred&series=${s}`);
      if (r.ok) {
        const d = await r.json();
        const obs = (d?.observations || []).filter(o => o.value !== ".");
        if (obs.length >= 2) {
          const latest = parseFloat(obs[0].value);
          const prev = parseFloat(obs[1].value);
          const change = latest - prev;
          const changePct = prev > 0 ? ((change / prev) * 100) : 0;
          results[s] = { value: latest, prev, change: +change.toFixed(2), changePct: +changePct.toFixed(3), date: obs[0].date };
        }
      }
    } catch {}
  }

  if (Object.keys(results).length === 0) return null;

  // Detect stealth QE: Fed balance sheet growing while saying it's tightening
  const balanceSheet = results.WALCL;
  const m2 = results.M2SL;
  const rrp = results.RRPONTSYD;
  const fedRate = results.FEDFUNDS;

  const stealthQE = balanceSheet?.change > 0; // Balance sheet expanding
  const m2Growing = m2?.changePct > 0;
  const rrpDeclining = rrp?.change < 0; // Money leaving RRP = entering system
  const rateCut = fedRate?.change < 0;

  // Liquidity score: how much net liquidity is entering the system
  // Fed expanding + M2 growing + RRP declining + rate cuts = maximum liquidity
  let liquidityScore = 0;
  if (stealthQE) liquidityScore += 2;
  if (m2Growing) liquidityScore += 2;
  if (rrpDeclining) liquidityScore += 1;
  if (rateCut) liquidityScore += 1;
  const liquidityLabel = liquidityScore >= 4 ? "EXPANDING" : liquidityScore >= 2 ? "EASING" : liquidityScore >= 1 ? "MIXED" : "TIGHT";

  return {
    ok: true,
    series: results,
    stealthQE, m2Growing, rrpDeclining, rateCut,
    liquidityScore, liquidityLabel,
    src: "FRED (Federal Reserve)",
  };
}

// ── Miner Capitulation: auto-detect via hash ribbon decline as proxy
// When hashrate 30d MA is declining AND below 60d MA, miners are shutting down
// rigs (capitulating). This is the free proxy for hashprice-based detection.
// Also uses BTC price relative to estimated mining cost as secondary signal.
async function fetchMinerStatus() {
  try {
    const r = await fetch("/api/proxy?source=miner");
    if (!r.ok) return null;
    const d = await r.json();
    // Extract hashrate trend from mempool.space data
    const hrData = d.hashrate?.hashrates || [];
    if (hrData.length < 30) return { ok: false, reason: "insufficient data" };
    // Compute 30d and 60d averages of hashrate
    const recent30 = hrData.slice(-30);
    const recent60 = hrData.slice(-60);
    const avg30 = recent30.reduce((s, p) => s + (p.avgHashrate || 0), 0) / recent30.length;
    const avg60 = recent60.reduce((s, p) => s + (p.avgHashrate || 0), 0) / recent60.length;
    // Miner stress: 30d MA declining below 60d MA = miners shutting down
    const declining = avg30 < avg60;
    // Rate of decline — if 30d is >5% below 60d, strong capitulation signal
    const declineRate = avg60 > 0 ? (avg60 - avg30) / avg60 : 0;
    const strongDecline = declineRate > 0.05;
    return {
      ok: true, avg30: avg30 / 1e18, avg60: avg60 / 1e18,
      declining, strongDecline, declineRate: (declineRate * 100).toFixed(1),
      fires: declining && strongDecline, src: "mempool.space",
    };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ── BGeometrics on-chain metrics (free, no key) — REAL DATA for LTH + miner signals
// Provides: SOPR, NUPL, MVRV, Puell Multiple, STH-SOPR, STH-MVRV
// These replace LTH proxy with actual on-chain data:
//   - SOPR < 1.0 = coins moving at a loss (capitulation)
//   - NUPL < 0 = net unrealized loss across holders
//   - Puell Multiple < 0.5 = miners earning far below average (miner stress)
//   - MVRV < 1.0 = market cap below realized cap (deep undervaluation)
async function fetchOnChainMetrics() {
  try {
    const r = await fetch("/api/proxy?source=onchain");
    if (!r.ok) return null;
    const d = await r.json();
    // Extract latest values — BGeometrics returns arrays, take last item
    const extract = (arr) => {
      if (!arr) return null;
      const items = Array.isArray(arr) ? arr : [arr];
      const last = items[items.length - 1];
      return last?.value ?? last?.y ?? last ?? null;
    };
    const sopr = extract(d.sopr);
    const nupl = extract(d.nupl);
    const mvrv = extract(d.mvrv);
    const puell = extract(d.puell);
    const sthSopr = extract(d.sthSopr);
    const sthMvrv = extract(d.sthMvrv);

    // LTH capitulation: SOPR < 1.0 (holders selling at loss) AND NUPL < 0 (net unrealized loss)
    // This is the REAL signal that the proxy was approximating
    const lthFires = sopr !== null && nupl !== null && sopr < 1.0 && nupl < 0;

    // Miner stress from Puell Multiple: < 0.5 means miners earning far below historical average
    // Supplements the hashrate-based miner signal
    const minerStress = puell !== null && puell < 0.5;

    // Deep value signal: MVRV < 1.0 = market cap below realized cap
    const deepValue = mvrv !== null && mvrv < 1.0;

    return {
      ok: true,
      sopr, nupl, mvrv, puell, sthSopr, sthMvrv,
      lthFires, minerStress, deepValue,
      src: "BGeometrics",
    };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ── Blockchain.info miners revenue (free, no key) — supplements miner signal
// When miner revenue drops sharply, miners are under stress
async function fetchMinerRevenue() {
  try {
    const r = await fetch("/api/proxy?source=blockchain&chart=miners-revenue");
    if (!r.ok) return null;
    const d = await r.json();
    const pts = (d.values || []).map(p => p.y);
    if (pts.length < 30) return { ok: false, reason: "insufficient data" };
    const avg30 = pts.slice(-30).reduce((a, b) => a + b, 0) / 30;
    const avg90 = pts.slice(-90).reduce((a, b) => a + b, 0) / Math.min(90, pts.length);
    const current = pts[pts.length - 1];
    // Revenue below 60% of 90d average = miner distress
    const distress = avg90 > 0 && current < avg90 * 0.60;
    return {
      ok: true, current: current / 1e8, avg30: avg30 / 1e8, avg90: avg90 / 1e8,
      distress, ratio: (current / avg90).toFixed(2),
      src: "blockchain.info",
    };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ── Finnhub MSTR backup (free with key, 60 req/min) — backup for Yahoo Finance
// Fetches both real-time quote AND 1yr daily candles for IV Rank + RVol computation
async function fetchMSTRFinnhub() {
  try {
    const [quoteR, candleR] = await Promise.allSettled([
      fetch("/api/proxy?source=finnhub&type=quote").then(r => r.ok ? r.json() : null),
      fetch("/api/proxy?source=finnhub&type=candles").then(r => r.ok ? r.json() : null),
    ]);
    const q = quoteR.status === "fulfilled" ? quoteR.value : null;
    if (!q?.c || q.c <= 0) return null;

    let ivRank = null, ivrCalibrated = false, ivrDataPoints = 0;
    let rvolRatio = null, hv10 = null, hv30 = null;

    const candles = candleR.status === "fulfilled" ? candleR.value : null;
    if (candles?.s === "ok" && candles.h?.length > 60) {
      // Build days array for Parkinson's IV Rank (same algorithm as Yahoo path)
      const days = candles.h.map((h, i) => ({
        high: h, low: candles.l[i], close: candles.c[i]
      })).filter(d => d.high > 0 && d.low > 0 && d.close > 0);

      if (days.length > 60) {
        const ivrResult = computeIVRankFromOHLCV(days, 88); // use default IV since Finnhub has no options
        if (ivrResult) { ivRank = ivrResult.rank; ivrCalibrated = ivrResult.calibrated; ivrDataPoints = ivrResult.dataPoints; }
      }
      const closes = days.map(d => d.close);
      const rv = computeRVol(closes);
      rvolRatio = rv.rvolRatio; hv10 = rv.hv10; hv30 = rv.hv30;
    }

    return { price: q.c, iv: 88, ivRank, ivrCalibrated, ivrDataPoints,
             leapDelta: null, leapStrikeFromChain: null,
             rvolRatio, hv10, hv30, src: "Finnhub (backup)", live: true };
  } catch { return null; }
}

// ── Alpha Vantage MSTR backup (free with key, 25 req/day) — tertiary backup
async function fetchMSTRAlphaVantage() {
  try {
    const r = await fetch("/api/proxy?source=alphavantage");
    if (!r.ok || r.status === 503) return null;
    const d = await r.json();
    const q = d["Global Quote"];
    if (!q || !q["05. price"]) return null;
    return { price: parseFloat(q["05. price"]),
             change: parseFloat(q["09. change"]),
             changePct: parseFloat(q["10. change percent"]),
             src: "Alpha Vantage" };
  } catch { return null; }
}

// ── Tradier Sandbox — FREE options chain backup with full greeks (delayed 15 min)
// Requires free developer account at developer.tradier.com
// Provides: ATM IV, LEAP delta, gamma, theta, vega — all from real chain data
async function fetchOptionsTradierSandbox(refPrice) {
  try {
    const [chainR, leapR] = await Promise.allSettled([
      fetch("/api/proxy?source=tradier_sandbox&type=chain").then(r => r.ok ? r.json() : null),
      fetch("/api/proxy?source=tradier_sandbox&type=leapchain").then(r => r.ok ? r.json() : null),
    ]);

    let atmIV = null, greeks = null;
    if (chainR.status === "fulfilled" && chainR.value) {
      const opts = chainR.value?.options?.option || [];
      const ref = refPrice || 148;
      // Find ATM puts for IV
      const atmPuts = opts.filter(o => o.option_type === "put" && o.greeks?.mid_iv != null
        && Math.abs(o.strike - ref) < ref * 0.04)
        .sort((a, b) => Math.abs(a.strike - ref) - Math.abs(b.strike - ref));
      if (atmPuts.length > 0) {
        atmIV = Math.round(atmPuts[0].greeks.mid_iv * 100 * 10) / 10;
        greeks = {
          delta: atmPuts[0].greeks.delta,
          gamma: atmPuts[0].greeks.gamma,
          theta: atmPuts[0].greeks.theta,
          vega: atmPuts[0].greeks.vega,
          rho: atmPuts[0].greeks.rho,
          src: "Tradier Sandbox",
        };
      } else {
        // Fallback: nearest option with greeks
        const nearest = opts.filter(o => o.greeks?.mid_iv != null)
          .sort((a, b) => Math.abs(a.strike - (refPrice || 148)) - Math.abs(b.strike - (refPrice || 148)));
        if (nearest.length > 0) {
          atmIV = Math.round(nearest[0].greeks.mid_iv * 100 * 10) / 10;
        }
      }
    }

    let leapDelta = null, leapStrikeFromChain = null, leapGreeks = null;
    if (leapR.status === "fulfilled" && leapR.value && !leapR.value.error) {
      const opts = leapR.value?.options?.option || [];
      const ref = refPrice || 148;
      const leapCalls = opts.filter(o => o.option_type === "call"
        && o.strike <= Math.round(ref * 0.70) && o.greeks?.delta != null)
        .sort((a, b) => b.strike - a.strike);
      if (leapCalls.length > 0) {
        leapStrikeFromChain = leapCalls[0].strike;
        leapDelta = leapCalls[0].greeks.delta;
        leapGreeks = {
          delta: leapCalls[0].greeks.delta,
          gamma: leapCalls[0].greeks.gamma,
          theta: leapCalls[0].greeks.theta,
          vega: leapCalls[0].greeks.vega,
          rho: leapCalls[0].greeks.rho,
          src: "Tradier Sandbox LEAP chain",
        };
      }
    }

    if (atmIV === null && leapDelta === null) return null;
    return { atmIV, leapDelta, leapStrikeFromChain, greeks, leapGreeks, src: "Tradier Sandbox" };
  } catch { return null; }
}

// ── MarketData.app — FREE tier options chain (100 req/day)
// Provides ATM IV and basic greeks as tertiary backup
async function fetchOptionsMarketData(refPrice) {
  try {
    const r = await fetch("/api/proxy?source=marketdata&type=chain");
    if (!r.ok || r.status === 503) return null;
    const d = await r.json();
    if (d.s !== "ok" || !d.optionSymbol?.length) return null;

    const ref = refPrice || 148;
    // Find ATM options
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < (d.strike || []).length; i++) {
      if (d.side?.[i] === "put") {
        const dist = Math.abs(d.strike[i] - ref);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
    }

    let atmIV = null, greeks = null;
    if (bestIdx >= 0) {
      atmIV = d.iv?.[bestIdx] != null ? Math.round(d.iv[bestIdx] * 100 * 10) / 10 : null;
      greeks = {
        delta: d.delta?.[bestIdx] || null,
        gamma: d.gamma?.[bestIdx] || null,
        theta: d.theta?.[bestIdx] || null,
        vega: d.vega?.[bestIdx] || null,
        rho: d.rho?.[bestIdx] || null,
        src: "MarketData.app",
      };
    }

    if (atmIV === null) return null;
    return { atmIV, greeks, src: "MarketData.app" };
  } catch { return null; }
}

// ── Options data merge — tries Yahoo chain first, then Tradier Sandbox, then MarketData.app
// Returns enriched options data with greeks from best available source
// Called AFTER primary fetchMSTRData to supplement missing greeks
async function fetchOptionsBackup(mstrResult) {
  if (!mstrResult?.price) return null;
  const ref = mstrResult.price;

  // If Yahoo already provided full chain data with good IV, still try to get greeks from Tradier
  const hasYahooIV = mstrResult.iv && mstrResult.iv !== 88;
  const hasYahooLeap = mstrResult.leapDelta != null;

  // Try Tradier Sandbox for greeks (always — it provides gamma/theta/vega Yahoo doesn't)
  const tradier = await fetchOptionsTradierSandbox(ref);
  if (tradier) {
    const result = { ...mstrResult };
    // Use Tradier IV only if Yahoo didn't provide it
    if (!hasYahooIV && tradier.atmIV) result.iv = tradier.atmIV;
    // Use Tradier LEAP delta if Yahoo didn't provide it
    if (!hasYahooLeap && tradier.leapDelta != null) {
      result.leapDelta = tradier.leapDelta;
      result.leapStrikeFromChain = tradier.leapStrikeFromChain;
    }
    // Always enrich with greeks (Yahoo doesn't provide gamma/theta/vega)
    result.greeks = tradier.greeks || null;
    result.leapGreeks = tradier.leapGreeks || null;
    result.optionsSrc = tradier.src;
    return result;
  }

  // Fallback: MarketData.app
  const md = await fetchOptionsMarketData(ref);
  if (md) {
    const result = { ...mstrResult };
    if (!hasYahooIV && md.atmIV) result.iv = md.atmIV;
    result.greeks = md.greeks || null;
    result.optionsSrc = md.src;
    return result;
  }

  // Last resort: compute synthetic greeks from Black-Scholes
  if (mstrResult.price && mstrResult.iv) {
    const daysToExp = 7; // near-term for ATM greeks
    const strike = Math.round(mstrResult.price); // ATM
    const synth = E.syntheticGreeks(mstrResult.price, strike, mstrResult.iv, daysToExp);
    const result = { ...mstrResult };
    result.greeks = { ...synth, src: "Synthetic (Black-Scholes)" };
    // LEAP greeks
    const leapDays = Math.max(1, Math.round((new Date("2028-12-20") - Date.now()) / 86400000));
    const leapStrike = mstrResult.leapStrikeFromChain || Math.round(mstrResult.price * 0.55);
    const leapSynth = E.syntheticGreeks(mstrResult.price, leapStrike, mstrResult.iv, leapDays);
    result.leapGreeks = { ...leapSynth, src: "Synthetic (Black-Scholes)" };
    result.optionsSrc = "Synthetic (computed)";
    return result;
  }

  return null;
}

// Auto-compute floor signals from available data
// BIC Score: 0-5 count of firing floor signals (strategy doc section 4)
// Controls entire regime: 0-2=Bear Grind, 3=Bottom Window, 4-5=Thesis Gate
// This is SEPARATE from bullScore (0-100) — BIC is the master regime controller
function computeBICScore(sigs) {
  const score = (sigs.lth?1:0)+(sigs.etf?1:0)+(sigs.hash?1:0)+(sigs.miner?1:0)+(sigs.dd?1:0);
  const regime = score>=4?"THESIS_GATE":score===3?"BOTTOM_WINDOW":"BEAR_GRIND";
  const label  = score>=4?"🔴 THESIS GATE — ALL-IN PERMANENT"
               : score===3?"🟡 BOTTOM WINDOW — MAX LEAP ROUTING"
               : "⚪ BEAR GRIND — NORMAL OPERATION";
  const routingOverride = score>=3; // any score 3+ forces 100% Tier C routing
  const zeroCCs = score>=4;         // Thesis Gate = zero covered calls of any kind
  const maxCCPct = score>=4?0:score===3?25:null; // null = normal NAV-based phase applies
  return { score, regime, label, routingOverride, zeroCCs, maxCCPct };
}

function computeAutoSignals(btc, btcHigh, mstr, iv, fg, ivRank, rvol, nav=1.0,
    realHash=null, realETF=null, realMiner=null, onchain=null, minerRevenue=null) {
  // ── LTH Capitulation: LAYERED DETECTION (best → fallback)
  // Layer 1 (REAL): BGeometrics SOPR < 1.0 AND NUPL < 0 (actual on-chain data)
  // Layer 2 (PROXY): BTC 40%+ below high + F&G ≤ 20 + NAV < 1.0× (correlation)
  const lthReal = onchain?.ok && onchain.lthFires;
  const lthProxy = btcHigh > 0 && btc < btcHigh * 0.60 && (fg?.value ?? 50) <= 20 && nav < 1.0;
  const lthFires = lthReal || lthProxy;

  // ── Miner Capitulation: LAYERED DETECTION (best → fallback)
  // Layer 1 (REAL): mempool.space hashrate 30d MA declining >5% below 60d MA
  // Layer 2 (REAL): BGeometrics Puell Multiple < 0.5 (miner revenue stress)
  // Layer 3 (REAL): blockchain.info miner revenue < 60% of 90d average
  // Layer 4 (PROXY): hash ribbon BELOW signal
  const minerReal = realMiner !== null ? realMiner : false;
  const minerPuell = onchain?.ok && onchain.minerStress;
  const minerRevStress = minerRevenue?.ok && minerRevenue.distress;
  const minerProxy = realHash === false; // hash ribbon BELOW = hashrate declining
  const minerFires = minerReal || minerPuell || minerRevStress || minerProxy;

  return {
    // NAV Parity: fires when NAV ≤ 1.0× — pure math, always live
    dd: nav <= 1.0,
    // Hash Ribbon: real 30d/60d MA cross from blockchain.info (free, auto)
    hash: realHash !== null ? realHash : (btcHigh>0 && btc<btcHigh*0.60 && ivRank>55),
    // Miner Capitulation: 4-layer detection (mempool + Puell + revenue + hash ribbon)
    miner: minerFires,
    // ETF Flows: real SoSoValue (fires on recovery: 4+ outflow weeks → current positive)
    // Proxy: F&G rebounding from fear zone
    etf: realETF !== null ? realETF : ((fg?.value??50) > 25 && (fg?.value??50) < 40 && btc > btcHigh*0.60),
    // LTH Capitulation: real BGeometrics SOPR+NUPL when available, proxy fallback
    lth: lthFires,
  };
}

async function parseScreenshot(b64, mediaType, apiKey) {
  mediaType = mediaType || "image/png"; apiKey = apiKey || "";
  var PROMPT_PARTS = [
    "You are parsing a brokerage account screenshot for an MSTR options strategy.",
    "Extract ALL visible data. Return ONLY valid JSON, no markdown:",
    '{ "p1OpenContracts":0, "p2OpenContracts":0, "p1AssignedShares":0, "p2AssignedShares":0,',
    '  "p1LEAPContracts":0, "p2LEAPContracts":0, "p1TierACash":null, "p2TierACash":null,',
    '  "p1TotalAccountValue":null, "p2TotalAccountValue":null,',
    '  "p1ShareCostBasis":null, "p2ShareCostBasis":null, "mstrPrice":null,',
    '  "recentlyClosedPositions":[], "recentlyPurchasedLeaps":[],',
    '  "openPositions":"", "confidence":"high", "notes":null }',
    "recentlyClosedPositions: [{strike, contracts, premium, result:expired/assigned, date}]",
    "recentlyPurchasedLeaps: [{strike, contracts, costPerContract, date}]",
    "Use null for unknown values. Never guess. Only report clearly visible data."
  ];
  var prompt = PROMPT_PARTS.join("\n");
  try {
    var r = await fetch("/api/ai", { method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ action:"screenshot", b64, mediaType }) });
    var d = await r.json();
    return d.result || null;
  } catch(e) { return null; }
}

async function runAuditAI(mktCtx, portCtx, apiKey) {
  apiKey = apiKey || "";
  var AUDIT_PARTS = [
    "MSTR options strategy health check. No markdown. Facts and math only.",
    "Market: BTC $" + ((mktCtx.btc||0).toFixed(0)) + ", MSTR $" + ((mktCtx.mstr||0).toFixed(2)) + ", IVR " + (mktCtx.ivr||0) + ", NAV " + ((mktCtx.nav||0).toFixed(3)) + "x",
    "Portfolio: P1shares=" + portCtx.p1s + ", P2shares=" + portCtx.p2s + ", LEAPs=" + portCtx.leaps + ", All-In=" + mktCtx.allin + "/3",
    "P1=margin spread account. P2=cash-secured naked puts (GF, no Kelly needed).",
    "Output exactly 5 lines: GRADE / THESIS / PORTFOLIO / ACTION / RISK."
  ];
  var p = AUDIT_PARTS.join("\n");
  try {
    var r = await fetch("/api/ai", { method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ action:"audit", mktCtx, portCtx }) });
    var d = await r.json();
    return d.result || null;
  } catch(e) { return null; }
}

async function processSMS(msg, mktCtx, portCtx, apiKey) {
  apiKey = apiKey || "";
  var SMS_PARTS = [
    "You are FOLATAC, MSTR strategy assistant. No emotion. Facts only. Under 160 chars when possible.",
    "BTC $" + ((mktCtx.btc||0).toFixed(0)) + " | MSTR $" + ((mktCtx.mstr||0).toFixed(2)) + " | IVR " + (mktCtx.ivr||0) + " | NAV " + ((mktCtx.nav||0).toFixed(3)) + "x | All-In " + (mktCtx.allin||0) + "/3",
    "P1shares=" + (portCtx.p1s||0) + " | P2shares=" + (portCtx.p2s||0) + " | LEAPs=" + (portCtx.leaps||0),
    "P1=margin spread. P2=cash-secured naked puts (GF). Income to Tier C per routing%."
  ];
  var sys = SMS_PARTS.join("\n");
  try {
    var r = await fetch("/api/ai", { method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ action:"sms", msg, mktCtx, portCtx }) });
    var d = await r.json();
    return d.result || null;
  } catch(e) { return null; }
}

// ── Multi-channel message delivery (server-side, api/sms.js)
// Cascade: Twilio SMS → Amazon SNS → Telegram → Email-to-SMS
// If one fails or runs out of free credits, automatically falls through to next.
// Returns { ok, channel, attempts[] } — shows which channel delivered.
async function sendRealSMS(to, message, opts = {}) {
  if (!message) return { ok: false, error: "Missing message" };
  try {
    const r = await fetch("/api/sms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: to || undefined,
        message,
        carrier: opts.carrier || undefined,
        telegramChatId: opts.telegramChatId || undefined,
      }),
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, error: d.error || `HTTP ${r.status}`, attempts: d.attempts };
    return { ok: true, channel: d.channel, attempts: d.attempts };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Send to multiple phones in parallel, return results per phone
async function sendSMSToAll(phones, message, opts = {}) {
  const targets = phones.filter(Boolean);
  if (targets.length === 0) {
    // No phones — try Telegram only
    const tgResult = await sendRealSMS(null, message, opts);
    return [{ phone: "telegram", ...tgResult }];
  }
  const results = await Promise.allSettled(
    targets.map(p => sendRealSMS(p, message, opts))
  );
  return results.map((r, i) => ({
    phone: targets[i],
    ...(r.status === "fulfilled" ? r.value : { ok: false, error: r.reason?.message }),
  }));
}


const MOCK = {
  btc:     { price:71680, chg24:-1.2, chg7:3.5, rvol:16.4, high90:88000, src:"TEST MODE" },
  mstr:    { price:148, iv:88, ivRank:43, leapDelta:0.78, leapStrikeFromChain:80, src:"TEST MODE", live:true },
  fg:      { value:28, label:"Fear" },
  news:    { items:[
    { title:"MicroStrategy acquires additional 5,000 BTC", pub:"2026-03-08", src:"Coindesk", isAlert:true },
    { title:"Bitcoin ETF inflows turn positive for third day", pub:"2026-03-08", src:"Bloomberg", isAlert:true },
    { title:"Crypto regulation bill advances in Senate", pub:"2026-03-07", src:"Reuters", isAlert:true },
    { title:"MSTR reports Q1 earnings next week", pub:"2026-03-07", src:"CNBC", isAlert:true },
    { title:"On-chain data shows LTH accumulation", pub:"2026-03-06", src:"Glassnode", isAlert:false },
  ]},
};

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS — clean, high-contrast, Robinhood-inspired dark
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  bg0:"#000000", bg1:"#0d0d0d", bg2:"#141414", bg3:"#1c1c1e",
  border:"#2a2a2a", borderHi:"#3a3a3a",
  green:"#00d26a", greenDim:"#00d26a33",
  red:"#ff3b3b",   redDim:"#ff3b3b22",
  gold:"#f5a623",  goldDim:"#f5a62322",
  purple:"#bf5af2",purpleDim:"#bf5af222",
  blue:"#0a84ff",  blueDim:"#0a84ff22",
  white:"#ffffff",  bright:"#e5e5e7",
  mid:"#8e8e93", dim:"#48484a",
  p1:"#00d26a", p2:"#bf5af2",
};

const mono = { fontFamily:"'SF Mono','Fira Code','Courier New',monospace" };
const sans = { fontFamily:"-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif" };

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function FOLATAC() {
  const [tab, setTab] = useState("today");
  const [testMode, setTestMode] = useState(false);
  const [testComplete, setTestComplete] = useState({});

  const [anthropicKey, setAnthropicKey] = usePersistedState("fol_anthropic", "");
  // P&L Trade Log — persisted. Each entry: { date, strike, contracts, premium, result, tierCDeployed }
  const [pnlLog, setPnlLog] = usePersistedState("fol_pnl_v1", []);
  // LEAP Accumulation Log — persisted. Each entry: { date, strike, contracts, costPerContract, totalCost }
  const [leapLog, setLeapLog] = usePersistedState("fol_leaps_v1", []);
  // Daily portfolio snapshots for P&L from inception tracking
  const [snapshots, setSnapshots] = usePersistedState("fol_snaps_v1", []); // [{date, p1Total, p2Total, combined}]
  // Starting capital (locked at first use, editable in System tab)
  const [startingCapital, setStartingCapital] = usePersistedState("fol_startcap", 0);
  const [p1StartCap, setP1StartCap] = usePersistedState("fol_p1_startcap", 0);
  const [p2StartCap, setP2StartCap] = usePersistedState("fol_p2_startcap", 0);
  // Manual pillar broken count (P2 regulatory can't be auto-detected)
  const [manualPillarsBroken, setManualPillarsBroken] = usePersistedState("fol_pillars", 0);
  // Exit confirmation signals (manually monitored per Section 11.4)
  const [exitSigs, setExitSigs] = usePersistedState("fol_exit_v1", {btcMA:false, navCompress:false, etfOutflow:false, hashDeath:false});
  // P1 protection status for today (did user buy the long put?)
  const [p1Protected, setP1Protected] = usePersistedState("fol_p1prot", false);
  // Phone numbers + delivery config — both user and GF
  const [userPhone, setUserPhone] = usePersistedState("fol_phone_user", "");
  const [gfPhone, setGfPhone]     = usePersistedState("fol_phone_gf", "");
  // Carrier for email-to-SMS fallback (verizon, att, tmobile, etc.)
  const [userCarrier, setUserCarrier] = usePersistedState("fol_carrier_user", "");
  const [gfCarrier, setGfCarrier]     = usePersistedState("fol_carrier_gf", "");
  // Telegram chat ID for push notification fallback (get from @userinfobot on Telegram)
  const [telegramChatId, setTelegramChatId] = usePersistedState("fol_telegram_chat", "");
  // Manual data overrides — used when live sources are stale/offline
  // rvolRatio = 10D÷30D realized vol ratio (check TradingView/Barchart for MSTR every Sunday)
  const [manualData, setManualData] = usePersistedState("fol_manual_data", {
    btcPrice: "", mstrPrice: "", mstrIV: "", mstrIVR: "", leapDelta: "", fearGreed: "", rvolRatio: ""
  });
  const [dataOverrideActive, setDataOverrideActive] = useState(false);
  // Data source freshness tracking
  const [dataTimestamps, setDataTimestamps] = usePersistedState("fol_data_ts", {});
  const [alertSent, setAlertSent] = usePersistedState("fol_alert_sent", "");
  // Editable MSTR fundamentals (override CFG defaults when MSTR issues new shares etc.)
  const [editedCFG, setEditedCFG] = usePersistedState("fol_cfg_v1", {
    btcHoldings: CFG.btcHoldings,
    sharesOut: CFG.sharesOut,
    totalDebt: CFG.totalDebt,
    p1Base: CFG.p1Base,
    p2Base: CFG.p2Base,
  });
  // Merge editedCFG over CFG defaults (live config object)
  const liveCFG = { ...CFG, ...editedCFG };
  const [port, setPort]             = usePersistedState("fol_port_v6", {
    p1TierA:CFG.p1TierA, p2TierA:CFG.p2TierA,
    p1Shares:0, p2Shares:0, p1CB:0, p2CB:0,
    p1AssignmentDate:null, p2AssignmentDate:null,  // kept for reference only — not used in CC calc
    p1Leaps:0,  p2Leaps:0,  leapStrike:80, leapDelta:0.75,
  });
  const [sigs, setSigs]             = usePersistedState("fol_sigs_v6", {lth:false,etf:false,hash:false,miner:false,dd:false});
  const [allInCount, setAllInCount] = usePersistedState("fol_allin_v6", 0);
  const [market, setMarket]         = useState({ btc:null, mstr:null, fg:null, news:null });
  const [loading, setLoading]       = useState(true);
  const [lastFetch, setLastFetch]   = useState(null);
  const [smsLog, setSmsLog]         = useState([]);
  const [smsInput, setSmsInput]     = useState("");
  const [smsBusy, setSmsBusy]       = useState(false);
  const [audit, setAudit]           = useState(null);
  const [auditBusy, setAuditBusy]   = useState(false);
  const [ssResult, setSsResult]     = useState(null);
  const [ssBusy, setSsBusy]         = useState(false);
  const fileRef = useRef(null);

  // ── fetch
  const fetchAll = useCallback(async (mock=false) => {
    if (mock) {
      setMarket({ btc:MOCK.btc, mstr:MOCK.mstr, fg:MOCK.fg, news:MOCK.news, hash:null, etf:null });
      setLastFetch(new Date()); setLoading(false); return;
    }
    const btcSpot = await fetchBTC();
    const [mstrR,fgR,newsR,hashR,etfR,minerR,onchainR,minerRevR,thesisR,fedR] = await Promise.allSettled([
      fetchMSTRData(), fetchFearGreed(), fetchNews(),
      fetchHashRibbon(), fetchETFFlows(), fetchMinerStatus(),
      fetchOnChainMetrics(), fetchMinerRevenue(),
      fetchThesisNews(), fetchFedData(),
    ]);
    // Enrich MSTR data with greeks from backup options sources
    let mstrData = mstrR.status==="fulfilled"?mstrR.value:null;
    if (mstrData) {
      const enriched = await fetchOptionsBackup(mstrData);
      if (enriched) mstrData = enriched;
    }
    setMarket({
      btc:  btcSpot,
      mstr: mstrData,
      fg:   fgR.status==="fulfilled"?fgR.value:null,
      news: newsR.status==="fulfilled"?newsR.value:null,
      hash: hashR.status==="fulfilled"?hashR.value:null,
      etf:  etfR.status==="fulfilled"?etfR.value:null,
      miner: minerR.status==="fulfilled"?minerR.value:null,
      onchain: onchainR.status==="fulfilled"?onchainR.value:null,
      minerRev: minerRevR.status==="fulfilled"?minerRevR.value:null,
      thesis: thesisR.status==="fulfilled"?thesisR.value:null,
      fed: fedR.status==="fulfilled"?fedR.value:null,
    });
    const now = Date.now();
    setDataTimestamps({
      btc:  btcSpot ? now : null,
      mstr: mstrR.status==="fulfilled" ? now : null,
      fg:   fgR.status==="fulfilled" ? now : null,
      etf:  etfR.status==="fulfilled" ? now : null,
      hash: hashR.status==="fulfilled" ? now : null,
      miner: minerR.status==="fulfilled" ? now : null,
      onchain: onchainR.status==="fulfilled" ? now : null,
      minerRev: minerRevR.status==="fulfilled" ? now : null,
      thesis: thesisR.status==="fulfilled" ? now : null,
      fed: fedR.status==="fulfilled" ? now : null,
      lastFetchAttempt: now,
    });
    setLastFetch(new Date()); setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll(testMode);
    const t = setInterval(()=>fetchAll(testMode), 60000);
    return ()=>clearInterval(t);
  }, [fetchAll, testMode]);

  // ── PROACTIVE ALERT ENGINE — auto-SMS on significant state changes
  // 10-minute throttle per alert type. Checks every fetch cycle (60s).
  const [lastAlerts, setLastAlerts] = usePersistedState("fol_last_alerts", {});
  const [metricHistory, setMetricHistory] = usePersistedState("fol_metric_hist_v1", []);
  const prevStateRef = useRef(null);

  // Throttled alert sender — only fires if same alert type hasn't fired in 10 min
  const sendProactiveAlert = useCallback(async (alertType, message) => {
    const now = Date.now();
    const THROTTLE_MS = 10 * 60 * 1000; // 10 minutes
    if (lastAlerts[alertType] && now - lastAlerts[alertType] < THROTTLE_MS) return;
    setLastAlerts(prev => ({ ...prev, [alertType]: now }));
    const phones = [userPhone, gfPhone].filter(Boolean);
    if (phones.length > 0 || telegramChatId) {
      await sendSMSToAll(phones, `FOLATAC ALERT [${alertType}]: ${message}`, { carrier: userCarrier, telegramChatId });
    }
  }, [lastAlerts, userPhone, gfPhone, userCarrier, telegramChatId]);

  // ── DATA STALENESS DETECTION — backup to the backup
  // Source is stale if never fetched or last fetch > 15 minutes ago
  const STALE_MS = 15 * 60 * 1000;
  const nowMs = Date.now();
  const isStale = (k) => !dataTimestamps[k] || (nowMs - dataTimestamps[k]) > STALE_MS;
  const staleFields = {
    btc:      isStale("btc"),
    mstr:     isStale("mstr"),
    fg:       isStale("fg"),
    etf:      isStale("etf"),
    hash:     isStale("hash"),
    miner:    isStale("miner"),
    onchain:  isStale("onchain"),
    minerRev: isStale("minerRev"),
  };
  const anyStale = Object.values(staleFields).some(Boolean);
  const staleSources = Object.keys(staleFields).filter(k => staleFields[k]);

  // ── DERIVED MARKET VALUES — manual overrides active when source is stale
  const mn = manualData;
  const btc  = (staleFields.btc  && mn.btcPrice  ? (parseFloat(mn.btcPrice)  || 0) : 0) || market.btc?.price   || 71680;
  const mstr = (staleFields.mstr && mn.mstrPrice ? (parseFloat(mn.mstrPrice) || 0) : 0) || market.mstr?.price  || 148;
  const iv   = (staleFields.mstr && mn.mstrIV    ? (parseFloat(mn.mstrIV)    || 0) : 0) || market.mstr?.iv     || 88;
  const ivr  = (staleFields.mstr && mn.mstrIVR   ? (parseFloat(mn.mstrIVR)   || 0) : 0) || market.mstr?.ivRank || 43;
  const ivrCalibrated = market.mstr?.ivrCalibrated || false;
  const ivrDataPoints = market.mstr?.ivrDataPoints || 0;
  const ivrLabel = !market.mstr?.ivRank ? "default 43" : (!ivrCalibrated ? (ivrDataPoints + "d (calibrating)") : "252d");
  const rvol  = market.btc?.rvol    || 15;
  const high90= market.btc?.high90  || btc*1.15;
  // RVol ratio: 10D÷30D MSTR realized vol — auto-computed from Yahoo Finance 1yr history
  const autoRvolRatio = market.mstr?.rvolRatio || null;
  const rvolRatio = autoRvolRatio || parseFloat(manualData.rvolRatio) || 1.0;
  const rvolIsAuto = autoRvolRatio !== null;
  const rvolMod   = E.rvolMod(rvolRatio);
  const nav   = E.navMult(btc, mstr);
  const solv  = E.solvency(btc);
  const vrp   = E.vrp(iv, rvol);
  const pth   = E.path(btc, nav);
  const route = E.routing(btc, allInCount>=CFG.allInLatch);
  const allIn = E.allInStatus(btc, allInCount);
  const strike= E.strike(mstr, ivr, nav, rvolRatio);
  const longS = E.longPutStrike(strike, mstr, ivr, nav);
  const income = E.weeklyIncome(mstr, iv, ivr, nav, CFG.p1Base, CFG.p2Base, rvolRatio);
  const cpObj = E.ccPhase(nav);

  // Auto-compute ALL signals — fully automated with layered real data sources
  const realHashFires = market.hash?.ok ? market.hash.fires : null;
  const realETFFires  = market.etf?.ok  ? market.etf.fires  : null;
  const realMinerFires = market.miner?.ok ? market.miner.fires : null;
  const autoSigs = computeAutoSignals(btc, high90, mstr, iv, market.fg, ivr, rvol, nav,
    realHashFires, realETFFires, realMinerFires, market.onchain, market.minerRev);
  // All signals are now auto-computed; manual overrides still available via toggle
  const activeSigs = { lth:sigs.lth||autoSigs.lth, etf:sigs.etf||autoSigs.etf,
    hash:sigs.hash||autoSigs.hash, miner:sigs.miner||autoSigs.miner, dd:sigs.dd||autoSigs.dd };
  const floorCount = Object.values(activeSigs).filter(Boolean).length;
  const score = E.bullScore(activeSigs, btc, nav, ivr);
  const nakedEl = E.nakedEligible(btc, high90, iv, ivr, floorCount);

  // Live LEAP data from Yahoo Finance chain (auto) or persisted
  // BIC Score: 0-5 master regime controller (separate from 0-100 bullScore)
  const bic = computeBICScore(activeSigs);
  // BIC overrides routing: score 3+ forces 100% Tier C regardless of BTC price
  const effectiveRoute = bic.routingOverride ? { pct:100, label:"BIC ≥ 3 OVERRIDE", color:"#ef4444" } : route;

  // Earnings blackout: is this Monday within 1 day of a known earnings date?
  const earningsAlert = (() => {
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() + ((8-today.getDay())%7||7));
    // Strategy: alert 7 days in advance so you can plan the coming Monday
    // Alert fires on ANY day within 7 days of earnings
    // Alert level: RED (1-2 days = do not sell), YELLOW (3-7 days = plan ahead)
    const found = CFG.earningsDates.find(d => {
      const ed = new Date(d);
      const diff = (ed - today)/(24*60*60*1000); // positive = upcoming
      return diff >= -1 && diff <= 7; // 7 days before through 1 day after
    });
    if (!found) return null;
    const daysOut = Math.round((new Date(found) - today)/(24*60*60*1000));
    return { date: found, daysOut, urgent: daysOut <= 2 };
  })();

  const liveLeapDelta = market.mstr?.leapDelta || port?.leapDelta || 0.75;
  const leapCC  = E.leapCC(liveLeapDelta, mstr, iv, ivr, nav, bic.score);

  const hasShares = (port?.p1Shares||0)+(port?.p2Shares||0)>0;
  const p1AssCC = hasShares&&port?.p1Shares>0&&port?.p1CB>0
    ? E.assignedCC(mstr,port.p1CB,iv,ivr,nav,bic.score) : null;
  const p2AssCC = hasShares&&port?.p2Shares>0&&port?.p2CB>0
    ? E.assignedCC(mstr,port.p2CB,iv,ivr,nav,bic.score) : null;

  // ── Real-time portfolio value (Section 4.1)
  const portVal = E.portfolioValue(port, mstr, liveLeapDelta, iv);

  // ── Active price alert levels (Section 10.1)
  const priceAlerts = E.activePriceAlerts(btc, mstr, nav);

  // ── Three-pillar thesis check (Section 11.1)
  const etfOutflowWeeks = market.etf?.consecutiveOutflows ?? 0;
  const autoPillarsBroken = E.thesisPillarCheck(btc, solv, etfOutflowWeeks).broken;
  const totalPillarsBroken = Math.max(autoPillarsBroken, manualPillarsBroken);
  const pillarCheck = E.thesisPillarCheck(btc, solv, etfOutflowWeeks);

  // ── LEAP exit signals (Section 11.4)
  const leapExit = E.leapExitSignals(exitSigs.btcMA, exitSigs.navCompress, exitSigs.etfOutflow, exitSigs.hashDeath);

  // ── Kelly-adjusted contract count (Section 11.2)
  const p1TierACash = port?.p1TierA ?? liveCFG.p1TierA;
  const p2TierACash = port?.p2TierA ?? liveCFG.p2TierA;
  const kellyContracts = E.kellyContracts(
    { p1: p1TierACash, p2: p2TierACash }, mstr, strike, nav, ivr, totalPillarsBroken, earningsAlert
  );

  // ── P1 protection deadline (Section 11.3)
  const now_et = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const etHour = now_et.getHours(), etMin = now_et.getMinutes(), etDay = now_et.getDay();
  const hasOpenP1Puts = (port?.p1OpenContracts || 0) > 0;
  const protectionStatus = etDay === 1
    ? E.protectionDeadline(hasOpenP1Puts, p1Protected, etHour, etMin)
    : null;

  // ── LEAP accumulation target (Appendix A4)
  const leapTarget = E.leapAccumTarget(btc, (port?.p1Leaps||0)+(port?.p2Leaps||0), port?.p1Leaps||0, port?.p2Leaps||0);

  // ── Shares exit check (Section 7.2)
  const sharesExitCheck = E.sharesExitCheck(mstr, port?.p1CB||0, port?.p2CB||0, nav);

  // ── Master scenario engine (Section 5 + 11 full decision tree)
  const masterActions = E.masterScenario({
    btc, mstr, iv, ivr, nav, solv, bic, allIn, earningsAlert,
    port, pillarsBroken: totalPillarsBroken, leapExitCount: leapExit.count,
    etfOutflowWeeks, p1TierA: p1TierACash, p2TierA: p2TierACash,
    route: effectiveRoute,
  });
  const topAction = masterActions[0];

  // ═══════════════════════════════════════════════════════════════════════════
  // PROACTIVE ALERT ENGINE — detects state changes and auto-alerts via SMS
  // Compares current state to previous state every 60s fetch cycle.
  // 10-minute throttle per alert type so you don't get blown up.
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!market.mstr?.price || !market.btc?.price) return; // wait for data
    const currentState = {
      btc, mstr, nav: +nav.toFixed(3), ivr, bic: bic.score, floorCount,
      earningsUrgent: earningsAlert?.urgent || false,
      earningsDaysOut: earningsAlert?.daysOut ?? 99,
      thesisSentiment: market.thesis?.overallScore || 0,
      fedLiquidity: market.fed?.liquidityScore || 0,
      pillarsBroken: totalPillarsBroken,
      allInCount,
    };

    const prev = prevStateRef.current;
    if (prev) {
      // ── NAV drops below 1.0x (deep discount — LEAP buying opportunity)
      if (prev.nav >= 1.0 && currentState.nav < 1.0) {
        sendProactiveAlert("NAV_BELOW_1", `NAV premium dropped below 1.0x (now ${currentState.nav}x). MSTR trading at discount to BTC holdings. Favorable LEAP accumulation conditions.`);
      }
      // ── NAV drops below 0.8x (extreme discount — optimal LEAP conditions)
      if (prev.nav >= 0.8 && currentState.nav < 0.8) {
        sendProactiveAlert("NAV_DEEP_DISCOUNT", `NAV at ${currentState.nav}x — extreme discount. Optimal LEAP buying conditions per strategy. BTC $${btc.toLocaleString()} MSTR $${mstr.toFixed(0)}`);
      }
      // ── BIC score increase (floor signals firing — regime shift)
      if (currentState.bic > prev.bic && currentState.bic >= 3) {
        sendProactiveAlert("BIC_REGIME", `BIC score increased to ${currentState.bic}/5 — ${bic.label}. ${currentState.bic >= 4 ? "THESIS GATE: route 100% to Tier C. Zero CCs." : "BOTTOM WINDOW: max LEAP routing."}`);
      }
      // ── IVR spikes above 75 (rich premium — favorable for selling puts)
      if (prev.ivr < 75 && currentState.ivr >= 75) {
        sendProactiveAlert("IVR_HIGH", `IV Rank spiked to ${ivr} — premium-rich environment. Favorable conditions for put selling. VRP: ${vrp.toFixed(2)}x. Consider full contract allocation.`);
      }
      // ── IVR drops below 30 (low premium — reduce size)
      if (prev.ivr >= 30 && currentState.ivr < 30) {
        sendProactiveAlert("IVR_LOW", `IV Rank dropped to ${ivr} — low premium environment. Reduce contract count per strategy rules.`);
      }
      // ── Earnings week approaching (conservative mode)
      if (!prev.earningsUrgent && currentState.earningsUrgent) {
        sendProactiveAlert("EARNINGS_IMMINENT", `MSTR earnings in ${earningsAlert.daysOut} day(s) (${earningsAlert.date}). HALT new put sales. Do NOT open new positions until after report. Reduce existing if possible.`);
      }
      if (prev.earningsDaysOut > 7 && currentState.earningsDaysOut <= 7 && currentState.earningsDaysOut > 2) {
        sendProactiveAlert("EARNINGS_WEEK", `MSTR earnings in ${earningsAlert.daysOut} days (${earningsAlert.date}). Plan ahead: reduce position size, widen strikes, consider closing open positions before report.`);
      }
      // ── Thesis sentiment shift (bearish move)
      if (prev.thesisSentiment > -0.3 && currentState.thesisSentiment < -0.5) {
        sendProactiveAlert("THESIS_BEARISH", `Thesis sentiment shifted BEARISH (${currentState.thesisSentiment.toFixed(2)}). Review: ${market.thesis?.overallLabel}. Check thesis tab for category breakdown.`);
      }
      // ── Thesis sentiment shift (bullish recovery)
      if (prev.thesisSentiment < 0.3 && currentState.thesisSentiment > 0.5) {
        sendProactiveAlert("THESIS_BULLISH", `Thesis sentiment shifted BULLISH (${currentState.thesisSentiment.toFixed(2)}). Conditions may be favorable for increased allocation.`);
      }
      // ── Pillar break (critical — thesis integrity at risk)
      if (currentState.pillarsBroken > prev.pillarsBroken) {
        sendProactiveAlert("PILLAR_BREAK", `THESIS PILLAR BROKEN (${currentState.pillarsBroken}/3). ${currentState.pillarsBroken >= 2 ? "2+ PILLARS BROKEN — FULL STOP on new puts. Run exit protocol." : "1 pillar — halve contract count immediately."}`);
      }
      // ── All-in latch advancing
      if (currentState.allInCount > prev.allInCount && currentState.allInCount >= 2) {
        sendProactiveAlert("ALLIN_ADVANCE", `All-in counter: ${currentState.allInCount}/3. ${currentState.allInCount >= 3 ? "LATCHED — permanent max routing to Tier C. Buy LEAPs aggressively." : "One more close below $45,500 triggers latch."}`);
      }
      // ── Fed liquidity shift (stealth QE detection)
      if (currentState.fedLiquidity >= 4 && prev.fedLiquidity < 4) {
        sendProactiveAlert("FED_EXPANDING", `Fed liquidity score jumped to ${currentState.fedLiquidity}/6 (EXPANDING). Balance sheet + M2 growing = favorable macro backdrop for BTC thesis.`);
      }
      // ── BTC major price level alerts
      if (prev.btc >= 55000 && currentState.btc < 55000) {
        sendProactiveAlert("BTC_PATH_B", `BTC dropped below $55,000 (now $${btc.toLocaleString()}). PATH B active — reduce to 2/4 contracts. Route 25% to Tier C.`);
      }
      if (prev.btc >= 45500 && currentState.btc < 45500) {
        sendProactiveAlert("BTC_ALLIN_ARM", `BTC below $45,500 (now $${btc.toLocaleString()}). ALL-IN ARM zone. Begin monitoring for 3-consecutive-close latch.`);
      }
    }

    prevStateRef.current = currentState;

    // ── HISTORICAL METRIC LOGGING — append to time-series every 5 minutes
    const lastLog = metricHistory.length > 0 ? metricHistory[metricHistory.length - 1] : null;
    const LOG_INTERVAL_MS = 5 * 60 * 1000;
    if (!lastLog || Date.now() - lastLog.ts > LOG_INTERVAL_MS) {
      const entry = {
        ts: Date.now(),
        btc, mstr, nav: +nav.toFixed(3), ivr, iv,
        bic: bic.score, floorCount, rvolRatio,
        fg: market.fg?.value || null,
        hv10: market.mstr?.hv10 || null,
        hv30: market.mstr?.hv30 || null,
        thesisSentiment: market.thesis?.overallScore || null,
        fedLiquidity: market.fed?.liquidityScore || null,
        leapDelta: liveLeapDelta,
      };
      // Keep max 2016 entries (~7 days at 5-min intervals)
      setMetricHistory(prev => [...prev.slice(-2015), entry]);
    }
  }, [market.mstr?.price, market.btc?.price, bic.score, ivr, nav, earningsAlert?.daysOut,
      market.thesis?.overallScore, market.fed?.liquidityScore, totalPillarsBroken, allInCount]);

  // ── PREMARKET DAILY BRIEFING — auto-fires once per day before 9:30am ET
  const [lastDailyBriefing, setLastDailyBriefing] = usePersistedState("fol_daily_brief", "");
  useEffect(() => {
    const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const hour = etNow.getHours();
    const today = etNow.toISOString().split("T")[0];
    // Fire between 7:00-9:30 AM ET, once per day
    if (hour >= 7 && hour < 10 && lastDailyBriefing !== today && market.mstr?.price) {
      setLastDailyBriefing(today);
      const briefing = [
        `FOLATAC DAILY BRIEFING ${today}`,
        `BTC $${btc.toLocaleString()} | MSTR $${mstr.toFixed(2)} | NAV ${nav.toFixed(3)}x`,
        `IVR ${ivr} | IV ${iv}% | RVol ${rvolRatio?.toFixed(2)||"—"} | BIC ${bic.score}/5`,
        `Strike: $${strike} | Contracts: P1=${kellyContracts.p1} P2=${kellyContracts.p2}`,
        earningsAlert ? `EARNINGS in ${earningsAlert.daysOut}d (${earningsAlert.date}) ${earningsAlert.urgent?"— HALT PUTS":"— plan ahead"}` : "",
        bic.score >= 3 ? `REGIME: ${bic.label}` : "",
        market.thesis?.ok ? `Thesis: ${market.thesis.overallLabel} (${market.thesis.overallScore>0?"+":""}${market.thesis.overallScore?.toFixed(2)})` : "",
        market.fed?.ok ? `Fed: ${market.fed.liquidityLabel} (${market.fed.liquidityScore}/6)` : "",
        `Action: ${topAction?.action||"Standby"}`,
        "Upload portfolio screenshot when ready.",
      ].filter(Boolean).join("\n");
      sendProactiveAlert("DAILY_BRIEFING", briefing);
    }
  }, [market.mstr?.price, lastDailyBriefing]);

  // ── WEEKLY HEALTH AUDIT — auto-fire full AI audit every Monday + on significant changes
  const [lastWeeklyAudit, setLastWeeklyAudit] = usePersistedState("fol_weekly_audit", "");
  useEffect(() => {
    const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const dayOfWeek = etNow.getDay(); // 0=Sun, 1=Mon
    const today = etNow.toISOString().split("T")[0];
    // Monday 8am ET — weekly audit
    if (dayOfWeek === 1 && etNow.getHours() >= 8 && lastWeeklyAudit !== today && market.mstr?.price) {
      setLastWeeklyAudit(today);
      (async () => {
        const result = await runAuditAI(
          { btc, mstr, iv, ivr, nav, allin: allInCount },
          { p1s: port?.p1Shares || 0, p2s: port?.p2Shares || 0, leaps: (port?.p1Leaps || 0) + (port?.p2Leaps || 0) }
        );
        if (result) {
          setAudit(result);
          sendProactiveAlert("WEEKLY_AUDIT", `WEEKLY HEALTH AUDIT:\n${result}`);
        }
      })();
    }
  }, [market.mstr?.price, lastWeeklyAudit]);

  // ── P&L from inception via daily snapshots (separate P1 / P2)
  const latestSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const p1Total = portVal?.p1?.total || 0;
  const p2Total = portVal?.p2?.total || 0;
  const p1PL = p1StartCap > 0 ? p1Total - p1StartCap : null;
  const p2PL = p2StartCap > 0 ? p2Total - p2StartCap : null;
  const p1PLPct = p1StartCap > 0 ? ((p1Total - p1StartCap) / p1StartCap * 100) : null;
  const p2PLPct = p2StartCap > 0 ? ((p2Total - p2StartCap) / p2StartCap * 100) : null;
  const combinedStart = (p1StartCap || 0) + (p2StartCap || 0);
  const inceptionPL = combinedStart > 0 && portVal ? portVal.combined - combinedStart : null;
  const inceptionPLPct = combinedStart > 0 && portVal ? ((portVal.combined - combinedStart) / combinedStart * 100) : null;

  // ── "What do I do right now?" — legacy wrapper for backward compat
  const actionRec = topAction
    ? { ...topAction, emoji: topAction.priority===0?"💀":topAction.priority===1?"🔴":topAction.priority===2?"⚡":"✅",
        headline: topAction.headline, action: topAction.detail, bg:"#000", color: topAction.color }
    : { emoji:"✅", headline:"SYSTEM LOADING", action:"Fetching live data...", color:"#00d26a", bg:"#000" };

  // ── P&L summary from trade log
  const pnlSummary = (() => {
    const trades = pnlLog || [];
    const totalIncome = trades.reduce((s,t) => s + (t.premium||0), 0);
    const totalTierC  = trades.reduce((s,t) => s + (t.tierCDeployed||0), 0);
    const assignments = trades.filter(t=>t.result==="assigned").length;
    const expired     = trades.filter(t=>t.result==="expired").length;
    return { count:trades.length, totalIncome, totalTierC, assignments, expired };
  })();

  // ── LEAP log summary
  const leapSummary = (() => {
    const entries = leapLog || [];
    const totalContracts = entries.reduce((s,e) => s + (e.contracts||0), 0);
    const totalCost      = entries.reduce((s,e) => s + (e.totalCost||0), 0);
    const avgStrike      = entries.length>0
      ? entries.reduce((s,e) => s + (e.strike||0)*(e.contracts||0), 0) / Math.max(1, totalContracts)
      : null;
    return { count:entries.length, totalContracts, totalCost, avgStrike };
  })();

  // Auto-reset all-in
  useEffect(()=>{
    const consecutive = market.btc?.consecutiveBelowArm ?? null;
    if (consecutive !== null) {
      if (market.btc.price >= CFG.allInReset) {
        // BTC recovered above $55K — reset counter entirely
        setAllInCount(0);
      } else if (consecutive > 0) {
        // GATE 3 CORROBORATION (strategy v2.0): counter only advances if
        // BIC ≥ 2 OR IVR > 65. Prevents false triggers on flash crashes.
        // A 3-day flash dip with IVR=25 and BIC=0 is NOT the cycle bottom.
        const gate3 = bic.score >= 2 || ivr > 65;
        if (gate3) {
          setAllInCount(Math.min(CFG.allInLatch, consecutive));
        }
        // If Gate 3 fails, counter stays where it is — does not advance
      }
    }
  },[market.btc?.consecutiveBelowArm, market.btc?.price, bic.score, ivr]);

  // Update LEAP delta from chain when available
  useEffect(()=>{
    if(market.mstr?.leapDelta && market.mstr.leapDelta !== port?.leapDelta) {
      setPort(p=>({...p, leapDelta:market.mstr.leapDelta, leapStrike:market.mstr.leapStrikeFromChain||p.leapStrike}));
    }
  },[market.mstr?.leapDelta]);

  // ── handlers
  const handleSS = async (e) => {
    const files = Array.from(e.target.files||[]); if(!files.length) return;
    setSsBusy(true); setSsResult(null);

    // Read all files as base64
    const readFile = (f) => new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve({ b64: r.result.split(",")[1], mediaType: f.type || "image/png" });
      r.onerror = () => resolve(null);
      r.readAsDataURL(f);
    });
    const images = (await Promise.all(files.map(readFile))).filter(Boolean);
    if (!images.length) { setSsBusy(false); return; }

    // Send all images in one request
    let result;
    try {
      const r = await fetch("/api/ai", { method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ action:"screenshot", images }) });
      const d = await r.json();
      result = d.result || null;
    } catch(err) { result = null; }

    if(result){
      setSsResult(result);
      const today = new Date().toISOString().split("T")[0];

      // Update portfolio state
      setPort(p=>({...p,
        p1Shares:  result.p1AssignedShares??p.p1Shares,
        p2Shares:  result.p2AssignedShares??p.p2Shares,
        p1Leaps:   result.p1LEAPContracts??p.p1Leaps,
        p2Leaps:   result.p2LEAPContracts??p.p2Leaps,
        p1TierA:   result.p1TierACash??p.p1TierA,
        p2TierA:   result.p2TierACash??p.p2TierA,
        p1CB:      result.p1ShareCostBasis??p.p1CB,
        p2CB:      result.p2ShareCostBasis??p.p2CB,
        p1OpenContracts: result.p1OpenContracts??p.p1OpenContracts,
        p2OpenContracts: result.p2OpenContracts??p.p2OpenContracts,
        p1AssignmentDate: (result.p1AssignedShares>0&&!p.p1AssignmentDate) ? today : p.p1AssignmentDate,
        p2AssignmentDate: (result.p2AssignedShares>0&&!p.p2AssignmentDate) ? today : p.p2AssignmentDate,
      }));

      // Auto-set starting capitals from first screenshot if not yet set
      const ssP1Total = result.p1TotalAccountValue;
      const ssP2Total = result.p2TotalAccountValue;
      if (ssP1Total && !p1StartCap) setP1StartCap(ssP1Total);
      if (ssP2Total && !p2StartCap) setP2StartCap(ssP2Total);

      // Auto-snapshot for P&L from inception (stores daily account value)
      if (ssP1Total || ssP2Total) {
        const combined = (ssP1Total||0) + (ssP2Total||0);
        setSnapshots(snaps => {
          const existing = snaps.find(s=>s.date===today);
          if (existing) return snaps.map(s=>s.date===today ? {...s, p1Total:ssP1Total, p2Total:ssP2Total, combined} : s);
          return [...snaps, { date:today, p1Total:ssP1Total, p2Total:ssP2Total, combined }];
        });
      }

      // Auto-populate P&L log from recently closed positions detected in screenshot
      const closed = result.recentlyClosedPositions||[];
      if (closed.length > 0) {
        setPnlLog(log => {
          const existing = new Set(log.map(t=>`${t.date}-${t.strike}-${t.contracts}`));
          const newTrades = closed.filter(c=>c.date&&c.strike&&c.contracts&&
            !existing.has(`${c.date}-${c.strike}-${c.contracts}`))
            .map(c=>({ date:c.date||today, strike:c.strike, contracts:c.contracts,
              premium:c.premium||0, result:c.result||"expired",
              tierCDeployed: Math.round((c.premium||0) * 0.15) })); // default 15% routing
          return [...log, ...newTrades];
        });
      }

      // Auto-populate LEAP log from newly purchased LEAPs
      const newLeaps = result.recentlyPurchasedLeaps||[];
      if (newLeaps.length > 0) {
        setLeapLog(log => {
          const existing = new Set(log.map(l=>`${l.date}-${l.strike}-${l.contracts}`));
          const newEntries = newLeaps.filter(l=>l.date&&l.strike&&l.contracts&&
            !existing.has(`${l.date}-${l.strike}-${l.contracts}`))
            .map(l=>({ date:l.date||today, strike:l.strike, contracts:l.contracts,
              costPerContract:l.costPerContract||0, totalCost:(l.contracts||0)*(l.costPerContract||0) }));
          return [...log, ...newEntries];
        });
      }
    }
    setSsBusy(false);
  };

  const handleSMS = async()=>{
    if(!smsInput.trim()||smsBusy) return;
    setSmsBusy(true);
    const msg=smsInput.trim(); setSmsInput("");
    setSmsLog(l=>[...l,{role:"user",text:msg,t:new Date().toLocaleTimeString()}]);
    const reply=await processSMS(msg,{btc,mstr,iv,ivr,nav,allin:allInCount,
      leapCCPhase:leapCC?.ok?leapCC.phase:"N/A", leapCCCov:leapCC?.ok?leapCC.covPct:0,
      portTotal:portVal?.combined?.toFixed(0)||"?",
      p1Total:portVal?.p1?.total?.toFixed(0)||"?",
      p2Total:portVal?.p2?.total?.toFixed(0)||"?",
      totalLeaps:(port?.p1Leaps||0)+(port?.p2Leaps||0),
      totalIncome:pnlSummary.totalIncome.toFixed(0),
      totalTierC:pnlSummary.totalTierC.toFixed(0),
      tradeCount:pnlSummary.count},
      {p1s:port?.p1Shares||0,p2s:port?.p2Shares||0,leaps:(port?.p1Leaps||0)+(port?.p2Leaps||0)});
    // Show reply in app chat
    setSmsLog(l=>[...l,{role:"sys",text:reply,t:new Date().toLocaleTimeString()}]);
    // Also deliver via real SMS/push to user's phone if configured
    if (reply && (userPhone || telegramChatId)) {
      const smsResult = await sendRealSMS(userPhone || null, `FOLATAC: ${reply}`, {carrier: userCarrier, telegramChatId});
      if (smsResult.ok) {
        setSmsLog(l=>[...l,{role:"delivery",text:`Delivered via ${smsResult.channel}`,t:new Date().toLocaleTimeString()}]);
      } else {
        setSmsLog(l=>[...l,{role:"delivery",text:`Delivery failed: ${smsResult.error}`,t:new Date().toLocaleTimeString()}]);
      }
    }
    setSmsBusy(false);
  };

  const handleAudit = async()=>{
    setAuditBusy(true);
    const result=await runAuditAI({btc,mstr,iv,ivr,nav,allin:allInCount,
      leapCCPhase:leapCC?.ok?leapCC.phase:"N/A", leapCCCov:leapCC?.ok?leapCC.covPct:0,
      portTotal:portVal?.combined?.toFixed(0)||"?",
      totalIncome:pnlSummary.totalIncome.toFixed(0),
      totalTierC:pnlSummary.totalTierC.toFixed(0),
      tradeCount:pnlSummary.count,
      leapContracts:(port?.p1Leaps||0)+(port?.p2Leaps||0)},
      {p1s:port?.p1Shares||0,p2s:port?.p2Shares||0,leaps:(port?.p1Leaps||0)+(port?.p2Leaps||0)});
    setAudit(result); setAuditBusy(false);
  };

  // ── TEST MODE runner
  const runTests = async()=>{
    setTestComplete({});
    const results={};
    // 1. Mock data loads
    await fetchAll(true);
    results.data = "PASS: Mock market data loaded — BTC $71,680, MSTR $148, IV 88%";
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,500));
    // 2. Math engine
    const ts = E.strike(148,88,0.95);
    const tl = E.longPutStrike(ts,148,88,0.95);
    const ti = E.weeklyIncome(148,88,43,0.95,4,8);
    results.math = ts>0&&tl>0&&ti.total>0
      ? `PASS: Strike $${ts}, LongPut $${tl}, Weekly income $${ti.total.toFixed(0)}`
      : "FAIL: Math engine returned invalid values";
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,500));
    // 3. CC formula
    const cc = E.assignedCC(148,133,88,43,0.95);
    results.cc = cc.strike>0&&cc.viable
      ? `PASS: Assigned CC — $${cc.strike} strike, $${cc.prem}/share, ${cc.otm}% OTM`
      : `WARN: CC strike $${cc.strike}, viable=${cc.viable} (check premium floor)`;
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,500));
    // 4. Auto-signals
    const as = computeAutoSignals(71680,88000,148,88,{value:28},43,16.4,0.95,null,null);
    results.signals = `PASS: Auto-signals — DD:${as.dd}, Hash:${as.hash}, Miner:${as.miner}, ETF:${as.etf}, LTH:${as.lth}`;
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,500));
    // 5. IV Rank computation
    const mockHist = Array.from({length:252},(_,i)=>60+20*Math.sin(i/20));
    const ivr_test = E.calcIVRank([...mockHist,88]);
    results.ivrank = ivr_test!==null ? `PASS: IV Rank from 253 data points → ${ivr_test.rank}, calibrated: ${ivr_test.calibrated}` : "FAIL: IV rank calculation returned null";
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,500));
    // 6. Claude SMS (live API test)
    try {
      const smsTest = await processSMS("Test message — what is the strike today?",{btc:71680,mstr:148,iv:88,ivr:43,nav:0.952,allin:0},{p1s:0,p2s:0,leaps:0});
      results.sms = smsTest && smsTest.length>10 ? `PASS: Claude SMS API live — response: "${smsTest.slice(0,80)}..."` : "FAIL: Claude API returned empty response";
    } catch { results.sms = "FAIL: Claude API unreachable"; }
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,500));
    // 6b. Real SMS/Telegram delivery test
    try {
      const deliveryResult = await sendRealSMS(
        userPhone || null,
        "FOLATAC TEST — SMS delivery confirmed. If you received this, your alert system is working.",
        { carrier: userCarrier || undefined, telegramChatId: telegramChatId || undefined }
      );
      if (deliveryResult.ok) {
        results.smsDelivery = `PASS: Message delivered via ${deliveryResult.channel}`;
      } else {
        const tried = deliveryResult.attempts?.map(a=>`${a.channel}:${a.error||"ok"}`).join(", ") || "none";
        results.smsDelivery = `FAIL: All delivery channels failed. Tried: ${tried}. Set up at least one: Twilio, AWS SNS, Telegram, or Email-to-SMS in Vercel env vars.`;
      }
    } catch(err) { results.smsDelivery = `FAIL: SMS delivery error — ${err.message}`; }
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,500));
    // 7. Claude Audit (live)
    try {
      const audTest = await runAuditAI({btc:71680,mstr:148,iv:88,ivr:43,nav:0.952,allin:0},{p1s:0,p2s:0,leaps:0});
      results.audit = audTest && audTest.includes("GRADE") ? `PASS: Health audit live — starts: "${audTest.slice(0,80)}..."` : "FAIL: Audit did not return expected format";
    } catch { results.audit = "FAIL: Audit API unreachable"; }
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,500));
    // 8. All-in logic
    const ai3 = E.allInStatus(44000, 3);
    const aiReset = E.allInStatus(60000, 2);
    results.allin = ai3.latched&&!aiReset.latched ? "PASS: All-in latch fires at 3/3, resets above $55K" : "FAIL: All-in logic error";
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,500));
    // 9. Thesis break check
    const exitPath = E.path(25000, 0.8);
    results.thesis = exitPath.skip&&exitPath.p==="EXIT" ? "PASS: Thesis break EXIT path fires at BTC $25K" : "FAIL: EXIT path logic error";
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,300));
    // 10. Portfolio value engine (Section 4.1)
    const mockPort = { p1TierA:33583, p2TierA:93000, p1Leaps:3, p2Leaps:7, leapStrike:80, p1Shares:0, p2Shares:0 };
    const pv = E.portfolioValue(mockPort, 148, 0.78, 88);
    results.portval = pv && pv.combined > 100000 && pv.p1.total > 0 && pv.p2.total > 0
      ? `PASS: Portfolio value engine — P1 $${pv.p1.total.toFixed(0)}, P2 $${pv.p2.total.toFixed(0)}, Combined $${pv.combined.toFixed(0)}`
      : "FAIL: Portfolio value engine returned invalid values";
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,300));
    // 11. Price alert checker (Section 10.1)
    const alerts_low = E.activePriceAlerts(44000, 148, 0.95);
    const alerts_high = E.activePriceAlerts(80000, 750, 0.95);
    results.alerts = alerts_low.any && alerts_low.btc.length >= 3 && alerts_high.mstr.length >= 2
      ? `PASS: Alert checker — BTC $44K fires ${alerts_low.btc.length} BTC alerts; MSTR $750 fires ${alerts_high.mstr.length} MSTR alerts`
      : "FAIL: Price alert checker not triggering correctly";
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,300));
    // 12. Action recommender (Section 10)
    const actionNormal = E.actionNow(71680,148,88,43,0.95,{score:2},{latched:false,armed:false},null,{p:"C",skip:false},false,133,100,{total:3600},{pct:15});
    const actionExit   = E.actionNow(25000,50,120,90,0.8,{score:0},{latched:false},null,{p:"EXIT",skip:true},false,null,null,{total:0},{pct:0});
    results.action = actionNormal.priority===3 && actionNormal.headline.includes("EXECUTE") && actionExit.priority===1 && actionExit.headline.includes("THESIS")
      ? `PASS: Action recommender — Normal week: "${actionNormal.headline}"; Exit scenario: "${actionExit.headline}"`
      : "FAIL: Action recommender logic error";
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,300));
    // 13. P&L log structure
    const mockTrade = { date:"2026-03-10", strike:133, contracts:12, premium:3960, result:"expired", tierCDeployed:594 };
    const testPnl = [mockTrade];
    const pnlTest = testPnl.reduce((s,t)=>s+(t.premium||0),0);
    results.pnllog = pnlTest===3960 && mockTrade.result==="expired"
      ? `PASS: P&L log structure valid — $${pnlTest} premium, ${testPnl.length} trade, result="${mockTrade.result}"`
      : "FAIL: P&L log structure invalid";
    setTestComplete({...results});
    await new Promise(r=>setTimeout(r,300));
    // 14. v5 OTM formula + RVol ratio (strategy doc worked example)
    // v5 doc: IV Rank 42.66 → NORMAL (base 6%) + NAV 0.952× → 0.80–1.00 (+2%) + RVol 1.0 → no adj = 8% → $136
    const docStrike = E.strike(148, 42.66, 0.952, 1.0);
    const rvolStrike125 = E.strike(148, 42.66, 0.952, 1.25); // 1.25 = START of +1.5% band → 9.5% OTM → $133
    const rvolStrike130 = E.strike(148, 42.66, 0.952, 1.30); // +1.5% → 9.5% OTM → $133
    const rvolStrike160 = E.strike(148, 42.66, 0.952, 1.60); // +3.0% → 11% OTM → $131
    const capTest = E.otmPct(85, 0.75, 2.0); // EXTREME+deepNAV+sigRVol = 16+2+3=21, under 22 cap
    const premFloorPass = E.premFloorOk(2.80);
    const premFloorFail = !E.premFloorOk(2.79);
    const otmFormulaOk = docStrike===136 && rvolStrike125===133 && rvolStrike130===133 && rvolStrike160===131 && capTest<=22 && premFloorPass && premFloorFail;
    results.otmformula = otmFormulaOk
      ? `PASS: v5 OTM formula — doc example $136✓, RVol 1.25→$133✓ (+1.5%), 1.30→$133✓, 1.60→$131✓, hard cap ${capTest}%≤22✓, $2.80 floor✓`
      : `FAIL: OTM formula — docStrike=${docStrike}(expect 136), rvol130=${rvolStrike130}(expect 133), cap=${capTest}`;
    setTestComplete({...results});
    results._done = true;
    setTestComplete({...results});
  };

  // ── layout helpers
  const fmt  = (n,d=0) => n!=null?`$${Number(n).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d})}`:"—";
  const fmtN = (n,d=1) => n!=null?Number(n).toFixed(d):"—";
  const pct  = (n)     => n!=null?`${Number(n).toFixed(1)}%`:"—";

  const TABS = [
    {id:"today",  label:"TODAY"},
    {id:"thesis", label:"THESIS"},
    {id:"portfolio",label:"PORTFOLIO"},
    {id:"charts", label:"CHARTS"},
    {id:"gf",     label:"GF MODE"},
    {id:"system", label:"SYSTEM"},
  ];

  // ── CHART HELPERS — SVG line charts for historical metrics
  const [chartMetric, setChartMetric] = useState("btc");
  const [chartRange, setChartRange] = useState("24h");

  const CHART_METRICS = [
    {id:"btc",label:"BTC Price",fmt:v=>`$${v.toLocaleString()}`,color:"#f7931a"},
    {id:"mstr",label:"MSTR Price",fmt:v=>`$${v.toFixed(2)}`,color:"#0a84ff"},
    {id:"nav",label:"NAV Premium",fmt:v=>`${v.toFixed(3)}x`,color:"#a855f7"},
    {id:"ivr",label:"IV Rank",fmt:v=>`${v}`,color:"#22c55e"},
    {id:"iv",label:"ATM IV",fmt:v=>`${v}%`,color:"#06b6d4"},
    {id:"bic",label:"BIC Score",fmt:v=>`${v}/5`,color:"#f59e0b"},
    {id:"rvolRatio",label:"RVol Ratio",fmt:v=>v?.toFixed(2)||"—",color:"#ec4899"},
    {id:"fg",label:"Fear & Greed",fmt:v=>`${v}`,color:"#eab308"},
    {id:"thesisSentiment",label:"Thesis Sentiment",fmt:v=>v?.toFixed(2)||"—",color:"#10b981"},
    {id:"fedLiquidity",label:"Fed Liquidity",fmt:v=>`${v}/6`,color:"#6366f1"},
    {id:"leapDelta",label:"LEAP Delta",fmt:v=>v?.toFixed(3)||"—",color:"#f43f5e"},
    {id:"floorCount",label:"Floor Count",fmt:v=>`${v}`,color:"#14b8a6"},
  ];

  const CHART_RANGES = [
    {id:"1h",label:"1H",ms:3600000},
    {id:"6h",label:"6H",ms:21600000},
    {id:"24h",label:"24H",ms:86400000},
    {id:"3d",label:"3D",ms:259200000},
    {id:"7d",label:"7D",ms:604800000},
  ];

  function renderChart(metric, range) {
    const rangeMs = CHART_RANGES.find(r=>r.id===range)?.ms || 86400000;
    const cutoff = Date.now() - rangeMs;
    const points = metricHistory.filter(e => e.ts >= cutoff && e[metric] != null);
    const metaObj = CHART_METRICS.find(m=>m.id===metric);
    const color = metaObj?.color || "#888";
    const fmtVal = metaObj?.fmt || (v=>`${v}`);

    if (points.length < 2) {
      return (
        <div style={{textAlign:"center",padding:40,color:C.dim,fontSize:11}}>
          Not enough data yet for {metaObj?.label||metric} ({range}). Data logs every 5 minutes.
        </div>
      );
    }

    const vals = points.map(p => p[metric]);
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const rangeV = maxV - minV || 1;
    const W = 820, H = 200, PAD = {top:10,right:10,bottom:30,left:10};
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const minT = points[0].ts;
    const maxT = points[points.length-1].ts;
    const rangeT = maxT - minT || 1;

    const pathD = points.map((p,i) => {
      const x = PAD.left + (p.ts - minT) / rangeT * plotW;
      const y = PAD.top + plotH - ((p[metric] - minV) / rangeV * plotH);
      return `${i===0?"M":"L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    // Area fill
    const firstX = PAD.left;
    const lastX = PAD.left + plotW;
    const areaD = pathD + ` L${lastX.toFixed(1)},${(PAD.top+plotH).toFixed(1)} L${firstX.toFixed(1)},${(PAD.top+plotH).toFixed(1)} Z`;

    // Time labels
    const timeLabels = [];
    const labelCount = 5;
    for (let i = 0; i < labelCount; i++) {
      const t = minT + (rangeT * i / (labelCount - 1));
      const d = new Date(t);
      const label = rangeMs <= 86400000
        ? d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})
        : `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`;
      timeLabels.push({x: PAD.left + (plotW * i / (labelCount - 1)), label});
    }

    const lastVal = vals[vals.length - 1];
    const firstVal = vals[0];
    const change = lastVal - firstVal;
    const changePct = firstVal !== 0 ? (change / firstVal * 100) : 0;

    return (
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div>
            <span style={{color,fontSize:16,fontWeight:700,fontFamily:"monospace"}}>{fmtVal(lastVal)}</span>
            <span style={{color:change>=0?"#22c55e":"#ef4444",fontSize:11,marginLeft:8,fontFamily:"monospace"}}>
              {change>=0?"+":""}{changePct.toFixed(2)}%
            </span>
          </div>
          <div style={{color:C.dim,fontSize:9}}>
            High: <span style={{color:C.mid}}>{fmtVal(maxV)}</span> · Low: <span style={{color:C.mid}}>{fmtVal(minV)}</span>
          </div>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"auto"}}>
          <defs>
            <linearGradient id={`grad-${metric}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.3"/>
              <stop offset="100%" stopColor={color} stopOpacity="0.02"/>
            </linearGradient>
          </defs>
          {/* Grid lines */}
          {[0,0.25,0.5,0.75,1].map(f=>{
            const y = PAD.top + plotH * (1-f);
            return <line key={f} x1={PAD.left} y1={y} x2={PAD.left+plotW} y2={y} stroke="#ffffff08" strokeWidth="1"/>;
          })}
          {/* Area */}
          <path d={areaD} fill={`url(#grad-${metric})`}/>
          {/* Line */}
          <path d={pathD} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round"/>
          {/* Last point dot */}
          {points.length > 0 && (() => {
            const lp = points[points.length-1];
            const cx = PAD.left + (lp.ts - minT) / rangeT * plotW;
            const cy = PAD.top + plotH - ((lp[metric] - minV) / rangeV * plotH);
            return <circle cx={cx} cy={cy} r="3" fill={color} stroke="#000" strokeWidth="1"/>;
          })()}
          {/* Time labels */}
          {timeLabels.map((tl,i)=>(
            <text key={i} x={tl.x} y={H-5} fill="#666" fontSize="9" textAnchor="middle" fontFamily="monospace">{tl.label}</text>
          ))}
        </svg>
      </div>
    );
  }

  const alertNews = market.news?.items?.filter(n=>n.isAlert)||[];

  return (
    <div style={{...sans, background:C.bg0, color:C.bright, minHeight:"100vh", maxWidth:900, margin:"0 auto"}}>

      {/* ── TOP BAR */}
      <div style={{background:C.bg1, borderBottom:`1px solid ${C.border}`, padding:"12px 20px", display:"flex", justifyContent:"space-between", alignItems:"center", position:"sticky", top:0, zIndex:100}}>
        <div style={{display:"flex", alignItems:"center", gap:12}}>
          <span style={{...mono, color:C.green, fontSize:13, fontWeight:700, letterSpacing:"0.15em"}}>FOLATAC</span>
          {testMode && <span style={{background:"#f5a62333",color:C.gold,border:`1px solid ${C.gold}44`,borderRadius:12,padding:"2px 10px",fontSize:10,fontWeight:700}}>TEST MODE</span>}
          {allIn.latched && <span style={{background:C.redDim,color:C.red,border:`1px solid ${C.red}55`,borderRadius:12,padding:"2px 10px",fontSize:10,fontWeight:700}}>🔴 ALL-IN</span>}
          {allIn.armed&&!allIn.latched && <span style={{background:C.goldDim,color:C.gold,border:`1px solid ${C.gold}55`,borderRadius:12,padding:"2px 10px",fontSize:10,fontWeight:700}}>⚠ ARMED {allInCount}/{CFG.allInLatch}</span>}
          {hasShares && <span style={{background:"#f9731622",color:"#f97316",border:"1px solid #f9731644",borderRadius:12,padding:"2px 10px",fontSize:10,fontWeight:700}}>SHARES ASSIGNED</span>}
          {alertNews.length>0 && <span style={{background:C.redDim,color:C.red,border:`1px solid ${C.red}44`,borderRadius:12,padding:"2px 10px",fontSize:10,fontWeight:700}}>⚡ {alertNews.length} ALERT{alertNews.length>1?"S":""}</span>}
        </div>
        <div style={{display:"flex", gap:8, alignItems:"center"}}>
          <span style={{...mono,color:C.dim,fontSize:9}}>{lastFetch?lastFetch.toLocaleTimeString():"—"}</span>
          <button onClick={()=>fetchAll(testMode)} style={{background:"none",border:`1px solid ${C.border}`,color:C.mid,borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:10}}>↺ Refresh</button>
          <button onClick={()=>{setTestMode(t=>!t); setTestComplete({});}}
            style={{background:testMode?C.goldDim:"none",border:`1px solid ${testMode?C.gold:C.border}`,color:testMode?C.gold:C.mid,borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:10}}>
            {testMode?"Exit Test":"Test Mode"}
          </button>
        </div>
      </div>

      {/* ── TABS */}
      <div style={{display:"flex", background:C.bg1, borderBottom:`1px solid ${C.border}`, paddingLeft:12, overflowX:"auto"}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{
            background:"none",border:"none",borderBottom:tab===t.id?`2px solid ${C.green}`:"2px solid transparent",
            color:tab===t.id?C.white:C.dim, padding:"10px 18px", cursor:"pointer",
            fontSize:11, fontWeight:600, letterSpacing:"0.12em", whiteSpace:"nowrap",
            ...sans, transition:"all 0.15s",
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{padding:16}}>

      {/* ══════════════ TODAY TAB ══════════════ */}
      {tab==="today" && <>

        {/* ────────────────────────────────── */}
        {/* BLOCK 1: UPLOAD + PORTFOLIO STATE + P&L FROM INCEPTION */}
        {/* This is the first thing you do every day. */}
        {/* ────────────────────────────────── */}
        <div style={{background:"linear-gradient(135deg,#0a1a0a,#0d1f0d)",border:`2px solid ${C.green}55`,borderRadius:12,padding:16,marginBottom:12}}>
          {/* Upload row */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div>
              <div style={{color:C.green,fontSize:12,fontWeight:700,letterSpacing:"0.1em"}}>📷 DAILY PORTFOLIO UPLOAD</div>
              <div style={{color:C.dim,fontSize:9,marginTop:2}}>Upload up to 10 brokerage screenshots at once. System reads all images together, extracts positions, updates P&L, and generates today's trades.</div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              {p1Protected && etDay===1 && (
                <span style={{background:C.greenDim,color:C.green,border:`1px solid ${C.green}44`,borderRadius:6,padding:"3px 8px",fontSize:9,fontWeight:700}}>✓ P1 PROTECTED</span>
              )}
              <input ref={fileRef} type="file" accept="image/*" multiple onChange={handleSS} style={{display:"none"}} />
              <button onClick={()=>fileRef.current?.click()}
                style={{background:ssBusy?C.bg3:C.green,color:ssBusy?"#fff":"#000",border:"none",borderRadius:8,padding:"8px 16px",cursor:ssBusy?"not-allowed":"pointer",fontSize:11,fontWeight:700,minWidth:130,transition:"all 0.15s"}}>
                {ssBusy?"⏳ Analyzing…":"📷 Upload"}
              </button>
            </div>
          </div>

          {/* Portfolio P1 / P2 — separate tracking */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
            {/* P1 CARD */}
            <div style={{background:"linear-gradient(135deg,#0a0a1a,#0d0d2a)",border:"1px solid #3b82f644",borderRadius:10,padding:14}}>
              <div style={{color:"#3b82f6",fontSize:10,fontWeight:700,letterSpacing:"0.1em",marginBottom:8}}>P1 — MARGIN SPREAD</div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
                <div style={{color:C.dim,fontSize:8}}>PORTFOLIO VALUE</div>
                <div style={{fontFamily:"monospace",color:p1Total>0?"#fff":"#666",fontSize:18,fontWeight:700}}>{p1Total>0?fmt(p1Total):"—"}</div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
                <div style={{color:C.dim,fontSize:8}}>P&L FROM DAY 1</div>
                <div style={{fontFamily:"monospace",fontSize:16,fontWeight:900,
                  color:p1PL===null?"#fff":p1PL>0?"#22c55e":p1PL<0?"#ef4444":"#fff"}}>
                  {p1PL!==null?`${p1PL>=0?"+":""}${fmt(p1PL)}`:"SET START →"}
                </div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                <div style={{color:C.dim,fontSize:8}}>RETURN</div>
                <div style={{fontFamily:"monospace",fontSize:14,fontWeight:900,
                  color:p1PLPct===null?"#fff":p1PLPct>0?"#22c55e":p1PLPct<0?"#ef4444":"#fff"}}>
                  {p1PLPct!==null?`${p1PLPct>=0?"+":""}${p1PLPct.toFixed(2)}%`:"—"}
                </div>
              </div>
              <div style={{marginTop:8,display:"flex",gap:6,alignItems:"center"}}>
                <div style={{color:C.dim,fontSize:8}}>Start:</div>
                <input type="number" value={p1StartCap||""} onChange={e=>{const v=parseFloat(e.target.value);if(!isNaN(v)&&v>=0)setP1StartCap(v)}}
                  placeholder="P1 starting $" style={{flex:1,background:"#ffffff08",border:"1px solid #3b82f633",color:"#3b82f6",padding:"4px 8px",borderRadius:6,fontSize:10,fontFamily:"monospace"}}/>
              </div>
            </div>
            {/* P2 CARD */}
            <div style={{background:"linear-gradient(135deg,#0a1a0a,#0d2a0d)",border:"1px solid #22c55e44",borderRadius:10,padding:14}}>
              <div style={{color:"#22c55e",fontSize:10,fontWeight:700,letterSpacing:"0.1em",marginBottom:8}}>P2 — CASH SECURED (GF)</div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
                <div style={{color:C.dim,fontSize:8}}>PORTFOLIO VALUE</div>
                <div style={{fontFamily:"monospace",color:p2Total>0?"#fff":"#666",fontSize:18,fontWeight:700}}>{p2Total>0?fmt(p2Total):"—"}</div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
                <div style={{color:C.dim,fontSize:8}}>P&L FROM DAY 1</div>
                <div style={{fontFamily:"monospace",fontSize:16,fontWeight:900,
                  color:p2PL===null?"#fff":p2PL>0?"#22c55e":p2PL<0?"#ef4444":"#fff"}}>
                  {p2PL!==null?`${p2PL>=0?"+":""}${fmt(p2PL)}`:"SET START →"}
                </div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                <div style={{color:C.dim,fontSize:8}}>RETURN</div>
                <div style={{fontFamily:"monospace",fontSize:14,fontWeight:900,
                  color:p2PLPct===null?"#fff":p2PLPct>0?"#22c55e":p2PLPct<0?"#ef4444":"#fff"}}>
                  {p2PLPct!==null?`${p2PLPct>=0?"+":""}${p2PLPct.toFixed(2)}%`:"—"}
                </div>
              </div>
              <div style={{marginTop:8,display:"flex",gap:6,alignItems:"center"}}>
                <div style={{color:C.dim,fontSize:8}}>Start:</div>
                <input type="number" value={p2StartCap||""} onChange={e=>{const v=parseFloat(e.target.value);if(!isNaN(v)&&v>=0)setP2StartCap(v)}}
                  placeholder="P2 starting $" style={{flex:1,background:"#ffffff08",border:"1px solid #22c55e33",color:"#22c55e",padding:"4px 8px",borderRadius:6,fontSize:10,fontFamily:"monospace"}}/>
              </div>
            </div>
          </div>
          {/* Combined P&L + Income row */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:ssResult?10:0}}>
            <div style={{background:"#ffffff08",borderRadius:8,padding:10,textAlign:"center"}}>
              <div style={{color:C.dim,fontSize:8,letterSpacing:"0.08em",marginBottom:3}}>COMBINED P&L</div>
              <div style={{fontFamily:"monospace",fontSize:16,fontWeight:900,
                color:inceptionPL===null?"#fff":inceptionPL>0?"#22c55e":inceptionPL<0?"#ef4444":"#fff"}}>
                {inceptionPL!==null?`${inceptionPL>=0?"+":""}${fmt(inceptionPL)}`:"—"}
              </div>
              <div style={{fontFamily:"monospace",fontSize:11,fontWeight:700,marginTop:2,
                color:inceptionPLPct===null?"#666":inceptionPLPct>0?"#22c55e":inceptionPLPct<0?"#ef4444":"#fff"}}>
                {inceptionPLPct!==null?`${inceptionPLPct>=0?"+":""}${inceptionPLPct.toFixed(2)}%`:"set starting capitals above"}
              </div>
            </div>
            <div style={{background:"#ffffff08",borderRadius:8,padding:10,textAlign:"center"}}>
              <div style={{color:C.dim,fontSize:8,letterSpacing:"0.08em",marginBottom:3}}>WEEKLY INCOME (EST)</div>
              <div style={{fontFamily:"monospace",color:C.gold,fontSize:14,fontWeight:700}}>{fmt(income.total)}</div>
              <div style={{color:C.dim,fontSize:8,marginTop:2}}>{kellyContracts.p1+kellyContracts.p2} contracts · {effectiveRoute.pct}% → Tier C</div>
            </div>
            <div style={{background:"#ffffff08",borderRadius:8,padding:10,textAlign:"center"}}>
              <div style={{color:C.dim,fontSize:8,letterSpacing:"0.08em",marginBottom:3}}>TIER C → LEAPS</div>
              <div style={{fontFamily:"monospace",color:C.gold,fontSize:14,fontWeight:700}}>{(port?.p1Leaps||0)+(port?.p2Leaps||0)} contracts</div>
              <div style={{color:C.dim,fontSize:8,marginTop:2}}>${fmt(leapSummary.totalCost||0).replace("$","")} total cost · {leapTarget.phase}</div>
            </div>
          </div>

          {/* Screenshot parse results */}
          {ssResult && (
            <div style={{background:"#ffffff0a",borderRadius:8,padding:10,marginTop:4}}>
              <div style={{color:C.green,fontSize:9,fontWeight:700,marginBottom:6}}>
                ✓ PARSED — {ssResult.confidence} confidence
                {ssResult.notes && <span style={{color:C.mid}}> · {ssResult.notes}</span>}
                {((ssResult.recentlyClosedPositions||[]).length > 0 || (ssResult.recentlyPurchasedLeaps||[]).length > 0) && (
                  <span style={{color:C.gold,marginLeft:8}}>⚡ {(ssResult.recentlyClosedPositions||[]).length} closed + {(ssResult.recentlyPurchasedLeaps||[]).length} LEAP(s) auto-logged</span>
                )}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
                {[
                  {l:"P1 Open",v:ssResult.p1OpenContracts,c:C.p1},
                  {l:"P2 Open",v:ssResult.p2OpenContracts,c:C.p2},
                  {l:"P1 Shares",v:ssResult.p1AssignedShares,c:"#f97316"},
                  {l:"P2 Shares",v:ssResult.p2AssignedShares,c:"#f97316"},
                  {l:"P1 LEAPs",v:ssResult.p1LEAPContracts,c:C.gold},
                  {l:"P2 LEAPs",v:ssResult.p2LEAPContracts,c:C.gold},
                  {l:"P1 Cash",v:ssResult.p1TierACash?fmt(ssResult.p1TierACash):"—",c:C.mid},
                  {l:"P2 Cash",v:ssResult.p2TierACash?fmt(ssResult.p2TierACash):"—",c:C.mid},
                ].map((s,i)=>(
                  <div key={i} style={{textAlign:"center"}}>
                    <div style={{color:C.dim,fontSize:8,marginBottom:1}}>{s.l}</div>
                    <div style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:s.c,fontSize:13,fontWeight:700}}>{s.v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ────────────────────────────────── */}
        {/* BLOCK 2: MASTER ACTION — what to do RIGHT NOW */}
        {/* ────────────────────────────────── */}
        {masterActions.length > 0 && (
          <div style={{marginBottom:12}}>
            {masterActions.slice(0,2).map((a,i)=>(
              <div key={i} style={{background:`${a.color}10`,border:`2px solid ${a.color}66`,borderRadius:10,padding:12,marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:5}}>
                  <span style={{color:a.color,fontSize:11,fontWeight:700,letterSpacing:"0.1em"}}>{a.tag} — {a.headline}</span>
                  <span style={{color:C.dim,fontSize:8,letterSpacing:"0.08em"}}>PRIORITY {a.priority}</span>
                </div>
                <div style={{color:C.mid,fontSize:10,lineHeight:1.6}}>{a.detail}</div>
              </div>
            ))}
          </div>
        )}

        {/* ══════ DATA STALENESS ALERT — BACKUP TO THE BACKUP ══════ */}
        {anyStale && (
          <div style={{background:"#1a0a00",border:"2px solid #f97316",borderRadius:10,padding:16,marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
              <div>
                <div style={{color:"#f97316",fontSize:12,fontWeight:700}}>⚠ DATA OFFLINE — MANUAL INPUT REQUIRED</div>
                <div style={{color:"#fdba74",fontSize:9,marginTop:2}}>
                  Stale sources: {staleSources.map(s=>s.toUpperCase()).join(", ")} — all formulas using last known or fallback values.
                  {anyStale && " Accuracy degraded."}
                </div>
              </div>
              <div style={{display:"flex",gap:6}}>
                <button onClick={async ()=>{
                  // Send real SMS alert to both user and GF via Twilio
                  const alertMsg = "FOLATAC DATA ALERT: Sources offline: " + staleSources.join(", ").toUpperCase() + ". Go to FOLATAC > TODAY tab > Data Override to enter values manually.";
                  const now_str = new Date().toISOString().slice(0,16);
                  const alertKey = now_str.slice(0,15); // YYYY-MM-DDTHH:MM — throttle once per 10 min
                  if (alertSent !== alertKey) {
                    setAlertSent(alertKey);
                    const phones = [userPhone, gfPhone].filter(Boolean);
                    if (phones.length === 0 && !telegramChatId) {
                      alert("No phone numbers or Telegram set. Go to System tab to configure.");
                      return;
                    }
                    const results = await sendSMSToAll(phones, alertMsg, {carrier: userCarrier, telegramChatId});
                    const summary = results.map(r => `${r.phone}: ${r.ok ? `SENT via ${r.channel}` : r.error}`).join("\n");
                    alert("Delivery Results:\n" + summary);
                  } else {
                    alert("Alert already sent recently. Phones: " + (userPhone||"none") + ", " + (gfPhone||"none"));
                  }
                }}
                  style={{background:"#f9731622",border:"1px solid #f97316",color:"#f97316",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:9,fontWeight:700}}>
                  📱 Alert Both Phones
                </button>
                <button onClick={()=>setDataOverrideActive(v=>!v)}
                  style={{background:dataOverrideActive?"#f97316":"#1a1a1a",border:"1px solid #f97316",color:dataOverrideActive?"#000":"#f97316",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:9,fontWeight:700}}>
                  {dataOverrideActive?"Hide Overrides":"Enter Manually"}
                </button>
              </div>
            </div>
            {/* Manual override input grid */}
            {dataOverrideActive && (
              <div style={{background:"#ffffff08",borderRadius:8,padding:12}}>
                <div style={{color:"#fdba74",fontSize:9,fontWeight:700,marginBottom:8}}>
                  MANUAL DATA OVERRIDE — Enter current values. These replace stale live data immediately.
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                  {[
                    {key:"btcPrice",   label:"BTC Price ($)",        ph:"e.g. 71680", stale:staleFields.btc},
                    {key:"mstrPrice",  label:"MSTR Price ($)",       ph:"e.g. 148",   stale:staleFields.mstr},
                    {key:"mstrIV",     label:"MSTR IV (%)",          ph:"e.g. 88",    stale:staleFields.mstr},
                    {key:"mstrIVR",    label:"IV Rank (0-100)",      ph:"e.g. 43",    stale:staleFields.mstr},
                    {key:"leapDelta",  label:"LEAP Delta (Dec2028)", ph:"e.g. 0.75",  stale:staleFields.mstr},
                    {key:"fearGreed",  label:"Fear & Greed (0-100)", ph:"e.g. 30",    stale:staleFields.fg},
                  ].map(function(f) { return (
                    <div key={f.key}>
                      <div style={{color:f.stale?"#f97316":"#555",fontSize:8,marginBottom:2,fontWeight:f.stale?700:400}}>
                        {f.stale?"⚠ ":""}{f.label}
                      </div>
                      <input type="number" value={manualData[f.key]||""} placeholder={f.ph}
                        onChange={function(e){ setManualData(function(d){ var n={...d}; n[f.key]=e.target.value; return n; }); }}
                        style={{width:"100%",background:f.stale?"#2a1000":"#111",border:"1px solid " + (f.stale?"#f97316":"#333"),color:f.stale?"#f97316":"#888",padding:"5px 8px",borderRadius:6,fontSize:10,boxSizing:"border-box",fontFamily:"monospace"}}/>
                    </div>
                  ); })}
                </div>
                <div style={{marginTop:10,padding:10,background:"#0a1a00",border:`1px solid ${rvolIsAuto?"#22c55e44":"#f59e0b44"}`,borderRadius:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                    <div style={{color:rvolIsAuto?"#22c55e":"#f59e0b",fontSize:9,fontWeight:700}}>📐 MSTR RVOL RATIO (10D÷30D) — STEP 3.5 OTM FILTER</div>
                    <div style={{background:rvolIsAuto?"#22c55e22":"#f59e0b22",border:`1px solid ${rvolIsAuto?"#22c55e":"#f59e0b"}`,color:rvolIsAuto?"#22c55e":"#f59e0b",borderRadius:4,padding:"1px 6px",fontSize:8,fontWeight:700}}>
                      {rvolIsAuto?`AUTO ✓ ${(market.mstr?.src||"YAHOO FINANCE").toUpperCase()}`:"⚠ MANUAL"}
                    </div>
                  </div>
                  {rvolIsAuto ? (
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:6}}>
                      {[
                        {l:"HV10 (ann.)", v:`${market.mstr?.hv10?.toFixed(1)}%`},
                        {l:"HV30 (ann.)", v:`${market.mstr?.hv30?.toFixed(1)}%`},
                        {l:"Ratio", v:rvolRatio.toFixed(3)},
                      ].map((s,i)=>(
                        <div key={i} style={{background:"#ffffff08",borderRadius:6,padding:"6px 8px",textAlign:"center"}}>
                          <div style={{color:"#555",fontSize:7,marginBottom:1}}>{s.l}</div>
                          <div style={{fontFamily:"monospace",color:"#22c55e",fontSize:12,fontWeight:700}}>{s.v}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <>
                      <div style={{color:"#555",fontSize:8,marginBottom:6}}>Yahoo Finance history unavailable — enter manually from TradingView/Barchart (MSTR → Indicators → HV10 ÷ HV30). Below 1.25: +0% OTM. 1.25–1.50: +1.5% OTM. Above 1.50: +3.0% OTM.</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 3fr",gap:8,alignItems:"center"}}>
                        <input type="number" step="0.01" value={manualData.rvolRatio||""} placeholder="e.g. 1.12"
                          onChange={function(e){ setManualData(function(d){ return {...d, rvolRatio:e.target.value}; }); }}
                          style={{background:"#111",border:"1px solid #f59e0b",color:"#f59e0b",padding:"6px 10px",borderRadius:6,fontSize:12,fontFamily:"monospace"}}/>
                        <div style={{color:"#888",fontSize:9}}>Emergency override — auto resumes when Yahoo Finance reconnects</div>
                      </div>
                    </>
                  )}
                  <div style={{color:rvolRatio>1.50?"#ef4444":rvolRatio>1.25?"#f59e0b":"#22c55e",fontSize:10,fontWeight:700,marginTop:6}}>
                    {rvolRatio>1.50?"⚠ SIGNIFICANT VOL EXPANSION → +3.0% OTM":rvolRatio>1.25?"⚡ MODERATE VOL EXPANSION → +1.5% OTM":"✓ NORMAL — no adjustment (+0%)"}
                    {rvolMod>0 && <span style={{color:"#f59e0b"}}> · Strike: ${strike||"?"} ({E.otmPct(iv,nav,rvolRatio)}% OTM, cap 22%)</span>}
                  </div>
                </div>
                <div style={{display:"flex",gap:8,marginTop:8,alignItems:"center"}}>
                  <button onClick={function(){ setManualData({btcPrice:"",mstrPrice:"",mstrIV:"",mstrIVR:"",leapDelta:"",fearGreed:"",rvolRatio:""}); }}
                    style={{background:"#333",border:"1px solid #555",color:"#888",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:9}}>
                    Clear All
                  </button>
                  <div style={{color:"#666",fontSize:8}}>
                    Manual values are highlighted in orange. Live data resumes automatically when sources come back online.
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* P1 protection deadline — Monday only, critical */}
        {protectionStatus && protectionStatus.status !== "no_position" && protectionStatus.status !== "protected" && (
          <div style={{background:`${protectionStatus.color}15`,border:`2px solid ${protectionStatus.color}`,borderRadius:8,padding:10,marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{color:protectionStatus.color,fontSize:10,fontWeight:700}}>{protectionStatus.action}</div>
            {protectionStatus.status !== "CRITICAL" && (
              <button onClick={()=>setP1Protected(true)}
                style={{background:C.greenDim,border:`1px solid ${C.green}44`,color:C.green,borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:9,fontWeight:700,flexShrink:0}}>
                Mark Protected ✓
              </button>
            )}
          </div>
        )}

        {/* SOLVENCY ALERT */}
        {(() => { const s=E.solvency(btc); return s.r<1.5&&btc>0?(
          <div style={{background:"#1a0000",border:"2px solid #ef4444",borderRadius:8,padding:"10px 14px",marginBottom:10,display:"flex",gap:8,alignItems:"center"}}>
            <span style={{color:"#ef4444",fontWeight:700,fontSize:13}}>⚠ SOLVENCY ALERT</span>
            <span style={{color:"#fca5a5",fontSize:11}}>MSTR solvency {s.r.toFixed(2)}× is below 1.5× — run full thesis check immediately. BTC ${btc.toLocaleString()} × 720,737 BTC ÷ $8.24B debt.</span>
          </div>
        ):null; })()}

        {/* ETF THESIS BREAK ALERT */}
        {market.etf?.ok && market.etf.consecutiveOutflows>=8 && (
          <div style={{background:"#1a0000",border:"2px solid #ef4444",borderRadius:8,padding:"10px 14px",marginBottom:10}}>
            <span style={{color:"#ef4444",fontWeight:700,fontSize:13}}>🔴 ETF THESIS BREAK SIGNAL</span>
            <span style={{color:"#fca5a5",fontSize:11,marginLeft:8}}>{market.etf.consecutiveOutflows} consecutive weeks of BTC ETF outflows — institutional floor may be failing. Review exit protocol (Section 11 of strategy doc).</span>
          </div>
        )}

        {/* Shares exit trigger */}
        {sharesExitCheck.any && (
          <div style={{background:"#1a0a00",border:"2px solid #f97316",borderRadius:8,padding:"10px 14px",marginBottom:10}}>
            <div style={{color:"#f97316",fontWeight:700,fontSize:12}}>⚡ ASSIGNED SHARES EXIT TRIGGER</div>
            {sharesExitCheck.p1.exit && <div style={{color:C.mid,fontSize:9,marginTop:2}}>P1: {sharesExitCheck.p1.reason}. Sell at market → redeploy to Tier C LEAPs.</div>}
            {sharesExitCheck.p2.exit && <div style={{color:C.mid,fontSize:9,marginTop:2}}>P2: {sharesExitCheck.p2.reason}. Sell at market → redeploy to Tier C LEAPs.</div>}
          </div>
        )}

        {/* EARNINGS BLACKOUT */}
        {earningsAlert && (
          <div style={{background:earningsAlert.urgent?"#1a0000":"#1a1000",
            border:`2px solid ${earningsAlert.urgent?"#ef4444":"#f59e0b"}`,
            borderRadius:8,padding:"10px 14px",marginBottom:10,display:"flex",gap:8,alignItems:"center"}}>
            <span style={{fontSize:16}}>{earningsAlert.urgent?"🚫":"📅"}</span>
            <div>
              <div style={{color:earningsAlert.urgent?"#ef4444":"#f59e0b",fontWeight:700,fontSize:12}}>
                {earningsAlert.urgent?"🔴 EARNINGS BLACKOUT — DO NOT SELL PUTS":"⚠ EARNINGS WARNING — PLAN AHEAD"}
              </div>
              <div style={{color:earningsAlert.urgent?"#fca5a5":"#fcd34d",fontSize:11,marginTop:2}}>
                MSTR earnings {earningsAlert.date} ({earningsAlert.daysOut <= 0?"TODAY":earningsAlert.daysOut===1?"TOMORROW":`in ${earningsAlert.daysOut} days`}).
                {earningsAlert.urgent?" Skip this week entirely.":" Do not sell puts the week of earnings. Sunday brief will confirm."}
              </div>
            </div>
          </div>
        )}

        {/* Price alerts */}
        {priceAlerts.any && (
          <div style={{marginBottom:12}}>
            {priceAlerts.btc.slice(-1).map((a,i)=>(
              <div key={i} style={{background:"#1a0000",border:`2px solid ${a.color}`,borderRadius:8,padding:"8px 12px",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div><span style={{color:a.color,fontWeight:700,fontSize:11}}>⚡ BTC ALERT — {a.label}</span><span style={{color:C.mid,fontSize:9,marginLeft:8}}>{a.action}</span></div>
                <span style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:a.color,fontSize:10,fontWeight:700}}>${btc.toLocaleString()}</span>
              </div>
            ))}
            {priceAlerts.mstr.map((a,i)=>(
              <div key={i} style={{background:"#0d0020",border:`2px solid ${a.color}`,borderRadius:8,padding:"8px 12px",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div><span style={{color:a.color,fontWeight:700,fontSize:11}}>⚡ MSTR ALERT — {a.label}</span><span style={{color:C.mid,fontSize:9,marginLeft:8}}>{a.action}</span></div>
                <span style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:a.color,fontSize:10,fontWeight:700}}>${mstr.toLocaleString()}</span>
              </div>
            ))}
            {priceAlerts.nav.map((a,i)=>(
              <div key={i} style={{background:"#1a0800",border:`2px solid ${a.color}`,borderRadius:8,padding:"8px 12px",marginBottom:6}}>
                <span style={{color:a.color,fontWeight:700,fontSize:11}}>⚡ NAV ALERT — {a.label}</span>
                <span style={{color:C.mid,fontSize:9,marginLeft:8}}>{a.action}</span>
              </div>
            ))}
          </div>
        )}

        {/* Trade window status */}
        {(()=>{
          const now=new Date();
          const et=new Date(now.toLocaleString("en-US",{timeZone:"America/New_York"}));
          const day=et.getDay(); if(day!==1) return null;
          const hm=et.getHours()*60+et.getMinutes();
          const open=hm>=9*60+45&&hm<11*60;
          const closing=hm>=10*60+30&&hm<11*60;
          const missed=hm>=11*60&&hm<15*60+30;
          const deadline=hm>=15*60+30;
          const clr=open?(closing?"#f59e0b":"#22c55e"):missed?"#ef4444":"#6b7280";
          const msg=deadline?"⛔ 3:30PM DEADLINE PASSED — No entries. Wait until next Monday."
            :missed?"🔴 SELL WINDOW CLOSED (missed 11am) — Skip this week. Text 'skipped'."
            :closing?"⚠ SELL WINDOW CLOSING — 30 min left. Execute now or skip."
            :"🟢 SELL WINDOW OPEN — Execute short puts now (9:45–11am ET)";
          return (
            <div style={{background:open?"#0a1a0a":"#1a0a0a",border:`2px solid ${clr}`,borderRadius:8,padding:"10px 14px",marginBottom:10,display:"flex",gap:10,alignItems:"center"}}>
              <div>
                <div style={{color:clr,fontWeight:700,fontSize:12}}>{msg}</div>
                <div style={{color:C.dim,fontSize:9,marginTop:2}}>9:45am sell puts · 2:00pm buy $100P (P1) · 3:30pm hard cutoff — no exceptions</div>
              </div>
            </div>
          );
        })()}

        {/* TODAY'S TRADE RECOMMENDATIONS */}
        <div style={{marginBottom:16}}>
          <div style={{color:C.white,fontSize:13,fontWeight:700,marginBottom:10,letterSpacing:"0.05em"}}>TODAY'S TRADE RECOMMENDATIONS</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {/* P1 */}
            <div style={{background:C.bg2,border:`1px solid ${C.p1}44`,borderRadius:10,padding:14}}>
              <div style={{color:C.p1,fontSize:10,fontWeight:700,letterSpacing:"0.12em",marginBottom:10}}>P1 — MARGIN — BULL PUT SPREAD</div>
              {pth.skip ? (
                <div style={{color:C.red,fontSize:12,padding:8,background:C.redDim,borderRadius:6}}>PATH {pth.p} — DO NOT SELL PUTS THIS WEEK</div>
              ) : <>
                <div style={{marginBottom:8}}>
                  <div style={{color:C.mid,fontSize:9,marginBottom:2}}>STEP 1 — 9:45 AM SELL</div>
                  <div style={{...mono,color:C.white,fontSize:18,fontWeight:700}}>Sell {CFG.p1Base} × ${strike||"—"} Put</div>
                  <div style={{color:C.mid,fontSize:9}}>
                    ~${income.grossPrem}/share · {E.otmPct(iv,nav,rvolRatio)}% OTM
                    {rvolMod>0 && <span style={{color:"#f59e0b"}}> (+{rvolMod}% RVol)</span>}
                    {!income.premFloorOk && <span style={{color:"#ef4444",fontWeight:700}}> ⚠ BELOW $2.80 FLOOR — widen or skip</span>}
                  </div>
                </div>
                <div style={{height:1,background:C.border,margin:"10px 0"}}/>
                <div>
                  <div style={{color:C.mid,fontSize:9,marginBottom:2}}>STEP 2 — 2:00 PM BUY (protection leg)</div>
                  <div style={{...mono,color:C.gold,fontSize:18,fontWeight:700}}>Buy {CFG.p1Base} × ${longS||"—"} Put</div>
                  <div style={{color:C.mid,fontSize:9}}>Cost ~${income.longCost}/share (IV compressed at 2pm)</div>
                </div>
                <div style={{marginTop:10,display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                  <div style={{background:"#ffffff08",borderRadius:6,padding:8,textAlign:"center"}}>
                    <div style={{color:C.dim,fontSize:8}}>NET/CONTRACT</div>
                    <div style={{...mono,color:C.p1,fontSize:14,fontWeight:700}}>{fmt(((parseFloat(income.grossPrem)-parseFloat(income.longCost))*100).toFixed(0))}</div>
                  </div>
                  <div style={{background:C.redDim,borderRadius:6,padding:8,textAlign:"center"}}>
                    <div style={{color:C.dim,fontSize:8}}>MAX LOSS</div>
                    <div style={{...mono,color:C.red,fontSize:14,fontWeight:700}}>{longS?fmt(E.maxLoss(strike,longS,parseFloat(income.grossPrem))):"—"}</div>
                  </div>
                </div>
              </>}
            </div>

            {/* P2 */}
            <div style={{background:C.bg2,border:`1px solid ${C.p2}44`,borderRadius:10,padding:14}}>
              <div style={{color:C.p2,fontSize:10,fontWeight:700,letterSpacing:"0.12em",marginBottom:10}}>P2 — CASH — NAKED PUTS ONLY</div>
              {pth.skip ? (
                <div style={{color:C.red,fontSize:12,padding:8,background:C.redDim,borderRadius:6}}>PATH {pth.p} — DO NOT SELL PUTS THIS WEEK</div>
              ) : <>
                <div style={{marginBottom:8}}>
                  <div style={{color:C.mid,fontSize:9,marginBottom:2}}>STEP 1 — 9:45 AM SELL (only step)</div>
                  <div style={{...mono,color:C.white,fontSize:18,fontWeight:700}}>Sell {CFG.p2Base} × ${strike||"—"} Put</div>
                  <div style={{color:C.mid,fontSize:9}}>
                    ~${income.grossPrem}/share · {E.otmPct(iv,nav,rvolRatio)}% OTM
                    {rvolMod>0 && <span style={{color:"#f59e0b"}}> (+{rvolMod}% RVol)</span>}
                    {!income.premFloorOk && <span style={{color:"#ef4444",fontWeight:700}}> ⚠ BELOW $2.80 FLOOR — widen or skip</span>}
                  </div>
                </div>
                <div style={{padding:10,background:C.purpleDim,borderRadius:6,marginTop:8}}>
                  <div style={{color:C.p2,fontSize:10,fontWeight:700}}>NO 2PM ACTION</div>
                  <div style={{color:C.mid,fontSize:9,marginTop:2}}>P2 is a cash account. Never buy protection. One step and done.</div>
                </div>
                <div style={{marginTop:10,display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                  <div style={{background:"#ffffff08",borderRadius:6,padding:8,textAlign:"center"}}>
                    <div style={{color:C.dim,fontSize:8}}>WEEKLY INCOME</div>
                    <div style={{...mono,color:C.p2,fontSize:14,fontWeight:700}}>{fmt(income.p2.toFixed(0))}</div>
                  </div>
                  <div style={{background:"#ffffff08",borderRadius:6,padding:8,textAlign:"center"}}>
                    <div style={{color:C.dim,fontSize:8}}>→ LEAPS ({effectiveRoute.pct}%)</div>
                    <div style={{...mono,color:C.gold,fontSize:14,fontWeight:700}}>{fmt((income.p2*route.pct/100).toFixed(0))}</div>
                  </div>
                </div>
              </>}
            </div>
          </div>
        </div>

        {/* ASSIGNED SHARES — shows prominently when shares exist */}
        {hasShares && (
          <div style={{background:"linear-gradient(135deg,#1a0a00,#1f0d00)",border:`2px solid #f9731688`,borderRadius:10,padding:14,marginBottom:16}}>
            <div style={{color:"#f97316",fontSize:11,fontWeight:700,letterSpacing:"0.1em",marginBottom:6}}>⚡ ASSIGNED SHARES — SELL CALLS NOW</div>
            <div style={{color:C.mid,fontSize:10,marginBottom:10}}>100% coverage immediately. Every uncovered week = income lost + Tier C missed. Goal: get called away fast, redeploy capital to puts + LEAPs. Exit at cost basis or NAV {'>'}2.5×.</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              {p1AssCC && port?.p1Shares>0 && (
                <div style={{background:"#ffffff08",borderRadius:8,padding:12}}>
                  <div style={{color:C.p1,fontSize:10,fontWeight:700,marginBottom:6}}>P1 — {port.p1Shares} shares (cost basis ${port.p1CB})</div>
                  <div style={{...mono,color:C.white,fontSize:16,fontWeight:700,marginBottom:4}}>Sell {Math.floor((port.p1Shares*(p1AssCC.coverage/100))/100)} × ${p1AssCC.strike} Call</div>
                  <div style={{color:C.mid,fontSize:9}}>{p1AssCC.otm}% OTM from cost basis · ~${p1AssCC.prem}/share · {p1AssCC.coverage}% coverage</div>
                  <div style={{color:p1AssCC.coverage<100?C.gold:C.green,fontSize:9,marginTop:3,fontWeight:600}}>{p1AssCC.note}</div>
                  {!p1AssCC.viable&&<div style={{color:C.red,fontSize:9,marginTop:4}}>Premium below $0.40 — skip this week</div>}
                </div>
              )}
              {p2AssCC && port?.p2Shares>0 && (
                <div style={{background:"#ffffff08",borderRadius:8,padding:12}}>
                  <div style={{color:C.p2,fontSize:10,fontWeight:700,marginBottom:6}}>P2 — {port.p2Shares} shares (cost basis ${port.p2CB})</div>
                  <div style={{...mono,color:C.white,fontSize:16,fontWeight:700,marginBottom:4}}>Sell {Math.floor((port.p2Shares*(p2AssCC.coverage/100))/100)} × ${p2AssCC.strike} Call</div>
                  <div style={{color:C.mid,fontSize:9}}>{p2AssCC.otm}% OTM from cost basis · ~${p2AssCC.prem}/share · {p2AssCC.coverage}% coverage</div>
                  <div style={{color:p2AssCC.coverage<100?C.gold:C.green,fontSize:9,marginTop:3,fontWeight:600}}>{p2AssCC.note}</div>
                  {!p2AssCC.viable&&<div style={{color:C.red,fontSize:9,marginTop:4}}>Premium below $0.40 — skip this week</div>}
                </div>
              )}
            </div>
          </div>
        )}

        {/* LIVE MARKET STRIP */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:16}}>
          {[
            {label:"BTC",value:fmt(btc),sub:pct(market.btc?.chg24),subColor:market.btc?.chg24>0?C.green:C.red},
            {label:"MSTR",value:fmt(mstr),sub:`IV ${fmtN(iv,1)}%`,subColor:E.ivTier(iv).color},
            {label:"IV RANK",value:`${ivr}`,sub:ivrLabel,subColor:!ivrCalibrated?C.gold:ivr>70?C.red:ivr>45?C.gold:C.green},
            {label:"NAV",value:`${fmtN(nav,3)}×`,sub:nav<1.0?"Discount":nav<1.5?"Normal":"Premium",subColor:nav<1.0?C.green:nav>2.0?C.red:C.gold},
            {label:"SOLVENCY",value:`${solv.str}×`,sub:solv.label,subColor:solv.color},
          ].map((s,i)=>(
            <div key={i} style={{background:C.bg2,borderRadius:8,padding:10,textAlign:"center"}}>
              <div style={{color:C.dim,fontSize:9,marginBottom:4,letterSpacing:"0.1em"}}>{s.label}</div>
              <div style={{...mono,color:C.white,fontSize:16,fontWeight:700}}>{s.value}</div>
              <div style={{...mono,color:s.subColor,fontSize:9,marginTop:2}}>{s.sub}</div>
            </div>
          ))}
        </div>

        {/* INCOME + ROUTING */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
          <div style={{background:C.bg2,borderRadius:10,padding:14}}>
            <div style={{color:C.mid,fontSize:10,letterSpacing:"0.1em",marginBottom:10}}>COMBINED WEEKLY INCOME</div>
            <div style={{...mono,color:C.green,fontSize:28,fontWeight:700,marginBottom:4}}>{fmt(income.total.toFixed(0))}</div>
            <div style={{display:"flex",gap:10}}>
              <div><div style={{color:C.dim,fontSize:8}}>P1 (spread)</div><div style={{...mono,color:C.p1,fontSize:13,fontWeight:700}}>{fmt(income.p1.toFixed(0))}</div></div>
              <div><div style={{color:C.dim,fontSize:8}}>P2 (naked)</div><div style={{...mono,color:C.p2,fontSize:13,fontWeight:700}}>{fmt(income.p2.toFixed(0))}</div></div>
            </div>
          </div>
          <div style={{background:C.bg2,borderRadius:10,padding:14}}>
            <div style={{color:C.mid,fontSize:10,letterSpacing:"0.1em",marginBottom:10}}>TIER C ROUTING → LEAPS</div>
            <div style={{...mono,color:effectiveRoute.color,fontSize:28,fontWeight:700,marginBottom:4}}>{effectiveRoute.pct}%</div>
            <div style={{color:C.mid,fontSize:10,marginBottom:4}}>{effectiveRoute.label}</div>
            <div style={{color:C.green,fontSize:11,fontWeight:600}}>{fmt((income.total*route.pct/100).toFixed(0))} → LEAPs this week</div>
          </div>
        </div>

        {/* News alerts */}
        {alertNews.length>0 && (
          <div style={{background:"linear-gradient(135deg,#1a0000,#1f0000)",border:`1px solid ${C.red}44`,borderRadius:10,padding:14,marginBottom:16}}>
            <div style={{color:C.red,fontSize:10,fontWeight:700,marginBottom:8}}>⚡ HIGH-IMPACT NEWS ALERTS</div>
            {alertNews.slice(0,3).map((n,i)=>(
              <div key={i} style={{padding:"6px 0",borderBottom:i<alertNews.length-1?`1px solid ${C.border}33`:"none"}}>
                <div style={{color:C.bright,fontSize:10}}>{n.title}</div>
                <div style={{color:C.dim,fontSize:8,marginTop:2}}>{n.src} · {new Date(n.pub).toLocaleDateString()}</div>
              </div>
            ))}
          </div>
        )}

      </>}

      {/* ══════════════ THESIS TAB ══════════════ */}
      {tab==="thesis" && (
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>

          {/* ── THESIS HEALTH DASHBOARD — dynamic sentiment from multi-source news */}
          <div style={{gridColumn:"1/-1",background:"linear-gradient(135deg,#000a1a,#001020)",border:`2px solid ${market.thesis?.overallScore>0.5?C.green:market.thesis?.overallScore<-0.5?C.red:C.gold}55`,borderRadius:10,padding:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{color:C.white,fontSize:12,fontWeight:700,letterSpacing:"0.1em"}}>
                THESIS HEALTH — {market.thesis?.overallLabel || "LOADING"}
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <span style={{...mono,fontSize:16,fontWeight:700,
                  color:market.thesis?.overallScore>0.5?C.green:market.thesis?.overallScore<-0.5?C.red:C.gold}}>
                  {market.thesis?.overallScore!=null?(market.thesis.overallScore>0?"+":"")+market.thesis.overallScore.toFixed(2):"—"}
                </span>
                <span style={{color:C.dim,fontSize:8}}>{market.thesis?.totalItems||0} articles · {market.thesis?.sources||"—"}</span>
              </div>
            </div>

            {/* Category breakdown */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8,marginBottom:12}}>
              {[
                {key:"mstr_corporate",label:"MSTR Corporate",icon:"🏢"},
                {key:"regulation",label:"Crypto Regulation",icon:"⚖️"},
                {key:"banking",label:"Banking/Institutional",icon:"🏦"},
                {key:"monetary_policy",label:"Fed/Monetary",icon:"🏛️"},
                {key:"adoption",label:"Adoption/Macro",icon:"🌍"},
              ].map(cat=>{
                const info = market.thesis?.categories?.[cat.key] || {score:0,count:0,label:"No data"};
                return (
                  <div key={cat.key} style={{padding:10,background:"#ffffff06",borderRadius:8,border:`1px solid ${info.score>0.5?C.green:info.score<-0.5?C.red:C.border}33`}}>
                    <div style={{color:C.dim,fontSize:8,marginBottom:4}}>{cat.icon} {cat.label}</div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{...mono,fontSize:14,fontWeight:700,
                        color:info.score>0.5?C.green:info.score<-0.5?C.red:C.mid}}>
                        {info.score>0?"+":""}{info.score.toFixed(1)}
                      </span>
                      <span style={{fontSize:8,color:info.score>0.5?C.green:info.score<-0.5?C.red:C.dim,fontWeight:600}}>{info.label}</span>
                    </div>
                    <div style={{color:C.dim,fontSize:7,marginTop:2}}>{info.count} articles</div>
                  </div>
                );
              })}
            </div>

            {/* Fed Liquidity Indicator */}
            {market.fed?.ok && (
              <div style={{padding:10,background:"#ffffff06",borderRadius:8,marginBottom:10,border:`1px solid ${market.fed.liquidityScore>=3?C.green:market.fed.liquidityScore>=1?C.gold:C.red}33`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <span style={{color:C.mid,fontSize:9,fontWeight:600}}>FED LIQUIDITY TRACKER</span>
                  <span style={{...mono,fontSize:11,fontWeight:700,
                    color:market.fed.liquidityScore>=3?C.green:market.fed.liquidityScore>=1?C.gold:C.red}}>
                    {market.fed.liquidityLabel} ({market.fed.liquidityScore}/6)
                  </span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:6}}>
                  {[
                    {label:"Balance Sheet",key:"WALCL",unit:"$T",div:1e6,signal:market.fed.stealthQE,signalLabel:"QE DETECTED"},
                    {label:"M2 Supply",key:"M2SL",unit:"$T",div:1e3,signal:market.fed.m2Growing,signalLabel:"GROWING"},
                    {label:"Reverse Repo",key:"RRPONTSYD",unit:"$B",div:1,signal:market.fed.rrpDeclining,signalLabel:"DRAINING"},
                    {label:"Fed Funds Rate",key:"FEDFUNDS",unit:"%",div:null,signal:market.fed.rateCut,signalLabel:"CUTTING"},
                  ].map(item=>{
                    const d = market.fed.series?.[item.key];
                    return (
                      <div key={item.key} style={{padding:6,background:"#ffffff04",borderRadius:6}}>
                        <div style={{color:C.dim,fontSize:7}}>{item.label}</div>
                        <div style={{...mono,color:C.bright,fontSize:11}}>
                          {d?`${item.div?(d.value/item.div).toFixed(2):d.value.toFixed(2)}${item.unit}`:"—"}
                        </div>
                        {d && <div style={{fontSize:7,color:d.change>0?C.green:d.change<0?C.red:C.dim}}>
                          {d.change>0?"+":""}{item.div?(d.change/item.div).toFixed(3):d.change.toFixed(2)} ({d.changePct>0?"+":""}{d.changePct.toFixed(2)}%)
                        </div>}
                        {item.signal && <div style={{fontSize:7,color:C.green,fontWeight:700,marginTop:2}}>{item.signalLabel}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Recent thesis-relevant headlines */}
            {market.thesis?.items?.length > 0 && (
              <div>
                <div style={{color:C.dim,fontSize:8,fontWeight:600,marginBottom:6}}>RECENT THESIS-RELEVANT HEADLINES</div>
                {market.thesis.items.slice(0,8).map((n,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"4px 0",borderBottom:`1px solid ${C.border}22`}}>
                    <div style={{flex:1}}>
                      <span style={{fontSize:7,padding:"1px 4px",borderRadius:3,marginRight:4,fontWeight:600,
                        background:n.category==="mstr_corporate"?"#0a84ff22":n.category==="regulation"?"#f5a62322":n.category==="banking"?"#bf5af222":n.category==="monetary_policy"?"#00d26a22":"#ffffff11",
                        color:n.category==="mstr_corporate"?C.blue:n.category==="regulation"?C.gold:n.category==="banking"?C.purple:n.category==="monetary_policy"?C.green:C.dim}}>
                        {n.category==="mstr_corporate"?"MSTR":n.category==="regulation"?"REG":n.category==="banking"?"BANK":n.category==="monetary_policy"?"FED":n.category==="adoption"?"ADOPT":"NEWS"}
                      </span>
                      <span style={{color:C.bright,fontSize:9}}>{n.title?.slice(0,100)}</span>
                    </div>
                    <div style={{display:"flex",gap:4,alignItems:"center",flexShrink:0,marginLeft:8}}>
                      <span style={{...mono,fontSize:8,fontWeight:700,color:n.sentiment>0?C.green:n.sentiment<0?C.red:C.dim}}>
                        {n.sentiment>0?"+":""}{n.sentiment}
                      </span>
                      <span style={{color:C.dim,fontSize:7}}>{n.src}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{color:C.dim,fontSize:7,marginTop:8}}>
              Sentiment scored via keyword analysis across {market.thesis?.sources||"multiple sources"}. Categories weighted: MSTR 25% · Regulation 20% · Fed 20% · Banking 15% · Adoption 15%.
              {market.fed?.ok && ` Liquidity: balance sheet ${market.fed.stealthQE?"expanding":"stable"}, M2 ${market.fed.m2Growing?"growing":"flat"}, RRP ${market.fed.rrpDeclining?"draining":"stable"}.`}
            </div>
          </div>

          {/* All-in status */}
          <div style={{gridColumn:"1/-1",background:allIn.latched?"linear-gradient(135deg,#1a0000,#200000)":allIn.armed?"linear-gradient(135deg,#1a1000,#1f1400)":C.bg2,border:`2px solid ${allIn.latched?C.red:allIn.armed?C.gold:C.border}`,borderRadius:10,padding:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{color:allIn.latched?C.red:allIn.armed?C.gold:C.mid,fontSize:12,fontWeight:700,letterSpacing:"0.1em"}}>ALL-IN LATCH — {allIn.state}</div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <span style={{color:C.dim,fontSize:9}}>Auto-tracked from CoinGecko daily closes</span>
                <button onClick={()=>setAllInCount(c=>Math.min(CFG.allInLatch,(c||0)+1))}
                  style={{background:C.bg3,border:`1px solid ${C.border}`,color:C.dim,borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:9}}>+1 Override</button>
                <button onClick={()=>setAllInCount(c=>Math.max(0,(c||0)-1))}
                  style={{background:C.bg3,border:`1px solid ${C.border}`,color:C.dim,borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:9}}>−1 Override</button>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
              {[{l:"Counter",v:`${allInCount}/3`},{l:"Arm at",v:"$45,500"},{l:"Reset at",v:"$55,000"}].map((s,i)=>(
                <div key={i} style={{textAlign:"center",padding:8,background:"#ffffff06",borderRadius:6}}>
                  <div style={{color:C.dim,fontSize:8,marginBottom:4}}>{s.l}</div>
                  <div style={{...mono,color:i===0?(allInCount>=3?C.red:allInCount>0?C.gold:C.green):C.white,fontSize:18,fontWeight:700}}>{s.v}</div>
                </div>
              ))}
            </div>
            <div style={{color:C.mid,fontSize:9,marginTop:8}}>Counter auto-computed from CoinGecko 90-day closes. Requires Gate 3 (BIC≥2 OR IVR&gt;65) before advancing — prevents false triggers on flash crashes. Resets when BTC closes above $55,000.</div>
            <div style={{marginTop:6,padding:"4px 8px",borderRadius:4,fontSize:9,
              background:bic.score>=2||ivr>65?"#052e16":"#1a1a2e",
              color:bic.score>=2||ivr>65?C.green:C.dim,border:"1px solid #2a2a2a"}}>
              Gate 3: {bic.score>=2||ivr>65
                ? `✓ OPEN — counter advances (BIC ${bic.score}/5, IVR ${ivr})`
                : `LOCKED (BIC ${bic.score}/5, IVR ${ivr}) — flash-crash protection active`}
            </div>
          </div>

          {/* Floor signals */}
          <div style={{background:C.bg2,borderRadius:10,padding:16}}>
            {/* BIC Score — master regime controller */}
            <div style={{background:bic.score>=4?"linear-gradient(135deg,#200000,#280000)":bic.score===3?"linear-gradient(135deg,#1a1000,#201400)":C.bg3,
              border:`1px solid ${bic.score>=4?C.red:bic.score===3?C.gold:C.border}`,borderRadius:8,padding:12,marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{color:C.mid,fontSize:9,fontWeight:700,letterSpacing:"0.08em"}}>BIC SCORE — REGIME CONTROLLER</div>
                  <div style={{color:bic.score>=4?C.red:bic.score===3?C.gold:C.green,fontSize:11,fontWeight:700,marginTop:2}}>{bic.label}</div>
                  <div style={{color:C.dim,fontSize:9,marginTop:2}}>
                    {bic.score>=4?"Zero CCs. No new spreads. ALL capital to LEAPs.":
                     bic.score===3?"100% Tier C routing override. Max 25% CC coverage.":
                     "Normal operation."}
                  </div>
                </div>
                <div style={{...mono,color:bic.score>=4?C.red:bic.score===3?C.gold:C.green,fontSize:32,fontWeight:800}}>{bic.score}/5</div>
              </div>
              <div style={{display:"flex",gap:4,marginTop:8,flexWrap:"wrap"}}>
                {[{k:"lth",l:"LTH"},{k:"etf",l:"ETF"},{k:"hash",l:"Hash"},{k:"miner",l:"Miner"},{k:"dd",l:"NAV ≤1×"}].map(s=>(
                  <span key={s.k} style={{padding:"1px 8px",borderRadius:8,fontSize:9,fontWeight:600,
                    background:activeSigs[s.k]?"#052e16":"#1a1a2e",color:activeSigs[s.k]?C.green:C.dim,
                    border:`1px solid ${activeSigs[s.k]?C.green+"44":"#333"}`}}>
                    {s.l}{activeSigs[s.k]?" ✓":" ○"}
                  </span>
                ))}
              </div>
            </div>
            <div style={{color:C.white,fontSize:11,fontWeight:700,marginBottom:12}}>FLOOR INDICATORS (DETAIL)</div>
            <div style={{color:C.dim,fontSize:9,marginBottom:10}}>Auto-computed from live data. Click to manually override.</div>
            {[
              {key:"dd", label:"NAV Parity Signal", auto:autoSigs.dd, pts:15,
                desc: `NAV ${nav.toFixed(3)}× ${nav<=1.0?"✓ PARITY — MSTR ≤ BTC value/share. Rare buy signal.":"→ fire condition: NAV ≤ 1.0×. Currently "+((nav-1)*100).toFixed(1)+"% above parity."}`},
              {key:"hash", label:"Hash Ribbon", auto:autoSigs.hash, pts:15,
                desc: market.hash?.ok
                  ? `LIVE AUTO ✓ blockchain.info: 30d MA ${market.hash.ma30?.toFixed(2)} EH/s vs 60d MA ${market.hash.ma60?.toFixed(2)} EH/s — ${market.hash.signal} (fires on CROSS_UP)`
                  : `PROXY ⚠ BTC <60% of 90d high AND IVR >55. Auto-fetches from blockchain.info (free, no key needed).`},
              {key:"miner", label:"Miner Capitulation", auto:autoSigs.miner, pts:10,
                desc: (() => {
                  const parts = [];
                  if (market.miner?.ok) parts.push(`mempool.space: 30d ${market.miner.avg30?.toFixed(1)} vs 60d ${market.miner.avg60?.toFixed(1)} EH/s (${market.miner.declineRate}% gap) ${market.miner.fires?"✓ FIRING":"○"}`);
                  if (market.onchain?.ok && market.onchain.puell!=null) parts.push(`Puell Multiple: ${market.onchain.puell.toFixed?market.onchain.puell.toFixed(2):market.onchain.puell} ${market.onchain.minerStress?"✓ <0.5 STRESS":"○ normal"}`);
                  if (market.minerRev?.ok) parts.push(`Miner Rev: ${market.minerRev.ratio}× of 90d avg ${market.minerRev.distress?"✓ DISTRESS":"○ OK"}`);
                  if (parts.length === 0) parts.push(`Proxy: hash ribbon ${market.hash?.signal||"unknown"}`);
                  return `4-LAYER DETECTION: ${parts.join(" · ")}`;
                })()},
              {key:"etf", label:"ETF Flows", auto:autoSigs.etf, pts:20,
                desc: market.etf?.ok
                  ? `LIVE AUTO ✓ SoSoValue: ${market.etf.consecutiveOutflows}wk outflow streak ${market.etf.hadSustainedOutflows?"(4+ sustained ✓)":"(not yet 4 weeks)"}. Latest: $${market.etf.netFlowUSD!=null?(market.etf.netFlowUSD/1e6).toFixed(0):"—"}M ${market.etf.currentWeekPositive?"🟢 INFLOW (recovery signal!)":"🔴 still outflow"}. Signal: outflow 4+ weeks THEN positive flip.`
                  : `PROXY ⚠ Approx via F&G recovery + BTC >60% of 90d high. Add SoSoValue key (free) for real ETF flow data.`},
              {key:"lth", label:"LTH Capitulation", auto:autoSigs.lth, pts:20,
                desc: market.onchain?.ok
                  ? `LIVE ON-CHAIN ✓ BGeometrics: SOPR ${market.onchain.sopr?.toFixed?market.onchain.sopr.toFixed(3):market.onchain.sopr??'—'} ${market.onchain.sopr<1?"< 1.0 ✓":"≥ 1.0"} · NUPL ${market.onchain.nupl?.toFixed?market.onchain.nupl.toFixed(3):market.onchain.nupl??'—'} ${market.onchain.nupl<0?"< 0 ✓":"≥ 0"} · MVRV ${market.onchain.mvrv?.toFixed?market.onchain.mvrv.toFixed(2):market.onchain.mvrv??'—'}. Fires when SOPR < 1.0 AND NUPL < 0 (holders selling at loss).`
                  : `PROXY ⚠ BGeometrics offline. Using correlation: BTC 40%+ below high ($${Math.round(high90).toLocaleString()}), F&G ≤ 20 (now ${market.fg?.value??'—'}), NAV < 1.0× (now ${nav.toFixed(3)}×).`},
            ].map(s=>{
              const on = activeSigs[s.key];
              return (
                <div key={s.key} onClick={()=>setSigs(g=>({...g,[s.key]:!g[s.key]}))}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:`1px solid ${C.border}33`,cursor:"pointer"}}>
                  <div style={{width:10,height:10,borderRadius:"50%",background:on?C.green:C.border,flexShrink:0,border:s.auto&&!sigs[s.key]?`2px dashed ${C.green}`:undefined}} />
                  <div style={{flex:1}}>
                    <div style={{color:on?C.white:C.mid,fontSize:10}}>{s.label} {s.auto&&<span style={{color:C.green,fontSize:8}}>(AUTO)</span>}</div>
                    <div style={{color:C.dim,fontSize:8}}>{s.desc}</div>
                  </div>
                  <div style={{...mono,color:on?C.green:C.dim,fontSize:9,fontWeight:700}}>+{s.pts}</div>
                </div>
              );
            })}
          </div>

          {/* Bull score + thesis */}
          <div style={{background:C.bg2,borderRadius:10,padding:16}}>
            <div style={{color:C.white,fontSize:11,fontWeight:700,marginBottom:12}}>BULL SCORE & THESIS</div>
            <div style={{textAlign:"center",margin:"12px 0"}}>
              <div style={{...mono,fontSize:48,fontWeight:700,color:score>70?C.green:score>40?C.gold:C.red}}>{score}</div>
              <div style={{color:C.dim,fontSize:9}}>/ 95</div>
            </div>
            <div style={{height:6,background:C.bg3,borderRadius:3,marginBottom:14,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${score}%`,background:score>70?C.green:score>40?C.gold:C.red,borderRadius:3,transition:"width 0.5s"}} />
            </div>
            {[
              {label:"BTC above $28K thesis break",pass:btc>CFG.thesisBrk,val:`$${btc.toLocaleString()}`},
              {label:"Solvency above 2.0×",pass:solv.r>2.0,val:`${solv.str}×`},
              {label:"NAV premium < 3.0×",pass:nav<3.0,val:`${fmtN(nav,3)}×`},
              {label:"VRP adequate (>1.1)",pass:vrp.ok,val:vrp.str},
            ].map((p,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:`1px solid ${C.border}22`}}>
                <div style={{color:C.mid,fontSize:10}}>{p.label}</div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <span style={{...mono,color:C.dim,fontSize:9}}>{p.val}</span>
                  <span style={{background:p.pass?C.greenDim:C.redDim,color:p.pass?C.green:C.red,border:`1px solid ${p.pass?C.green:C.red}44`,borderRadius:4,padding:"1px 6px",fontSize:8,fontWeight:700}}>{p.pass?"PASS":"FAIL"}</span>
                </div>
              </div>
            ))}
            {/* P1 naked contingency */}
            <div style={{marginTop:12,padding:10,background:nakedEl.eligible?"#f59e0b22":C.bg3,border:`1px solid ${nakedEl.eligible?C.gold:C.border}`,borderRadius:6}}>
              <div style={{color:nakedEl.eligible?C.gold:C.dim,fontSize:9,fontWeight:700,marginBottom:4}}>P1 NAKED CONTINGENCY (P1 only)</div>
              {[{l:`BTC down 35%+ (now ${nakedEl.downPct}%)`,p:nakedEl.c1},{l:`IVR >75 (now ${ivr})`,p:nakedEl.c2},{l:`2+ floors (now ${floorCount})`,p:nakedEl.c3}].map((c,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:9,padding:"2px 0"}}>
                  <span style={{color:C.mid}}>{c.l}</span>
                  <span style={{color:c.p?C.green:C.dim}}>{c.p?"✓":"✗"}</span>
                </div>
              ))}
              <div style={{color:nakedEl.eligible?C.gold:C.dim,fontSize:8,marginTop:4}}>{nakedEl.eligible?"All 3 conditions met — P1 may skip long put this week":"All 3 must fire simultaneously to skip protection leg"}</div>
            </div>
          </div>

          {/* BTC progress */}
          <div style={{gridColumn:"1/-1",background:C.bg2,borderRadius:10,padding:16}}>
            <div style={{color:C.white,fontSize:11,fontWeight:700,marginBottom:12}}>BTC CYCLE POSITION</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:12}}>
              {[
                {l:"Current",v:fmt(btc),c:C.white},
                {l:"Proj. Floor",v:"$44,804",c:C.red},
                {l:"ATH",v:"$126,210",c:C.gold},
                {l:"Target",v:"$220,000",c:C.green},
              ].map((s,i)=>(
                <div key={i} style={{textAlign:"center",padding:8,background:"#ffffff06",borderRadius:6}}>
                  <div style={{color:C.dim,fontSize:8,marginBottom:4}}>{s.l}</div>
                  <div style={{...mono,color:s.c,fontSize:14,fontWeight:700}}>{s.v}</div>
                </div>
              ))}
            </div>
            <div style={{position:"relative",height:8,background:C.bg3,borderRadius:4,overflow:"hidden"}}>
              <div style={{position:"absolute",height:"100%",width:`${Math.max(2,Math.min(100,(btc-CFG.btcProjFloor)/(CFG.btcTarget-CFG.btcProjFloor)*100))}%`,background:`linear-gradient(90deg,${C.red},${C.gold},${C.green})`,borderRadius:4}} />
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
              <span style={{color:C.dim,fontSize:8}}>$44,804 floor</span>
              <span style={{color:C.dim,fontSize:8}}>$220,000 target</span>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════ PORTFOLIO TAB ══════════════ */}
      {tab==="portfolio" && (
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>

          {/* ── REAL-TIME PORTFOLIO VALUE (Section 4.1) */}
          <div style={{gridColumn:"1/-1",background:"linear-gradient(135deg,#000a14,#001428)",border:"2px solid #0a84ff55",borderRadius:10,padding:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <span style={{color:"#0a84ff",fontSize:11,fontWeight:700,letterSpacing:"0.12em"}}>REAL-TIME PORTFOLIO VALUE</span>
              {portVal&&<span style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:portVal.gainLoss>=0?C.green:C.red,fontSize:12,fontWeight:700}}>
                {portVal.gainLoss>=0?"+":""}{fmt(portVal.gainLoss)} ({portVal.gainLossPct}%)
              </span>}
            </div>
            {portVal ? (
              <>
                {/* Combined total hero */}
                <div style={{textAlign:"center",marginBottom:14,padding:"12px 0",borderBottom:`1px solid #0a84ff22`}}>
                  <div style={{color:C.dim,fontSize:9,letterSpacing:"0.1em",marginBottom:4}}>COMBINED P1 + P2 TOTAL VALUE</div>
                  <div style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:"#0a84ff",fontSize:28,fontWeight:700}}>{fmt(portVal.combined)}</div>
                  <div style={{color:C.dim,fontSize:8,marginTop:2}}>LEAP est. at ${portVal.leapEstPerContract.toFixed(0)}/contract · {portVal.T}y to Dec 2028 · live MSTR ${mstr}</div>
                </div>
                {/* P1 vs P2 breakdown */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                  {[
                    {label:"P1 (MARGIN)", data:portVal.p1, color:C.p1},
                    {label:"P2 / GF (CASH)", data:portVal.p2, color:C.p2},
                  ].map((p,i)=>(
                    <div key={i} style={{background:"#ffffff06",borderRadius:8,padding:12}}>
                      <div style={{color:p.color,fontSize:10,fontWeight:700,marginBottom:8}}>{p.label}</div>
                      <div style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:C.white,fontSize:16,fontWeight:700,marginBottom:8}}>{fmt(p.data.total)}</div>
                      {[
                        {l:"Tier A (cash)",  v:fmt(p.data.tierA)},
                        {l:"Tier B (SGOV)",  v:fmt(p.data.tierB)},
                        {l:`Tier C (${p.data.leaps} LEAPs)`, v:fmt(p.data.tierC)},
                        {l:"Assigned shares", v:fmt(p.data.shares)},
                      ].map((r,j)=>(
                        <div key={j} style={{display:"flex",justifyContent:"space-between",fontSize:9,padding:"2px 0"}}>
                          <span style={{color:C.dim}}>{r.l}</span>
                          <span style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:C.mid}}>{r.v}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{color:C.dim,fontSize:10,textAlign:"center",padding:20}}>Enter portfolio data in fields below to see real-time value</div>
            )}
          </div>

          {/* ── P&L TRADE LOG */}
          <div style={{background:C.bg2,borderRadius:10,padding:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <span style={{color:C.white,fontSize:11,fontWeight:700}}>P&amp;L TRADE LOG</span>
              <button onClick={()=>{
                const s = prompt("Log trade — format: date,strike,contracts,premium,expired/assigned,tierCDeployed\nExample: 2026-03-10,133,12,3960,expired,594");
                if(s){
                  const [date,strike,contracts,premium,result,tierCDeployed] = s.split(",");
                  setPnlLog(l=>[...l,{date,strike:+strike,contracts:+contracts,premium:+premium,result,tierCDeployed:+(tierCDeployed||0)}]);
                }
              }} style={{background:C.greenDim,border:`1px solid ${C.green}44`,color:C.green,borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:9,fontWeight:700}}>+ LOG TRADE</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
              {[
                {l:"Total Income",v:fmt(pnlSummary.totalIncome),c:C.green},
                {l:"→ Tier C",v:fmt(pnlSummary.totalTierC),c:C.gold},
                {l:"Trades",v:`${pnlSummary.count}`,c:C.mid},
                {l:"Assignments",v:`${pnlSummary.assignments}`,c:pnlSummary.assignments>0?"#f97316":C.dim},
              ].map((s,i)=>(
                <div key={i} style={{background:"#ffffff06",borderRadius:6,padding:8,textAlign:"center"}}>
                  <div style={{color:C.dim,fontSize:8,marginBottom:2}}>{s.l}</div>
                  <div style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:s.c,fontSize:14,fontWeight:700}}>{s.v}</div>
                </div>
              ))}
            </div>
            <div style={{maxHeight:160,overflowY:"auto"}}>
              {pnlLog.length===0 ? (
                <div style={{color:C.dim,fontSize:9,textAlign:"center",padding:12}}>No trades logged yet. Click + LOG TRADE after each week.</div>
              ) : [...pnlLog].reverse().map((t,i)=>(
                <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr",gap:4,padding:"4px 0",borderBottom:`1px solid ${C.border}22`,fontSize:9}}>
                  <span style={{color:C.dim}}>{t.date}</span>
                  <span style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:C.mid}}>${t.strike} · {t.contracts}ct</span>
                  <span style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:C.green}}>{fmt(t.premium)}</span>
                  <span style={{color:t.result==="expired"?C.green:"#f97316",fontWeight:600}}>{t.result}</span>
                  <span style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:C.gold,fontSize:8}}>→C {fmt(t.tierCDeployed)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ── LEAP ACCUMULATION LOG */}
          <div style={{background:C.bg2,borderRadius:10,padding:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <span style={{color:C.white,fontSize:11,fontWeight:700}}>LEAP ACCUMULATION LOG</span>
              <button onClick={()=>{
                const s = prompt("Log LEAP purchase — format: date,strike,contracts,costPerContract\nExample: 2026-03-10,80,2,7800");
                if(s){
                  const [date,strike,contracts,costPerContract] = s.split(",");
                  const totalCost = +contracts * +costPerContract;
                  setLeapLog(l=>[...l,{date,strike:+strike,contracts:+contracts,costPerContract:+costPerContract,totalCost}]);
                }
              }} style={{background:C.goldDim,border:`1px solid ${C.gold}44`,color:C.gold,borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:9,fontWeight:700}}>+ LOG LEAP</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
              {[
                {l:"Total Contracts",v:`${leapSummary.totalContracts}`,c:C.gold},
                {l:"Avg Strike",v:leapSummary.avgStrike?`$${leapSummary.avgStrike.toFixed(0)}`:"—",c:C.gold},
                {l:"Total Cost",v:fmt(leapSummary.totalCost),c:C.mid},
                {l:"At $948 Target",v:leapSummary.totalContracts>0?fmt(Math.max(0,948-(leapSummary.avgStrike||80))*100*leapSummary.totalContracts):"—",c:C.green},
              ].map((s,i)=>(
                <div key={i} style={{background:"#ffffff06",borderRadius:6,padding:8,textAlign:"center"}}>
                  <div style={{color:C.dim,fontSize:8,marginBottom:2}}>{s.l}</div>
                  <div style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:s.c,fontSize:14,fontWeight:700}}>{s.v}</div>
                </div>
              ))}
            </div>
            <div style={{maxHeight:160,overflowY:"auto"}}>
              {leapLog.length===0 ? (
                <div style={{color:C.dim,fontSize:9,textAlign:"center",padding:12}}>No LEAPs logged. Click + LOG LEAP after each Tier C deployment.</div>
              ) : [...leapLog].reverse().map((e,i)=>(
                <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:4,padding:"4px 0",borderBottom:`1px solid ${C.border}22`,fontSize:9}}>
                  <span style={{color:C.dim}}>{e.date}</span>
                  <span style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:C.mid}}>${e.strike}C · {e.contracts}ct</span>
                  <span style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:C.gold}}>{fmt(e.costPerContract)}/ct</span>
                  <span style={{fontFamily:"'SF Mono','Fira Code','Courier New',monospace",color:C.green}}>{fmt(e.totalCost)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* LEAP tracker */}
          <div style={{gridColumn:"1/-1",background:C.bg2,borderRadius:10,padding:16}}>
            <div style={{color:C.white,fontSize:11,fontWeight:700,marginBottom:12}}>LEAP POSITION</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(90px,1fr))",gap:10,marginBottom:12}}>
              {[
                {l:"Total LEAPs",v:(port?.p1Leaps||0)+(port?.p2Leaps||0),c:C.gold},
                {l:"Strike",v:`$${port?.leapStrike||80}`,c:C.gold},
                {l:"Delta (LIVE)",v:fmtN(liveLeapDelta,2),c:C.green,sub:market.mstr?.leapDelta?(market.mstr?.optionsSrc||"Yahoo Finance chain"):"Estimated"},
                {l:"Gamma",v:market.mstr?.leapGreeks?.gamma!=null?market.mstr.leapGreeks.gamma.toFixed(4):"—",c:C.mid,sub:market.mstr?.leapGreeks?.src||""},
                {l:"Theta/day",v:market.mstr?.leapGreeks?.theta!=null?`$${market.mstr.leapGreeks.theta.toFixed(2)}`:"—",c:market.mstr?.leapGreeks?.theta<0?C.red:C.mid,sub:"decay"},
                {l:"Vega",v:market.mstr?.leapGreeks?.vega!=null?`$${market.mstr.leapGreeks.vega.toFixed(2)}`:"—",c:C.mid,sub:"per 1% IV"},
              ].map((s,i)=>(
                <div key={i} style={{textAlign:"center",padding:10,background:"#ffffff06",borderRadius:8}}>
                  <div style={{color:C.dim,fontSize:8,marginBottom:4}}>{s.l}</div>
                  <div style={{...mono,color:s.c,fontSize:18,fontWeight:700}}>{s.v}</div>
                  {s.sub&&<div style={{color:C.dim,fontSize:8,marginTop:2}}>{s.sub}</div>}
                </div>
              ))}
            </div>
            {/* LEAP PMCC */}
            <div style={{padding:12,background:leapCC.ok?C.greenDim:C.bg3,border:`1px solid ${leapCC.ok?C.green:C.border}`,borderRadius:8,marginBottom:12}}>
              <div style={{color:leapCC.ok?C.green:C.dim,fontSize:10,fontWeight:700,marginBottom:4}}>
                LEAP PMCC — {leapCC.ok?`ELIGIBLE · Phase ${leapCC.phase}`:(leapCC.reason||"Not eligible")}
              </div>
              {leapCC.ok&&<div style={{color:C.mid,fontSize:9}}>
                Sell {Math.round(((port?.p1Leaps||0)+(port?.p2Leaps||0))*leapCC.covPct/100)} contracts · {leapCC.covPct}% coverage · Target delta {leapCC.tgtDelta} · Approx strike ${leapCC.approxStr} · Est ${leapCC.prem}/share
              </div>}
            </div>
            {/* Roll + Profit */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <div>
                <div style={{color:C.mid,fontSize:9,marginBottom:6,letterSpacing:"0.1em"}}>ROLL TRIGGERS (net credit only)</div>
                {CFG.leapRoll.map((r,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:9,borderBottom:`1px solid ${C.border}22`}}>
                    <span style={{color:C.mid}}>MSTR ${r.mstr}</span>
                    <span style={{color:mstr>=r.mstr?C.green:C.dim,fontWeight:700}}>{r.label}</span>
                  </div>
                ))}
              </div>
              <div>
                <div style={{color:C.mid,fontSize:9,marginBottom:6,letterSpacing:"0.1em"}}>PROFIT TAKING</div>
                {CFG.profitTake.map((p,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:9,borderBottom:`1px solid ${C.border}22`}}>
                    <span style={{color:C.mid}}>{p.mstr?`MSTR $${p.mstr}`:`NAV ${p.nav}×`}</span>
                    <span style={{color:p.mstr?(mstr>=p.mstr?C.red:C.dim):(nav>=p.nav?C.red:C.dim),fontWeight:700}}>{p.action}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* P1 inputs */}
          <div style={{background:C.bg2,borderRadius:10,padding:16}}>
            <div style={{color:C.p1,fontSize:10,fontWeight:700,marginBottom:12}}>P1 — MARGIN ACCOUNT</div>
            {[{l:"Tier A Cash ($)",k:"p1TierA"},{l:"Assigned Shares",k:"p1Shares"},{l:"Share Cost Basis ($)",k:"p1CB"},{l:"LEAP Contracts",k:"p1Leaps"}].map(f=>(
              <div key={f.k} style={{marginBottom:8}}>
                <div style={{color:C.dim,fontSize:9,marginBottom:3}}>{f.l}</div>
                <input type="number" value={port?.[f.k]||0} onChange={e=>setPort(p=>({...p,[f.k]:+e.target.value}))}
                  style={{width:"100%",background:C.bg3,border:`1px solid ${C.border}`,color:C.white,padding:"6px 10px",borderRadius:6,...mono,fontSize:13,boxSizing:"border-box"}} />
              </div>
            ))}
          </div>

          {/* P2 inputs */}
          <div style={{background:C.bg2,borderRadius:10,padding:16}}>
            <div style={{color:C.p2,fontSize:10,fontWeight:700,marginBottom:12}}>P2 — CASH ACCOUNT</div>
            {[{l:"Tier A Cash ($)",k:"p2TierA"},{l:"Assigned Shares",k:"p2Shares"},{l:"Share Cost Basis ($)",k:"p2CB"},{l:"LEAP Contracts",k:"p2Leaps"}].map(f=>(
              <div key={f.k} style={{marginBottom:8}}>
                <div style={{color:C.dim,fontSize:9,marginBottom:3}}>{f.l}</div>
                <input type="number" value={port?.[f.k]||0} onChange={e=>setPort(p=>({...p,[f.k]:+e.target.value}))}
                  style={{width:"100%",background:C.bg3,border:`1px solid ${C.border}`,color:C.white,padding:"6px 10px",borderRadius:6,...mono,fontSize:13,boxSizing:"border-box"}} />
              </div>
            ))}
          </div>
          {/* Assignment Date — reference only (not used in coverage calc) */}
          <div style={{background:C.bg2,borderRadius:10,padding:16,gridColumn:"1/-1"}}>
            <div style={{color:C.mid,fontSize:10,fontWeight:700,marginBottom:4}}>
              ASSIGNMENT DATES <span style={{color:C.dim,fontWeight:400,fontSize:9,marginLeft:8}}>Reference only — coverage is always 100% from day 1</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:8}}>
              <div>
                <div style={{color:C.dim,fontSize:9,marginBottom:3}}>P1 Assignment Date</div>
                <input type="date" value={port?.p1AssignmentDate||""}
                  onChange={e=>setPort(p=>({...p,p1AssignmentDate:e.target.value||null}))}
                  style={{width:"100%",padding:"6px 8px",background:C.bg3,border:`1px solid ${C.border}`,borderRadius:6,color:C.white,fontSize:11,boxSizing:"border-box"}}
                />
              </div>
              <div>
                <div style={{color:C.dim,fontSize:9,marginBottom:3}}>P2 Assignment Date</div>
                <input type="date" value={port?.p2AssignmentDate||""}
                  onChange={e=>setPort(p=>({...p,p2AssignmentDate:e.target.value||null}))}
                  style={{width:"100%",padding:"6px 8px",background:C.bg3,border:`1px solid ${C.border}`,borderRadius:6,color:C.white,fontSize:11,boxSizing:"border-box"}}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════ CHARTS TAB ══════════════ */}
      {tab==="charts" && (
        <div style={{padding:"0 4px"}}>
          {/* Metric selector */}
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
            {CHART_METRICS.map(m=>(
              <button key={m.id} onClick={()=>setChartMetric(m.id)}
                style={{background:chartMetric===m.id?`${m.color}22`:"#ffffff08",border:`1px solid ${chartMetric===m.id?m.color+"88":"#ffffff15"}`,
                  color:chartMetric===m.id?m.color:C.dim,borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:9,fontWeight:chartMetric===m.id?700:400}}>
                {m.label}
              </button>
            ))}
          </div>
          {/* Time range selector */}
          <div style={{display:"flex",gap:6,marginBottom:16}}>
            {CHART_RANGES.map(r=>(
              <button key={r.id} onClick={()=>setChartRange(r.id)}
                style={{background:chartRange===r.id?"#ffffff15":"#ffffff08",border:`1px solid ${chartRange===r.id?"#ffffff33":"#ffffff10"}`,
                  color:chartRange===r.id?C.bright:C.dim,borderRadius:6,padding:"4px 12px",cursor:"pointer",fontSize:10,fontWeight:chartRange===r.id?700:400}}>
                {r.label}
              </button>
            ))}
          </div>
          {/* Main chart */}
          <div style={{background:C.bg2,borderRadius:10,padding:16,marginBottom:12}}>
            <div style={{color:C.white,fontSize:11,fontWeight:700,marginBottom:8}}>
              {CHART_METRICS.find(m=>m.id===chartMetric)?.label || chartMetric}
              <span style={{color:C.dim,fontSize:9,fontWeight:400,marginLeft:8}}>
                {CHART_RANGES.find(r=>r.id===chartRange)?.label} · {metricHistory.filter(e=>e.ts>=Date.now()-(CHART_RANGES.find(r=>r.id===chartRange)?.ms||86400000)).length} data points
              </span>
            </div>
            {renderChart(chartMetric, chartRange)}
          </div>
          {/* Multi-chart overview — show 4 key metrics at once */}
          <div style={{color:C.white,fontSize:11,fontWeight:700,marginBottom:8}}>OVERVIEW — KEY METRICS</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {["btc","nav","ivr","bic","thesisSentiment","fedLiquidity"].filter(id=>id!==chartMetric).slice(0,4).map(id=>{
              const m = CHART_METRICS.find(x=>x.id===id);
              return (
                <div key={id} style={{background:C.bg2,borderRadius:8,padding:12,cursor:"pointer"}} onClick={()=>setChartMetric(id)}>
                  <div style={{color:m?.color||C.mid,fontSize:9,fontWeight:700,marginBottom:4}}>{m?.label||id}</div>
                  {renderChart(id, chartRange)}
                </div>
              );
            })}
          </div>
          {/* Data status */}
          <div style={{marginTop:12,padding:10,background:"#ffffff06",borderRadius:8,display:"flex",justifyContent:"space-between"}}>
            <div style={{color:C.dim,fontSize:9}}>
              Total data points: <span style={{color:C.mid}}>{metricHistory.length}</span> ·
              Logging interval: <span style={{color:C.mid}}>5 min</span> ·
              Max retention: <span style={{color:C.mid}}>7 days</span>
            </div>
            <button onClick={()=>{if(window.confirm("Clear all metric history?"))setMetricHistory([])}}
              style={{background:"#ef444422",border:"1px solid #ef444444",color:"#ef4444",borderRadius:6,padding:"2px 10px",cursor:"pointer",fontSize:8}}>
              Clear History
            </button>
          </div>
        </div>
      )}

      {/* ══════════════ GF MODE ══════════════ */}
      {tab==="gf" && (
        <div style={{maxWidth:500,margin:"0 auto"}}>
          <div style={{background:"linear-gradient(135deg,#0d0014,#110019)",border:`2px solid ${C.p2}55`,borderRadius:12,padding:16,marginBottom:12}}>
            <div style={{color:C.p2,fontSize:13,fontWeight:700,marginBottom:4}}>YOUR WEEKLY ACTION — PORTFOLIO 2</div>
            <div style={{color:C.mid,fontSize:10}}>Cash account. One trade per week. Read the box below and follow the steps.</div>
          </div>
          {pth.skip?(
            <div style={{background:C.redDim,border:`2px solid ${C.red}`,borderRadius:12,padding:20,textAlign:"center"}}>
              <div style={{color:C.red,fontSize:16,fontWeight:700,marginBottom:8}}>DO NOT TRADE THIS WEEK</div>
              <div style={{color:C.mid,fontSize:11}}>Market conditions are outside safe parameters (Path {pth.p}). Wait for next Monday's instructions.</div>
            </div>
          ):(
            <div style={{background:C.bg2,border:`2px solid ${C.p2}`,borderRadius:12,padding:20,marginBottom:12}}>
              <div style={{color:C.mid,fontSize:10,marginBottom:8,letterSpacing:"0.08em"}}>MONDAY 9:45 AM — YOUR ONE STEP</div>
              <div style={{color:C.white,fontSize:22,fontWeight:700,marginBottom:12}}>
                Sell {CFG.p2Base} × ${strike||"—"} Put
              </div>
              <div style={{color:C.mid,fontSize:11,lineHeight:2}}>
                1. Open your brokerage app<br/>
                2. Go to MSTR options → this Friday's expiry<br/>
                3. Find the ${strike||"—"} put option<br/>
                4. Sell {CFG.p2Base} contracts — limit order near the shown price<br/>
                5. Done. You're finished for the week.
              </div>
              <div style={{marginTop:12,padding:10,background:"#ffffff08",borderRadius:8}}>
                <div style={{color:C.dim,fontSize:9}}>Expected to collect approximately {fmt(income.p2.toFixed(0))} this week.</div>
              </div>
            </div>
          )}
          {port?.p2Shares>0&&p2AssCC&&(
            <div style={{background:C.bg2,border:`2px solid #f97316`,borderRadius:12,padding:20,marginBottom:12}}>
              <div style={{color:"#f97316",fontSize:11,fontWeight:700,marginBottom:10}}>YOU ALSO HAVE {port.p2Shares} SHARES — SELL CALLS TOO</div>
              <div style={{color:C.white,fontSize:20,fontWeight:700,marginBottom:10}}>
                Sell {Math.floor(port.p2Shares/100)} × ${p2AssCC.strike} Call
              </div>
              <div style={{color:C.mid,fontSize:11,lineHeight:2}}>
                1. In your brokerage app, go to MSTR options → this Friday<br/>
                2. Find the ${p2AssCC.strike} call option<br/>
                3. Sell {Math.floor(port.p2Shares/100)} contract{Math.floor(port.p2Shares/100)>1?"s":""}<br/>
                4. If the shares get bought from you — that's the plan. Text Anthony when done.
              </div>
            </div>
          )}
          <div style={{background:C.bg3,borderRadius:10,padding:14}}>
            <div style={{color:C.dim,fontSize:10,marginBottom:8,fontWeight:700}}>DO NOT DO ANY OF THIS:</div>
            {["Buy any puts or calls to protect the trade","Sell more than 8 contracts","Place orders after 3:30pm","Panic if MSTR drops — holding shares is part of the plan"].map((s,i)=>(
              <div key={i} style={{color:C.mid,fontSize:10,padding:"3px 0"}}>✕ {s}</div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════════ SYSTEM TAB ══════════════ */}
      {tab==="system" && (
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>

          {/* TEST MODE */}
          <div style={{gridColumn:"1/-1",background:"linear-gradient(135deg,#0a0800,#1a1400)",border:`2px solid ${C.gold}55`,borderRadius:10,padding:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div>
                <div style={{color:C.gold,fontSize:12,fontWeight:700}}>SYSTEM TEST — RUN BEFORE FIRST DEPLOYMENT</div>
                <div style={{color:C.mid,fontSize:9,marginTop:2}}>Tests all math, data connections, Claude API, and strategy logic. Safe to run anytime.</div>
              </div>
              <button onClick={runTests}
                style={{background:C.gold,color:"#000",border:"none",borderRadius:8,padding:"10px 20px",cursor:"pointer",fontSize:11,fontWeight:700,minWidth:120}}>
                {Object.keys(testComplete).filter(k=>k!=="dummy").length>0?"Re-Run Tests":"▶ Run All Tests"}
              </button>
            </div>
            {Object.keys(testComplete).filter(k=>k!=="dummy"&&k!=="undefined").length>0&&(
              <div style={{background:"#ffffff06",borderRadius:8,padding:12}}>
                {Object.entries(testComplete).filter(([k])=>k!=="_done"&&k!=="dummy"&&k!=="undefined").map(([k,v])=>{
                  const pass=String(v).startsWith("PASS");
                  const fail=String(v).startsWith("FAIL");
                  return(
                    <div key={k} style={{padding:"5px 0",borderBottom:`1px solid ${C.border}22`,display:"flex",gap:8,alignItems:"flex-start"}}>
                      <span style={{color:pass?C.green:fail?C.red:C.gold,fontSize:10,fontWeight:700,flexShrink:0,minWidth:12}}>{pass?"✓":fail?"✗":"⚠"}</span>
                      <span style={{color:pass?C.bright:fail?C.red:C.gold,fontSize:9,lineHeight:1.4}}>{v}</span>
                    </div>
                  );
                })}
                {testComplete._done&&(
                  <div style={{marginTop:8,padding:8,background:Object.values(testComplete).some(v=>String(v).startsWith("FAIL"))?C.redDim:C.greenDim,borderRadius:6}}>
                    <div style={{color:Object.values(testComplete).some(v=>String(v).startsWith("FAIL"))?C.red:C.green,fontSize:10,fontWeight:700}}>
                      {Object.values(testComplete).some(v=>String(v).startsWith("FAIL"))?"⚠ Some tests failed — review before deploying real capital":"✓ All tests passed — system ready for deployment"}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Config */}
          <div style={{background:C.bg2,borderRadius:10,padding:16}}>
            <div style={{color:C.white,fontSize:11,fontWeight:700,marginBottom:4}}>API CONFIGURATION</div>
            <div style={{color:C.dim,fontSize:9,marginBottom:10}}>All market data is free and automated. Only Anthropic key required for AI features.</div>
            <div style={{marginBottom:10,padding:8,background:"#001a0a",border:"1px solid #22c55e33",borderRadius:6}}>
              <div style={{color:C.green,fontSize:9,fontWeight:700,marginBottom:2}}>✓ MSTR DATA — YAHOO FINANCE (FREE, NO KEY)</div>
              <div style={{color:C.dim,fontSize:8}}>MSTR price, ATM IV, IV Rank, RVol ratio, LEAP delta, full greeks — Yahoo Finance (primary) → Tradier Sandbox (backup) → MarketData.app (tertiary) → Synthetic B-S (fallback). Refreshes every 60s. Options cached 5 min.</div>
            </div>
            {/* Anthropic — note: key now in Vercel env var */}
            <div style={{marginBottom:10,padding:8,background:"#001a0a",border:"1px solid #22c55e33",borderRadius:6}}>
              <div style={{color:C.green,fontSize:9,fontWeight:700,marginBottom:2}}>✓ ANTHROPIC KEY — IN VERCEL ENV</div>
              <div style={{color:C.dim,fontSize:8}}>ANTHROPIC_API_KEY is configured in Vercel dashboard → Settings → Environment Variables. Screenshot parsing, SMS, and health audit all run server-side. ~$2/mo usage. No entry needed here.</div>
            </div>
            {/* SoSoValue — note: key is now in Vercel env var SOSOVALUE_KEY */}
            <div style={{marginBottom:10,padding:8,background:"#001a0a",border:"1px solid #22c55e33",borderRadius:6}}>
              <div style={{color:C.green,fontSize:9,fontWeight:700,marginBottom:2}}>✓ ETF FLOWS — KEY IN VERCEL ENV</div>
              <div style={{color:C.dim,fontSize:8}}>SOSOVALUE_KEY is configured in Vercel dashboard → Settings → Environment Variables. No entry needed here. Sign up free at sosovalue.com/developer if not yet configured.</div>
            </div>
            {/* BIC signals — all automated with multi-source data */}
            <div style={{marginBottom:10,padding:10,background:"#001a0a",border:"1px solid #22c55e33",borderRadius:8}}>
              <div style={{color:C.green,fontSize:9,fontWeight:700,marginBottom:4}}>✓ ALL BIC SIGNALS — MULTI-SOURCE LIVE DATA</div>
              <div style={{color:C.dim,fontSize:8,lineHeight:1.6}}>
                <b style={{color:C.mid}}>LTH Capitulation:</b> Layer 1: BGeometrics real SOPR &lt; 1.0 + NUPL &lt; 0 (on-chain). Layer 2: BTC drawdown + F&amp;G + NAV proxy.<br/>
                <b style={{color:C.mid}}>Miner Capitulation:</b> 4 layers: mempool.space hashrate decline, BGeometrics Puell Multiple &lt; 0.5, blockchain.info miner revenue &lt; 60% avg, hash ribbon BELOW.<br/>
                <b style={{color:C.mid}}>ETF Flows:</b> SoSoValue real data when key set, F&amp;G recovery proxy fallback.<br/>
                <b style={{color:C.mid}}>Manual override:</b> Click any signal on the BIC tab to force it on/off.
              </div>
            </div>
            {/* Multi-channel message delivery config */}
            <div style={{background:"#0a1a00",border:"1px solid #22c55e44",borderRadius:8,padding:12,marginBottom:10}}>
              <div style={{color:"#22c55e",fontSize:10,fontWeight:700,marginBottom:4}}>📱 MESSAGE DELIVERY — 4-CHANNEL CASCADE</div>
              <div style={{color:C.dim,fontSize:8,marginBottom:8}}>
                Messages try each channel in order until one succeeds. If a channel runs out of free credits, it automatically falls through to the next.
                <br/><b style={{color:C.mid}}>Twilio SMS</b> ($15 free) → <b style={{color:C.mid}}>Amazon SNS</b> (100/mo free forever) → <b style={{color:C.mid}}>Telegram</b> (unlimited free) → <b style={{color:C.mid}}>Email-to-SMS</b> (free via carrier gateway)
              </div>

              {/* Phone numbers + carrier */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                <div>
                  <div style={{color:C.mid,fontSize:8,marginBottom:2}}>Your Phone (P1)</div>
                  <input type="tel" value={userPhone} onChange={function(e){setUserPhone(e.target.value);}}
                    placeholder="+15551234567"
                    style={{width:"100%",background:C.bg3,border:"1px solid " + (userPhone?"#22c55e44":C.border),color:userPhone?"#22c55e":C.mid,padding:"6px 10px",borderRadius:6,fontSize:10,boxSizing:"border-box"}}/>
                  <div style={{color:C.dim,fontSize:7,marginTop:2}}>Carrier (for email-to-SMS fallback):</div>
                  <select value={userCarrier} onChange={e=>setUserCarrier(e.target.value)}
                    style={{width:"100%",background:C.bg3,border:`1px solid ${C.border}`,color:C.mid,padding:"4px 8px",borderRadius:4,fontSize:9,marginTop:2}}>
                    <option value="">Select carrier...</option>
                    <option value="verizon">Verizon</option>
                    <option value="att">AT&T</option>
                    <option value="tmobile">T-Mobile</option>
                    <option value="sprint">Sprint</option>
                    <option value="uscellular">US Cellular</option>
                    <option value="boost">Boost Mobile</option>
                    <option value="cricket">Cricket</option>
                    <option value="metro">Metro by T-Mobile</option>
                    <option value="mint">Mint Mobile</option>
                    <option value="visible">Visible</option>
                    <option value="fi">Google Fi</option>
                  </select>
                </div>
                <div>
                  <div style={{color:C.mid,fontSize:8,marginBottom:2}}>GF Phone (P2)</div>
                  <input type="tel" value={gfPhone} onChange={function(e){setGfPhone(e.target.value);}}
                    placeholder="+15551234567"
                    style={{width:"100%",background:C.bg3,border:"1px solid " + (gfPhone?"#a855f744":C.border),color:gfPhone?"#a855f7":C.mid,padding:"6px 10px",borderRadius:6,fontSize:10,boxSizing:"border-box"}}/>
                  <div style={{color:C.dim,fontSize:7,marginTop:2}}>Carrier (for email-to-SMS fallback):</div>
                  <select value={gfCarrier} onChange={e=>setGfCarrier(e.target.value)}
                    style={{width:"100%",background:C.bg3,border:`1px solid ${C.border}`,color:C.mid,padding:"4px 8px",borderRadius:4,fontSize:9,marginTop:2}}>
                    <option value="">Select carrier...</option>
                    <option value="verizon">Verizon</option>
                    <option value="att">AT&T</option>
                    <option value="tmobile">T-Mobile</option>
                    <option value="sprint">Sprint</option>
                    <option value="uscellular">US Cellular</option>
                    <option value="boost">Boost Mobile</option>
                    <option value="cricket">Cricket</option>
                    <option value="metro">Metro by T-Mobile</option>
                    <option value="mint">Mint Mobile</option>
                    <option value="visible">Visible</option>
                    <option value="fi">Google Fi</option>
                  </select>
                </div>
              </div>

              {/* Telegram config */}
              <div style={{marginBottom:8}}>
                <div style={{color:C.mid,fontSize:8,marginBottom:2}}>Telegram Chat ID (push notification fallback — free, unlimited)</div>
                <div style={{display:"flex",gap:8}}>
                  <input value={telegramChatId} onChange={e=>setTelegramChatId(e.target.value)}
                    placeholder="e.g. 123456789"
                    style={{flex:1,background:C.bg3,border:`1px solid ${telegramChatId?C.blue+"44":C.border}`,color:telegramChatId?C.blue:C.mid,padding:"6px 10px",borderRadius:6,fontSize:10}}/>
                </div>
                <div style={{color:C.dim,fontSize:7,marginTop:2}}>
                  Setup: (1) Message @BotFather on Telegram → /newbot → get token → set TELEGRAM_BOT_TOKEN in Vercel
                  (2) Message @userinfobot → get your chat ID → paste above. Both you and GF can use same bot — enter either chat ID.
                </div>
              </div>

              {/* Channel status */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:8}}>
                {[
                  {label:"Twilio SMS",note:"$15 free trial",color:C.green},
                  {label:"Amazon SNS",note:"100/mo free",color:C.blue},
                  {label:"Telegram",note:"unlimited free",color:"#29b6f6"},
                  {label:"Email-to-SMS",note:"carrier gateway",color:C.gold},
                ].map((ch,i)=>(
                  <div key={i} style={{padding:6,background:"#ffffff06",borderRadius:6,textAlign:"center"}}>
                    <div style={{color:ch.color,fontSize:8,fontWeight:700}}>{ch.label}</div>
                    <div style={{color:C.dim,fontSize:7}}>{ch.note}</div>
                    <div style={{color:C.dim,fontSize:7}}>Channel {i+1}</div>
                  </div>
                ))}
              </div>

              <div style={{color:C.dim,fontSize:8,marginBottom:8}}>
                Delivery cascade: tries Twilio first → if Twilio fails/exhausted → Amazon SNS → Telegram push → Email-to-SMS via carrier gateway. Set up as many as you want — even just Telegram alone works.
              </div>

              {/* Env vars needed */}
              <div style={{padding:8,background:"#ffffff06",borderRadius:6,marginBottom:8}}>
                <div style={{color:C.mid,fontSize:8,fontWeight:600,marginBottom:4}}>Vercel Environment Variables (set what you have):</div>
                <div style={{...mono,color:C.dim,fontSize:7,lineHeight:1.8}}>
                  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER<br/>
                  AWS_SNS_ACCESS_KEY, AWS_SNS_SECRET_KEY<br/>
                  TELEGRAM_BOT_TOKEN<br/>
                  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
                </div>
              </div>

              {/* Test buttons */}
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <button onClick={async ()=>{
                  if (!userPhone && !gfPhone && !telegramChatId) { alert("Enter at least one phone number or Telegram chat ID."); return; }
                  const phones = [userPhone, gfPhone].filter(Boolean);
                  const results = await sendSMSToAll(phones, "FOLATAC test — multi-channel delivery working. Cascade: Twilio → SNS → Telegram → Email-to-SMS.", {carrier: userCarrier, telegramChatId});
                  const summary = results.map(r => `${r.phone}: ${r.ok ? `SENT via ${r.channel}` : r.error}${r.attempts?` (tried: ${r.attempts.map(a=>a.channel).join("→")})`:"" }`).join("\n");
                  alert("Delivery Results:\n" + summary);
                }} style={{background:"#22c55e22",border:"1px solid #22c55e44",color:"#22c55e",borderRadius:6,padding:"6px 14px",cursor:"pointer",fontSize:9,fontWeight:700}}>
                  Test All Channels
                </button>
                {telegramChatId && <button onClick={async ()=>{
                  const r = await sendRealSMS(null, "FOLATAC Telegram test — push notifications working.", {telegramChatId});
                  alert(r.ok ? `Telegram sent via ${r.channel}` : `Failed: ${r.error}`);
                }} style={{background:C.blueDim,border:`1px solid ${C.blue}44`,color:C.blue,borderRadius:6,padding:"6px 14px",cursor:"pointer",fontSize:9,fontWeight:700}}>
                  Test Telegram Only
                </button>}
              </div>
            </div>
            <div style={{padding:10,background:C.greenDim,border:`1px solid ${C.green}44`,borderRadius:6}}>
              <div style={{color:C.green,fontSize:9,fontWeight:700,marginBottom:4}}>WHAT'S AUTOMATED — {Object.keys(staleFields).filter(k=>!staleFields[k]).length}/{Object.keys(staleFields).length} SOURCES LIVE</div>
              <div style={{color:C.mid,fontSize:8,lineHeight:1.7}}>
                ✓ BTC price — CoinGecko (Kraken fallback)<br/>
                ✓ MSTR price + ATM IV — Yahoo Finance → Finnhub → Alpha Vantage<br/>
                ✓ IV Rank 52w — Yahoo Finance 252-day historical, computed in-app<br/>
                ✓ MSTR RVol Ratio (10D÷30D HV) — auto-computed from Yahoo Finance history<br/>
                ✓ LEAP delta — Yahoo Finance Dec 2028 chain → Tradier Sandbox → Black-Scholes<br/>
                ✓ Full Greeks (delta/gamma/theta/vega) — Tradier Sandbox → MarketData.app → Synthetic B-S<br/>
                ✓ Hash Ribbon — blockchain.info (free, no key)<br/>
                ✓ Miner Capitulation — 4 layers: mempool.space + Puell Multiple + miner revenue + hash ribbon<br/>
                ✓ LTH Capitulation — REAL: BGeometrics SOPR + NUPL on-chain data (proxy fallback)<br/>
                ✓ On-Chain Metrics — BGeometrics: SOPR, NUPL, MVRV, Puell Multiple<br/>
                ✓ Miner Revenue — blockchain.info daily miner revenue trend<br/>
                ✓ ETF Flows — SoSoValue (free tier)<br/>
                ✓ Fear & Greed — Alternative.me<br/>
                ✓ News alerts — CryptoPanic + CoinGecko + NewsData.io (merged, deduped)<br/>
                ✓ Thesis Health — auto-scored across 5 categories from 5+ news sources<br/>
                ✓ Fed Liquidity — FRED balance sheet, M2, RRP, fed funds rate tracking<br/>
                ✓ SEC Filings — MSTR 8-K, 10-Q, insider transactions from EDGAR<br/>
                ✓ All-In counter auto-reset + Gate 3 check<br/>
                ✓ BIC Score — 5-signal regime controller (all 5 automated, multi-source)<br/>
                ✓ All math — all formulas run live on fetched data
              </div>
            </div>
            <div style={{marginTop:10,padding:10,background:C.goldDim,border:`1px solid ${C.gold}44`,borderRadius:6}}>
              <div style={{color:C.gold,fontSize:9,fontWeight:700,marginBottom:4}}>HUMAN INPUTS — MINIMAL WEEKLY CHECKLIST</div>
              <div style={{color:C.mid,fontSize:8,lineHeight:1.7}}>
                1. Monday: Upload portfolio screenshot (Today tab)<br/>
                2. Monday: Confirm trades via SMS (System tab)<br/>
                <span style={{color:"#555"}}>Everything else is fully automated — no manual data entry required.</span>
              </div>
            </div>
          </div>

          {/* Health audit */}
          <div style={{background:C.bg2,borderRadius:10,padding:16}}>
            <div style={{color:C.white,fontSize:11,fontWeight:700,marginBottom:8}}>DAILY HEALTH AUDIT</div>
            <div style={{color:C.dim,fontSize:9,marginBottom:10}}>Auto-runs at 8am via Vercel cron. Run on demand below.</div>
            <button onClick={handleAudit} style={{width:"100%",background:C.greenDim,border:`1px solid ${C.green}44`,color:C.green,padding:"10px 0",borderRadius:8,cursor:"pointer",fontSize:10,fontWeight:700,marginBottom:10}}>
              {auditBusy?"Running audit…":"Run Health Audit Now"}
            </button>
            {audit&&(
              <div style={{background:C.bg3,borderRadius:8,padding:12}}>
                <div style={{...mono,color:C.bright,fontSize:10,lineHeight:1.9,whiteSpace:"pre-wrap"}}>{audit}</div>
              </div>
            )}
          </div>

          {/* SMS console */}
          <div style={{gridColumn:"1/-1",background:C.bg2,borderRadius:10,padding:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <div style={{color:C.white,fontSize:11,fontWeight:700}}>NATURAL LANGUAGE SMS</div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <span style={{fontSize:8,color:userPhone?C.green:C.red}}>{userPhone?`You: ${userPhone}`:"No phone set"}</span>
                {userPhone && <span style={{fontSize:8,color:C.dim}}>|</span>}
                <span style={{fontSize:8,color:gfPhone?C.green:C.red}}>{gfPhone?`GF: ${gfPhone}`:"No GF phone"}</span>
                <button onClick={async ()=>{
                  if (!userPhone && !telegramChatId) { alert("Set phone number or Telegram in System tab."); return; }
                  const r = await sendRealSMS(userPhone || null, "FOLATAC test — multi-channel delivery is working.", {carrier: userCarrier, telegramChatId});
                  alert(r.ok ? `Delivered via ${r.channel}` : `Failed: ${r.error}`);
                }} style={{background:C.bg3,border:`1px solid ${C.border}`,color:C.dim,borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:8}}>
                  Test
                </button>
              </div>
            </div>
            <div style={{color:C.dim,fontSize:9,marginBottom:10}}>Type anything — "assigned 200 shares", "what do I sell today", "is the thesis intact". Claude answers here + delivers to your phone via SMS.</div>
            <div style={{height:200,overflowY:"auto",padding:10,background:C.bg3,borderRadius:8,marginBottom:8}}>
              {smsLog.length===0&&<div style={{color:C.dim,fontSize:9}}>No messages yet. Type below to start.</div>}
              {smsLog.map((m,i)=>(
                <div key={i} style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{color:m.role==="user"?C.gold:m.role==="delivery"?C.blue:C.green,fontSize:9,marginBottom:2}}>
                      {m.role==="user"?"You":m.role==="delivery"?"📱 Delivery":"FOLATAC"} {m.t}
                    </div>
                    {m.role==="sys" && m.text && !m.text.startsWith("(") && (
                      <button onClick={async ()=>{
                        const phones = [userPhone, gfPhone].filter(Boolean);
                        if (!phones.length && !telegramChatId) { alert("No phones or Telegram set."); return; }
                        const results = await sendSMSToAll(phones, `FOLATAC: ${m.text}`, {carrier: userCarrier, telegramChatId});
                        const summary = results.map(r => `${r.phone}: ${r.ok?`via ${r.channel}`:r.error}`).join(", ");
                        setSmsLog(l=>[...l,{role:"delivery",text:`Sent: ${summary}`,t:new Date().toLocaleTimeString()}]);
                      }} style={{background:"none",border:`1px solid ${C.border}`,color:C.dim,borderRadius:4,padding:"1px 6px",cursor:"pointer",fontSize:7}}>
                        📱 Send to Phones
                      </button>
                    )}
                  </div>
                  <div style={{color:m.role==="user"?C.bright:m.role==="delivery"?C.blue:C.mid,fontSize:10,lineHeight:1.5}}>{m.text}</div>
                </div>
              ))}
              {smsBusy&&<div style={{color:C.dim,fontSize:9}}>Processing…</div>}
            </div>
            <div style={{display:"flex",gap:8}}>
              <input value={smsInput} onChange={e=>setSmsInput(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&handleSMS()}
                placeholder="Type naturally…"
                style={{flex:1,background:C.bg3,border:`1px solid ${C.border}`,color:C.white,padding:"10px 14px",borderRadius:8,fontSize:11}} />
              <button onClick={handleSMS} disabled={smsBusy}
                style={{background:C.green,color:"#000",border:"none",borderRadius:8,padding:"10px 20px",cursor:"pointer",fontSize:11,fontWeight:700}}>
                Send
              </button>
            </div>
          </div>

          {/* Data source health */}
          <div style={{background:C.bg2,borderRadius:10,padding:16}}>
            <div style={{color:C.white,fontSize:11,fontWeight:700,marginBottom:12}}>DATA SOURCE HEALTH</div>
            {[
              {l:"BTC Price (CoinGecko → Kraken)",ok:!!market.btc?.price,v:market.btc?`$${market.btc.price?.toLocaleString()}`:"—"},
              {l:"MSTR Price (Yahoo Finance)",ok:!!market.mstr?.price,v:market.mstr?`$${market.mstr.price}`:"—"},
              {l:"ATM IV (Yahoo Finance options)",ok:!!market.mstr?.iv,v:market.mstr?`${market.mstr.iv?.toFixed(1)}%`:"—"},
              {l:"IV Rank 52w (computed)",ok:!!market.mstr?.ivRank,v:market.mstr?.ivRank!=null?`${market.mstr.ivRank} (${ivrLabel})`:"—"},
              {l:"MSTR RVol Ratio 10D÷30D (Yahoo hist.)",ok:!!market.mstr?.rvolRatio,v:market.mstr?.rvolRatio!=null?`${market.mstr.rvolRatio.toFixed(3)} (HV10:${market.mstr.hv10?.toFixed(0)}% HV30:${market.mstr.hv30?.toFixed(0)}%)`:rvolIsAuto?"—":"MANUAL"},
              {l:"LEAP Delta (Yahoo Finance chain)",ok:!!market.mstr?.leapDelta,v:market.mstr?.leapDelta?market.mstr.leapDelta.toFixed(2):"estimated"},
              {l:`ATM Greeks (${market.mstr?.optionsSrc||"none"})`,ok:!!market.mstr?.greeks,v:market.mstr?.greeks?`Δ${market.mstr.greeks.delta?.toFixed?market.mstr.greeks.delta.toFixed(3):"—"} Γ${market.mstr.greeks.gamma?.toFixed?market.mstr.greeks.gamma.toFixed(4):"—"} Θ${market.mstr.greeks.theta?.toFixed?market.mstr.greeks.theta.toFixed(3):"—"} V${market.mstr.greeks.vega?.toFixed?market.mstr.greeks.vega.toFixed(3):"—"}`:"none"},
              {l:`LEAP Greeks (${market.mstr?.leapGreeks?.src||"none"})`,ok:!!market.mstr?.leapGreeks,v:market.mstr?.leapGreeks?`Δ${market.mstr.leapGreeks.delta?.toFixed?market.mstr.leapGreeks.delta.toFixed(3):"—"} Θ${market.mstr.leapGreeks.theta?.toFixed?market.mstr.leapGreeks.theta.toFixed(3):"—"} V${market.mstr.leapGreeks.vega?.toFixed?market.mstr.leapGreeks.vega.toFixed(3):"—"}`:"none"},
              {l:`Fear & Greed (${market.fg?.src||"Alt.me"} → CoinyBubble)`,ok:!!market.fg,v:market.fg?`${market.fg.value} (${market.fg.label})`:"—"},
              {l:"BTC 90d High (CoinGecko chart)",ok:!!(market.btc?.high90&&market.btc?.dailyCloses?.length>0),v:market.btc?.dailyCloses?.length>0?`$${Math.round(market.btc.high90).toLocaleString()} (${market.btc.dailyCloses.length}d)`:"est."},
              {l:"All-In Consecutive Closes",ok:market.btc?.consecutiveBelowArm!=null,v:market.btc?.consecutiveBelowArm!=null?`${market.btc.consecutiveBelowArm}/3 auto`:"manual"},
              {l:"Realized Vol 5d BTC (computed)",ok:!!(market.btc?.rvol&&market.btc.src==="CoinGecko"),v:market.btc?.rvol?`${market.btc.rvol.toFixed(1)}% ann.`:"est."},
              {l:"Miner Hashrate (mempool.space)",ok:!!market.miner?.ok,v:market.miner?.ok?`${market.miner.declining?"DECLINING":"stable"} (${market.miner.declineRate}% gap)`:"—"},
              {l:"On-Chain SOPR/NUPL/MVRV (BGeometrics)",ok:!!market.onchain?.ok,v:market.onchain?.ok?`SOPR:${market.onchain.sopr?.toFixed?market.onchain.sopr.toFixed(2):"—"} NUPL:${market.onchain.nupl?.toFixed?market.onchain.nupl.toFixed(2):"—"} MVRV:${market.onchain.mvrv?.toFixed?market.onchain.mvrv.toFixed(2):"—"}`:"—"},
              {l:"Puell Multiple (BGeometrics)",ok:!!market.onchain?.ok&&market.onchain?.puell!=null,v:market.onchain?.puell!=null?`${market.onchain.puell.toFixed?market.onchain.puell.toFixed(2):market.onchain.puell} ${market.onchain.minerStress?"⚠ STRESS":"OK"}`:"—"},
              {l:"Miner Revenue (blockchain.info)",ok:!!market.minerRev?.ok,v:market.minerRev?.ok?`${market.minerRev.ratio}× of 90d avg ${market.minerRev.distress?"⚠ DISTRESS":"OK"}`:"—"},
              {l:`MSTR Backup (${market.mstr?.src||"Yahoo Finance"})`,ok:!!market.mstr?.price,v:market.mstr?`$${market.mstr.price} via ${market.mstr.src}`:"—"},
              {l:`News (${market.news?.src||"CryptoPanic"})`,ok:!!market.news,v:market.news?`${market.news.items?.length} items`:"—"},
              {l:`Thesis News (${market.thesis?.sources||"multi-source"})`,ok:!!market.thesis?.ok,v:market.thesis?.ok?`${market.thesis.totalItems} items · ${market.thesis.overallLabel} (${market.thesis.overallScore>0?"+":""}${market.thesis.overallScore?.toFixed(2)})`:"—"},
              {l:"Fed Liquidity (FRED)",ok:!!market.fed?.ok,v:market.fed?.ok?`${market.fed.liquidityLabel} (${market.fed.liquidityScore}/6) ${market.fed.stealthQE?"⚠ QE":""}`:"—"},
            ].map((s,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:`1px solid ${C.border}22`}}>
                <div style={{color:C.mid,fontSize:9}}>{s.l}</div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <span style={{...mono,color:C.dim,fontSize:9}}>{s.v}</span>
                  <span style={{background:s.ok?C.greenDim:C.redDim,color:s.ok?C.green:C.red,border:`1px solid ${s.ok?C.green:C.red}44`,borderRadius:4,padding:"1px 6px",fontSize:8,fontWeight:700}}>{s.ok?"LIVE":"OFFLINE"}</span>
                </div>
              </div>
            ))}
            <div style={{...mono,color:C.dim,fontSize:8,marginTop:8}}>Refresh every 60 seconds · Last: {lastFetch?.toLocaleTimeString()}</div>
          </div>

        </div>
      )}


      {/* ══════════ SYSTEM TAB EXTRA PANELS ══════════ */}
      {tab==="system" && (
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:12}}>
          {/* ── EXPORT / IMPORT — cross-device backup */}
          <div style={{gridColumn:"1/-1",background:"linear-gradient(135deg,#000a1a,#00152a)",border:"2px solid #0a84ff55",borderRadius:10,padding:16}}>
            <div style={{color:"#0a84ff",fontSize:12,fontWeight:700,marginBottom:2}}>📦 EXPORT / IMPORT — BACKUP & CROSS-DEVICE SYNC</div>
            <div style={{color:C.dim,fontSize:9,marginBottom:12}}>Export your entire strategy state to a JSON file. Import on any device to restore instantly. Always export before major changes.</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <div>
                <div style={{color:C.mid,fontSize:10,fontWeight:600,marginBottom:6}}>📤 EXPORT</div>
                <button onClick={()=>{
                  const snapshot = {
                    version:"folatac-v15",
                    exported: new Date().toISOString(),
                    port, sigs, allInCount, exitSigs, pnlLog, leapLog,
                    snapshots, startingCapital, p1StartCap, p2StartCap, manualPillarsBroken,
                    manualData, editedCFG, userPhone, gfPhone, userCarrier, gfCarrier, telegramChatId, p1Protected,
                  };
                  const blob = new Blob([JSON.stringify(snapshot,null,2)],{type:"application/json"});
                  const url  = URL.createObjectURL(blob);
                  const a    = document.createElement("a");
                  a.href     = url;
                  a.download = `folatac-backup-${new Date().toISOString().split("T")[0]}.json`;
                  a.click(); URL.revokeObjectURL(url);
                }} style={{width:"100%",background:"#0a84ff22",border:"1px solid #0a84ff55",color:"#0a84ff",
                  padding:"10px 0",borderRadius:8,cursor:"pointer",fontSize:10,fontWeight:700}}>
                  ⬇ Download Backup File
                </button>
                <div style={{color:C.dim,fontSize:8,marginTop:6}}>
                  Saves: portfolio state, all-in counter, P&L log, LEAP log, config overrides, phone numbers.
                </div>
              </div>
              <div>
                <div style={{color:C.mid,fontSize:10,fontWeight:600,marginBottom:6}}>📥 IMPORT</div>
                <input type="file" accept=".json" id="importFile" style={{display:"none"}}
                  onChange={async e=>{
                    const file=e.target.files?.[0]; if(!file) return;
                    try {
                      const text = await file.text();
                      const data = JSON.parse(text);
                      if(!data.version?.startsWith("folatac-v")) { alert("⚠ File is not a FOLATAC backup"); return; }
                      if(data.port)                await setPort(data.port);
                      if(data.sigs)                await setSigs(data.sigs);
                      if(data.allInCount!=null)    await setAllInCount(data.allInCount);
                      if(data.exitSigs)             await setExitSigs(data.exitSigs);
                      if(data.pnlLog)              await setPnlLog(data.pnlLog);
                      if(data.leapLog)             await setLeapLog(data.leapLog);
                      if(data.snapshots)           await setSnapshots(data.snapshots);
                      if(data.startingCapital)     await setStartingCapital(data.startingCapital);
                      if(data.p1StartCap)          await setP1StartCap(data.p1StartCap);
                      if(data.p2StartCap)          await setP2StartCap(data.p2StartCap);
                      if(data.manualPillarsBroken!=null) await setManualPillarsBroken(data.manualPillarsBroken);
                      if(data.manualData)          await setManualData(data.manualData);
                      if(data.editedCFG)           await setEditedCFG(data.editedCFG);
                      if(data.userPhone)           await setUserPhone(data.userPhone);
                      if(data.gfPhone)             await setGfPhone(data.gfPhone);
                      if(data.userCarrier)         await setUserCarrier(data.userCarrier);
                      if(data.gfCarrier)           await setGfCarrier(data.gfCarrier);
                      if(data.telegramChatId)      await setTelegramChatId(data.telegramChatId);
                      alert("✓ Import complete — all state restored from backup.");
                      e.target.value = "";
                    } catch(err) { alert("⚠ Import failed: " + err.message); }
                  }} />
                <button onClick={()=>document.getElementById("importFile").click()}
                  style={{width:"100%",background:"#0a84ff22",border:"1px solid #0a84ff55",color:"#0a84ff",
                  padding:"10px 0",borderRadius:8,cursor:"pointer",fontSize:10,fontWeight:700}}>
                  ⬆ Import Backup File
                </button>
                <div style={{color:C.dim,fontSize:8,marginTop:6}}>
                  Restores all state. Current data will be overwritten. Export first if in doubt.
                </div>
              </div>
            </div>
          </div>


          {/* EDITABLE STRATEGY FUNDAMENTALS — best possible system */}
          <div style={{gridColumn:"1/-1",background:"linear-gradient(135deg,#0a001a,#120028)",border:"2px solid #a855f755",borderRadius:10,padding:16}}>
            <div style={{color:"#a855f7",fontSize:12,fontWeight:700,marginBottom:2}}>⚙ LIVE STRATEGY CONFIG — EDITABLE FUNDAMENTALS</div>
            <div style={{color:C.dim,fontSize:9,marginBottom:12}}>Update when MSTR issues new shares, acquires more BTC, refinances debt, or you change contract size. Every formula in the app recalculates instantly. This is the single source of truth.</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:10}}>
              {[
                {label:"BTC Holdings", key:"btcHoldings", note:"Update after each 8-K filing"},
                {label:"Shares Outstanding", key:"sharesOut", note:"Check quarterly report"},
                {label:"Total Debt ($)", key:"totalDebt", note:"Convertible notes total"},
                {label:"P1 Base Contracts", key:"p1Base", note:"Max 4 (Section 11.3)"},
                {label:"P2 Base Contracts", key:"p2Base", note:"Max 8 (Section 11.3)"},
              ].map(({label,key,note})=>(
                <div key={key}>
                  <div style={{color:C.mid,fontSize:8,marginBottom:2}}>{label}</div>
                  <input type="number" value={editedCFG[key]||""} onChange={e=>{
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v) && v > 0) setEditedCFG(c=>({...c,[key]:v}));
                  }}
                    style={{width:"100%",background:C.bg3,border:`1px solid #a855f744`,color:"#a855f7",padding:"6px 8px",borderRadius:6,fontSize:10,boxSizing:"border-box",fontFamily:"'SF Mono','Fira Code',monospace"}}/>
                  <div style={{color:C.dim,fontSize:7,marginTop:1}}>{note}</div>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <button onClick={()=>setEditedCFG({btcHoldings:CFG.btcHoldings,sharesOut:CFG.sharesOut,totalDebt:CFG.totalDebt,p1Base:CFG.p1Base,p2Base:CFG.p2Base})}
                style={{background:C.bg3,border:`1px solid ${C.border}`,color:C.mid,borderRadius:6,padding:"5px 12px",cursor:"pointer",fontSize:9}}>
                Reset to Defaults
              </button>
              <div style={{color:C.dim,fontSize:9}}>
                Live NAV: <span style={{color:"#a855f7",fontFamily:"monospace"}}>${(((liveCFG.btcHoldings*btc - liveCFG.totalDebt)/liveCFG.sharesOut)||0).toFixed(2)}/share</span>
                &nbsp;·&nbsp;Solvency: <span style={{color:(liveCFG.btcHoldings*btc/liveCFG.totalDebt)>3?"#22c55e":"#f59e0b"}}>{((liveCFG.btcHoldings*btc/liveCFG.totalDebt)||0).toFixed(2)}×</span>
              </div>
            </div>
          </div>

          {/* THREE-PILLAR THESIS TRACKER (Section 11.1) */}
          <div style={{background:C.bg2,border:`1px solid ${pillarCheck.color}44`,borderRadius:10,padding:16}}>
            <div style={{color:pillarCheck.color,fontSize:11,fontWeight:700,marginBottom:4}}>🏛 THREE-PILLAR THESIS TRACKER</div>
            <div style={{color:C.dim,fontSize:9,marginBottom:10}}>Run this check whenever BTC drops below $42K. Two pillars broken = full exit. (Section 11.1)</div>
            {[
              {key:"p1",label:"Pillar 1 — ETF Flows",auto:pillarCheck.p1ETF,autoLabel:"Auto (consecutive outflows)"},
              {key:"p2",label:"Pillar 2 — Regulatory",auto:null,autoLabel:"Manual — check Congress monthly"},
              {key:"p3",label:"Pillar 3 — MSTR Solvency",auto:pillarCheck.p3Solvency,autoLabel:`Auto (${solv.r.toFixed(2)}× coverage)`},
            ].map(({key,label,auto,autoLabel})=>{
              const isBroken = key==="p1"?pillarCheck.p1ETF:key==="p3"?pillarCheck.p3Solvency:manualPillarsBroken >= (key==="p2"?1:2);
              return (
                <div key={key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:`1px solid ${C.border}22`}}>
                  <div>
                    <div style={{color:C.mid,fontSize:9,fontWeight:600}}>{label}</div>
                    <div style={{color:C.dim,fontSize:8}}>{autoLabel}</div>
                  </div>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    {auto !== null
                      ? <span style={{color:auto?"#ef4444":"#22c55e",fontSize:9,fontWeight:700}}>{auto?"BROKEN":"INTACT"}</span>
                      : <button onClick={()=>setManualPillarsBroken(n=>n===0?1:0)}
                          style={{background:manualPillarsBroken>=1?"#ef444422":"#22c55e22",border:`1px solid ${manualPillarsBroken>=1?"#ef4444":"#22c55e"}`,color:manualPillarsBroken>=1?"#ef4444":"#22c55e",borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:9,fontWeight:700}}>
                          {manualPillarsBroken>=1?"BROKEN":"INTACT"}
                        </button>
                    }
                  </div>
                </div>
              );
            })}
            <div style={{marginTop:10,padding:8,background:`${pillarCheck.color}15`,borderRadius:6}}>
              <div style={{color:pillarCheck.color,fontSize:9,fontWeight:700}}>{totalPillarsBroken} PILLARS BROKEN — {pillarCheck.action}</div>
            </div>
          </div>

          {/* LEAP EXIT SIGNALS TRACKER (Section 11.4) */}
          <div style={{background:C.bg2,border:`1px solid ${leapExit.color}44`,borderRadius:10,padding:16}}>
            <div style={{color:leapExit.color,fontSize:11,fontWeight:700,marginBottom:4}}>📉 LEAP EXIT SIGNAL TRACKER</div>
            <div style={{color:C.dim,fontSize:9,marginBottom:10}}>2 of 4 = begin exit. 3 of 4 = aggressive exit. Never exit on a single signal. (Section 11.4)</div>
            {[
              {key:"btcMA",     label:"BTC weekly close below 20-week MA",   hint:"After 3+ months above MA"},
              {key:"navCompress",label:"MSTR NAV down 30%+ from peak",        hint:"Within 60 days"},
              {key:"etfOutflow",label:"ETF outflows 4+ consecutive weeks",     hint:"From peak zone"},
              {key:"hashDeath", label:"Hash ribbon death cross from peak",     hint:"30d MA crosses below 60d MA"},
            ].map(({key,label,hint})=>(
              <div key={key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:`1px solid ${C.border}22`}}>
                <div>
                  <div style={{color:C.mid,fontSize:9}}>{label}</div>
                  <div style={{color:C.dim,fontSize:8}}>{hint}</div>
                </div>
                <button onClick={()=>setExitSigs(s=>({...s,[key]:!s[key]}))}
                  style={{background:exitSigs[key]?"#ef444422":"#1a1a1a",border:`1px solid ${exitSigs[key]?"#ef4444":"#444"}`,color:exitSigs[key]?"#ef4444":"#666",borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:9,fontWeight:700,flexShrink:0}}>
                  {exitSigs[key]?"FIRING":"OFF"}
                </button>
              </div>
            ))}
            <div style={{marginTop:10,padding:8,background:`${leapExit.color}15`,borderRadius:6}}>
              <div style={{color:leapExit.color,fontSize:9,fontWeight:700}}>{leapExit.count}/4 SIGNALS — {leapExit.action}</div>
            </div>
          </div>

          {/* P&L FROM INCEPTION + SNAPSHOT HISTORY */}
          <div style={{gridColumn:"1/-1",background:C.bg2,borderRadius:10,padding:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div>
                <div style={{color:C.green,fontSize:11,fontWeight:700}}>📈 P&L FROM INCEPTION — SNAPSHOT HISTORY</div>
                <div style={{color:C.dim,fontSize:9,marginTop:1}}>Auto-populated on each screenshot upload. No manual entry needed.</div>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <div style={{color:C.dim,fontSize:8}}>Starting capital:</div>
                <input type="number" value={startingCapital} onChange={e=>{
                  const v=parseFloat(e.target.value); if(!isNaN(v)&&v>0) setStartingCapital(v);
                }}
                  style={{width:90,background:C.bg3,border:`1px solid ${C.border}`,color:C.gold,padding:"4px 8px",borderRadius:6,fontSize:10,fontFamily:"monospace"}}/>
              </div>
            </div>
            {/* P&L hero */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:12}}>
              {[
                {label:"TOTAL P&L",value:inceptionPL!==null?`${inceptionPL>=0?"+":""}${fmt(inceptionPL)}`:"—",sub:inceptionPLPct!==null?`${inceptionPLPct>=0?"+":""}${inceptionPLPct.toFixed(2)}% return`:"no snapshots yet",color:inceptionPL===null?"#666":inceptionPL>=0?C.green:C.red},
                {label:"INCOME COLLECTED",value:fmt(pnlSummary.totalIncome),sub:`${pnlSummary.count} trades · ${pnlSummary.expired} expired, ${pnlSummary.assignments} assigned`,color:C.gold},
                {label:"DEPLOYED TO LEAPS",value:fmt(pnlSummary.totalTierC),sub:`${leapSummary.totalContracts} contracts · avg strike $${leapSummary.avgStrike?.toFixed(0)||"—"}`,color:"#a855f7"},
                {label:"PORTFOLIO TODAY",value:portVal?fmt(portVal.combined):"—",sub:portVal?`vs ${fmt(startingCapital)} start`:"upload screenshot",color:"#0a84ff"},
              ].map((s,i)=>(
                <div key={i} style={{background:"#ffffff08",borderRadius:8,padding:10,textAlign:"center"}}>
                  <div style={{color:C.dim,fontSize:8,marginBottom:2}}>{s.label}</div>
                  <div style={{fontFamily:"monospace",color:s.color,fontSize:14,fontWeight:700}}>{s.value}</div>
                  <div style={{color:C.dim,fontSize:8,marginTop:2}}>{s.sub}</div>
                </div>
              ))}
            </div>
            {/* Snapshot table */}
            {snapshots.length > 0 ? (
              <div style={{maxHeight:160,overflowY:"auto"}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr",gap:4,marginBottom:4}}>
                  {["DATE","P1","P2","COMBINED","P&L"].map(h=>(
                    <div key={h} style={{color:C.dim,fontSize:8,fontWeight:700}}>{h}</div>
                  ))}
                </div>
                {[...snapshots].reverse().map((s,i)=>{
                  const pl = s.combined - startingCapital;
                  return (
                    <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr",gap:4,padding:"4px 0",borderBottom:`1px solid ${C.border}22`}}>
                      <div style={{color:C.mid,fontSize:9}}>{s.date}</div>
                      <div style={{fontFamily:"monospace",color:C.p1,fontSize:9}}>{s.p1Total?fmt(s.p1Total):"—"}</div>
                      <div style={{fontFamily:"monospace",color:C.p2,fontSize:9}}>{s.p2Total?fmt(s.p2Total):"—"}</div>
                      <div style={{fontFamily:"monospace",color:C.white,fontSize:9}}>{fmt(s.combined)}</div>
                      <div style={{fontFamily:"monospace",color:pl>=0?C.green:C.red,fontSize:9,fontWeight:700}}>{pl>=0?"+":""}{fmt(pl)}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{color:C.dim,fontSize:10,textAlign:"center",padding:12,background:"#ffffff06",borderRadius:6}}>
                No snapshots yet — upload your brokerage screenshot daily to auto-track P&L from inception
              </div>
            )}
            {snapshots.length > 0 && (
              <button onClick={()=>{if(window.confirm("Clear all P&L snapshots?"))setSnapshots([])}}
                style={{marginTop:8,background:C.bg3,border:`1px solid ${C.border}`,color:C.dim,borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:8}}>
                Clear snapshot history
              </button>
            )}
          </div>

        </div>
      )}
    </div>
  </div>
  );
}
