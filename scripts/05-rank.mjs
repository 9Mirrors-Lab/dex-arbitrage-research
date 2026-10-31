// STEPS 2, 3 and 4 - rank what the forensics actually found.
//
// Aggregates every forensics window into:
//   - DEX combinations ranked by observed arbitrage (Step 2)
//   - token pairs / cycles ranked by observed arbitrage (Step 3)
//   - funding methods actually used (Step 4)
//   - operator concentration and repeat behaviour (competition evidence)
//
// Reports per-window block coverage so a window with degraded RPC collection
// cannot quietly skew the totals.
//
//   node scripts/05-rank.mjs --chain base --files data/forensics-base-A.json,...

import { writeFileSync, readFileSync } from 'node:fs';
import { loadChain } from '../lib/rpc.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const cfg = loadChain(args.chain ?? 'base');
const files = String(args.files).split(',').map((s) => s.trim()).filter(Boolean);

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))];
};
const stats = (arr) => ({
  n: arr.length,
  sum: +arr.reduce((a, b) => a + b, 0).toFixed(4),
  max: arr.length ? +Math.max(...arr).toFixed(4) : null,
  p90: arr.length ? +pct(arr, 90).toFixed(4) : null,
  median: arr.length ? +pct(arr, 50).toFixed(4) : null,
  min: arr.length ? +Math.min(...arr).toFixed(5) : null,
});

const windows = [];
const arbs = [];
for (const f of files) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const blocksSeen = new Set(d.arbs.map((a) => a.block));
  windows.push({
    file: f, window: d.window, counts: d.counts,
    blocksWithArbs: blocksSeen.size,
    // A window where far fewer blocks produced data than it spans had
    // degraded collection; flag it instead of averaging it in silently.
    coverageNote: d.counts.multiSwapTxs / d.window.blocks < 5
      ? `low yield (${(d.counts.multiSwapTxs / d.window.blocks).toFixed(1)} multi-swap tx/block vs ~10 typical) - likely partial RPC collection, treat counts from this window as a floor`
      : null,
  });
  for (const a of d.arbs) arbs.push({ ...a, _file: f });
}

const totalBlocks = windows.reduce((a, w) => a + w.window.blocks, 0);
const totalChainMin = windows.reduce((a, w) => a + w.window.chainMinutes, 0);

// ---- Step 2: DEX combinations -------------------------------------------
const byCombo = {};
for (const a of arbs) {
  const k = a.venueCombo;
  byCombo[k] ??= { combo: k, count: 0, nets: [], grosses: [], costs: [], pairs: new Set(), operators: new Set(), sameVenue: false };
  const r = byCombo[k];
  r.count++;
  if (a.netProfitUsd != null) r.nets.push(a.netProfitUsd);
  if (a.grossProfitUsd != null) r.grosses.push(a.grossProfitUsd);
  if (a.costUsd != null) r.costs.push(a.costUsd);
  r.pairs.add([...a.cycleTokens].sort().join('/'));
  r.operators.add(a.operatorContract);
  r.sameVenue = !k.includes(' + ');
}
const comboRanked = Object.values(byCombo).map((r) => ({
  combo: r.combo,
  sameVenueOnly: r.sameVenue,
  arbTxCount: r.count,
  sharePct: +((r.count / arbs.length) * 100).toFixed(1),
  netUsd: stats(r.nets),
  costUsd: stats(r.costs),
  distinctCycles: r.pairs.size,
  distinctOperatorContracts: r.operators.size,
})).sort((a, b) => b.arbTxCount - a.arbTxCount);

// ---- Step 3: token cycles ----------------------------------------------
const byCycle = {};
for (const a of arbs) {
  const k = [...new Set(a.cycleTokens)].sort().join(' / ');
  byCycle[k] ??= { cycle: k, count: 0, nets: [], combos: new Set(), operators: new Set(), blocks: new Set() };
  const r = byCycle[k];
  r.count++;
  if (a.netProfitUsd != null) r.nets.push(a.netProfitUsd);
  r.combos.add(a.venueCombo);
  r.operators.add(a.operatorContract);
  r.blocks.add(a.block);
}
const cycleRanked = Object.values(byCycle).map((r) => ({
  cycle: r.cycle,
  arbTxCount: r.count,
  netUsd: stats(r.nets),
  distinctVenueCombos: r.combos.size,
  venueCombos: [...r.combos].slice(0, 4),
  distinctOperators: r.operators.size,
  distinctBlocks: r.blocks.size,
  repeats: r.count > r.blocks.size ? 'multiple arbs on this cycle within one block' : 'at most one per block',
})).sort((a, b) => (b.netUsd.sum ?? 0) - (a.netUsd.sum ?? 0));

// ---- Step 4: funding ----------------------------------------------------
const byFunding = {};
for (const a of arbs) {
  const k = a.funding.join('+');
  byFunding[k] ??= { funding: k, count: 0, nets: [], sizes: [] };
  byFunding[k].count++;
  if (a.netProfitUsd != null) byFunding[k].nets.push(a.netProfitUsd);
}
const fundingRanked = Object.values(byFunding).map((r) => ({
  fundingObserved: r.funding, arbTxCount: r.count,
  sharePct: +((r.count / arbs.length) * 100).toFixed(1),
  netUsd: stats(r.nets),
})).sort((a, b) => b.arbTxCount - a.arbTxCount);

// ---- competition --------------------------------------------------------
const byOperator = {};
for (const a of arbs) {
  byOperator[a.operatorContract] ??= { contract: a.operatorContract, eoas: new Set(), count: 0, nets: [], combos: new Set(), cycles: new Set() };
  const r = byOperator[a.operatorContract];
  r.count++; r.eoas.add(a.operatorEoa);
  if (a.netProfitUsd != null) r.nets.push(a.netProfitUsd);
  r.combos.add(a.venueCombo); r.cycles.add([...a.cycleTokens].sort().join('/'));
}
const operatorRanked = Object.values(byOperator).map((r) => ({
  contract: r.contract, distinctEoas: r.eoas.size, arbTxCount: r.count,
  netUsd: stats(r.nets), distinctVenueCombos: r.combos.size, distinctCycles: r.cycles.size,
})).sort((a, b) => b.arbTxCount - a.arbTxCount);

const allNets = arbs.map((a) => a.netProfitUsd).filter((v) => v != null);
const allCosts = arbs.map((a) => a.costUsd).filter((v) => v != null);
const l1Shares = arbs.map((a) => a.l1ShareOfCost).filter((v) => v != null);
const gas = arbs.map((a) => a.gasUsed);

const out = {
  chain: cfg.id, measuredAt: new Date().toISOString(),
  coverage: {
    windows, totalBlocksScanned: totalBlocks,
    totalChainMinutes: +totalChainMin.toFixed(1),
    spreadNote: 'four windows spread across roughly 24 hours of Base history, so the result is not a single moment',
    totalArbTxDetected: arbs.length,
    arbTxPerBlock: +(arbs.length / totalBlocks).toFixed(2),
  },
  economics: {
    netUsdPerArb: stats(allNets),
    executionCostUsdPerArb: stats(allCosts),
    gasUsedPerArb: { median: pct(gas, 50), p90: pct(gas, 90), max: Math.max(...gas) },
    l1DataFeeShareOfCost: { median: +pct(l1Shares, 50).toFixed(4), p90: +pct(l1Shares, 90).toFixed(4) },
    netAboveUsd: {
      '0': allNets.filter((v) => v > 0).length,
      '0.10': allNets.filter((v) => v > 0.1).length,
      '1': allNets.filter((v) => v > 1).length,
      '5': allNets.filter((v) => v > 5).length,
      '25': allNets.filter((v) => v > 25).length,
    },
    totalNetUsdAcrossAllOperators: +allNets.reduce((a, b) => a + b, 0).toFixed(2),
    impliedDailyNetUsdAllOperators: +((allNets.reduce((a, b) => a + b, 0) / totalChainMin) * 1440).toFixed(2),
    impliedDailyNote: 'extrapolated from the sampled minutes to 24h; an extrapolation, not a measurement, and it is the total across EVERY operator on the chain, not a share we could win',
  },
  step2_dexCombinations: comboRanked,
  step3_tokenCycles: cycleRanked.slice(0, 30),
  step4_fundingObserved: fundingRanked,
  competition: {
    distinctOperatorContracts: operatorRanked.length,
    top15: operatorRanked.slice(0, 15),
    concentration: {
      top1SharePct: +((operatorRanked[0]?.arbTxCount ?? 0) / arbs.length * 100).toFixed(1),
      top5SharePct: +(operatorRanked.slice(0, 5).reduce((a, r) => a + r.arbTxCount, 0) / arbs.length * 100).toFixed(1),
    },
  },
};

const path = new URL(`../data/ranking-${cfg.id}.json`, import.meta.url);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ coverage: out.coverage, economics: out.economics }, null, 2));
console.log('\n--- Step 2: DEX combinations ---');
for (const c of comboRanked.slice(0, 14)) console.log(`${String(c.arbTxCount).padStart(4)} (${String(c.sharePct).padStart(4)}%)  net sum $${String(c.netUsd.sum).padStart(9)}  median $${String(c.netUsd.median).padStart(8)}  ops ${String(c.distinctOperatorContracts).padStart(3)}  ${c.combo}`);
console.log('\n--- Step 3: top cycles by total net ---');
for (const c of cycleRanked.slice(0, 14)) console.log(`${String(c.arbTxCount).padStart(4)}x  net sum $${String(c.netUsd.sum).padStart(9)}  max $${String(c.netUsd.max).padStart(8)}  ops ${String(c.distinctOperators).padStart(2)}  ${c.cycle}`);
console.log('\n--- Step 4: funding observed ---');
for (const f of fundingRanked) console.log(`${String(f.arbTxCount).padStart(4)} (${String(f.sharePct).padStart(4)}%)  net sum $${String(f.netUsd.sum).padStart(9)}  ${f.fundingObserved}`);
console.log('\n--- competition ---');
console.log(`${out.competition.distinctOperatorContracts} distinct operator contracts; top1 ${out.competition.concentration.top1SharePct}%, top5 ${out.competition.concentration.top5SharePct}%`);
for (const o of operatorRanked.slice(0, 8)) console.log(`  ${o.contract} ${String(o.arbTxCount).padStart(4)}x net $${String(o.netUsd.sum).padStart(9)} cycles ${o.distinctCycles} combos ${o.distinctVenueCombos}`);
console.error(`\nwrote ${path.pathname}`);
