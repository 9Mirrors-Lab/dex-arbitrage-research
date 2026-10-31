// Phase B — Market-wide pool and token discovery.
//
//   node scripts/22-discover-pools.mjs --chain base --sweep-blocks 20000
//
// Flags
//   --sweep-blocks N   blocks of Swap-log history to sweep (100-block windows)
//   --max-enum N       cap per-factory array enumeration (default 60000; the
//                      Uniswap V2 factory alone holds 3.07M mostly-spam pairs,
//                      so the default deliberately defers it — see --mega)
//   --mega             enumerate even factories above the cap, in full
//   --min-depth USD    eligibility threshold (default 500)
//   --block N          snapshot state at a specific block (default latest)
//   --no-complete      skip cross-venue completion
//   --reset            start a fresh registry
//
// Every stage is incremental and cursored, so re-running extends the registry.

import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Rpc, loadChain } from '../lib/rpc.mjs';
import { Multicall } from '../lib/multicall.mjs';
import { PoolRegistry, pairKey } from '../lib/poolregistry.mjs';
import {
  enumerateFactory, sweepSwapLogs, resolvePoolIdentity, attributeVenues,
  buildCompletionProbes, runCompletionProbes, resolveTokens, isAddr,
} from '../lib/discovery.mjs';
import { snapshotState, buildScreeningPrices, applyEligibility } from '../lib/marketstate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);

const chainId = argOf('chain', 'base');
const sweepBlocks = Number(argOf('sweep-blocks', 20000));
const maxEnum = Number(argOf('max-enum', 60000));
const minDepthUsd = Number(argOf('min-depth', 500));
const doComplete = !flag('no-complete');

const cfg = loadChain(chainId);
const rpc = new Rpc(cfg.rpc, { concurrency: 10 });
const mc = new Multicall(rpc, cfg.multicall3, { batch: 500, parallel: 6 });

if (flag('reset')) {
  for (const f of [`pools-${chainId}.json`, `tokens-${chainId}.json`, `meta-${chainId}.json`]) {
    const p = join(ROOT, 'data', 'market', f);
    if (existsSync(p)) rmSync(p);
  }
}

const reg = new PoolRegistry(chainId);
const enumPath = join(ROOT, 'data', `enumeration-${chainId}.json`);
const enumeration = existsSync(enumPath) ? JSON.parse(readFileSync(enumPath, 'utf8')) : null;
if (!enumeration) {
  console.error(`missing data/enumeration-${chainId}.json — run scripts/20-enumeration-probe.mjs --chain ${chainId} first`);
  process.exit(1);
}

const t0 = Date.now();
const say = (s) => console.log(s);
const progress = (s) => process.stdout.write(`\r${s.padEnd(100)}`);
const endProgress = () => process.stdout.write('\n');

const head = await rpc.blockNumber();
const snapshotBlock = argOf('block') ? Number(argOf('block')) : head;
say(`\n=== Phase B discovery — ${cfg.name} — head ${head}, snapshot block ${snapshotBlock} ===\n`);

const runLog = { chain: chainId, startedAt: new Date().toISOString(), head, snapshotBlock, stages: {} };

// ---------------------------------------------------------------------------
// Stage 1 — exhaustive enumeration of factories with an on-chain array
// ---------------------------------------------------------------------------
say('[1/7] factory array enumeration');
const deferred = [];
for (const [key, f] of Object.entries(enumeration.factories)) {
  if (!f.enumerable || !f.poolCount) continue;
  const dex = { ...cfg.dexes[key], enumMethod: f.enumMethod };
  const cursor = reg.cursor(`enum:${key}`, 0);
  const remaining = f.poolCount - cursor;
  if (remaining <= 0) { say(`  ${key.padEnd(18)} already complete (${f.poolCount})`); continue; }
  if (f.poolCount > maxEnum && !flag('mega')) {
    deferred.push({ key, count: f.poolCount, enumerated: cursor });
    say(`  ${key.padEnd(18)} DEFERRED — ${f.poolCount.toLocaleString()} pools exceeds --max-enum ${maxEnum.toLocaleString()}`);
    continue;
  }
  const r = await enumerateFactory({ mc, registry: reg, key, dex, count: f.poolCount, from: cursor, log: progress });
  endProgress();
  reg.setCursor(`enum:${key}`, r.nextIndex);
  say(`  ${key.padEnd(18)} +${r.added} pools (index ${cursor} -> ${r.nextIndex} of ${f.poolCount})`);
}
runLog.stages.enumeration = { deferred, reads: mc.stats.reads };
reg.save();

// ---------------------------------------------------------------------------
// Stage 2 — Swap-log sweep: the only way to reach non-enumerable factories
// ---------------------------------------------------------------------------
say(`\n[2/7] swap-log sweep — ${sweepBlocks} blocks in ${Number(argOf('sweep-window', cfg.rpcCapabilities?.unfilteredGetLogsMaxRange ?? 100))}-block windows`);
// Sweeps walk backwards from the oldest block already swept, so a re-run
// extends the observation window instead of re-reading the same blocks.
const prevSweepFrom = reg.cursor('sweep:from', null);
const sweepTo = prevSweepFrom != null ? prevSweepFrom - 1 : head;
const sweepFrom = Math.max(0, sweepTo - sweepBlocks + 1);
// The unfiltered-getLogs cap is chain- and provider-specific: 100 blocks on
// Base, 1 block on the free Ethereum endpoints. Taken from the chain config so
// no chain inherits another's limit.
const sweepWindow = Number(argOf('sweep-window', cfg.rpcCapabilities?.unfilteredGetLogsMaxRange ?? 100));
const sweep = await sweepSwapLogs({ rpc, registry: reg, fromBlock: sweepFrom, toBlock: sweepTo, windowSize: sweepWindow, log: progress });
endProgress();
reg.setCursor('sweep:from', sweepFrom);
reg.setCursor('sweep:to', Math.max(reg.cursor('sweep:to', 0), sweepTo));
say(`  ${sweep.pools} distinct pools traded in blocks ${sweepFrom}-${sweepTo} (${sweep.logs} swap logs, ${sweep.failedWindows} failed windows)`);
runLog.stages.sweep = { from: sweepFrom, to: sweepTo, ...sweep };
reg.save();

// ---------------------------------------------------------------------------
// Stage 3 — resolve pool identity for everything not yet resolved
// ---------------------------------------------------------------------------
say('\n[3/7] pool identity (token0/token1/fee/tickSpacing/stable/factory)');
const needIdentity = Object.values(reg.pools)
  .filter((p) => !p.singleton && isAddr(p.id) && (!p.token0 || !p.token1 || p.factoryOnChain === undefined))
  .map((p) => p.id);
say(`  ${needIdentity.length} pools need identity reads`);
const ident = needIdentity.length ? await resolvePoolIdentity({ mc, registry: reg, ids: needIdentity, cfg, log: progress }) : { resolved: 0, attempted: 0 };
if (needIdentity.length) endProgress();
const attr = attributeVenues(reg, cfg);
say(`  resolved ${ident.resolved}/${ident.attempted}; venue attributed ${attr.attributed}, unconfigured/unknown ${attr.unknown}`);
runLog.stages.identity = { ...ident, ...attr };
reg.save();

// ---------------------------------------------------------------------------
// Stage 4 — token metadata
// ---------------------------------------------------------------------------
say('\n[4/7] token metadata');
const tokenAddrs = new Set();
for (const p of Object.values(reg.pools)) { if (p.token0) tokenAddrs.add(p.token0); if (p.token1) tokenAddrs.add(p.token1); }
const toks = await resolveTokens({ mc, registry: reg, addresses: [...tokenAddrs], log: progress });
if (toks.attempted) endProgress();
say(`  ${reg.stats().tokens} tokens known (${toks.resolved} newly resolved this run)`);
runLog.stages.tokens = { ...toks, total: reg.stats().tokens };
reg.save();

// ---------------------------------------------------------------------------
// Stage 5 — state snapshot, screening prices, eligibility
// ---------------------------------------------------------------------------
say(`\n[5/7] state snapshot at block ${snapshotBlock}`);
const snapTargets = Object.values(reg.pools).filter((p) => !p.singleton && p.token0 && p.token1);
const snap = await snapshotState({ mc, registry: reg, pools: snapTargets, block: snapshotBlock, log: progress });
endProgress();
say(`  snapshotted ${snap.v2} v2-family + ${snap.v3} v3-family pools (${snap.skipped} skipped: no quote path)`);

const prices = buildScreeningPrices({ registry: reg, cfg });
say(`  screening prices for ${prices.size} tokens (anchors + up to 3 hops)`);
let elig = applyEligibility({ registry: reg, prices, minDepthUsd });
say(`  eligible pools: ${elig.eligible} / ${elig.total} at >= $${minDepthUsd} depth`);
runLog.stages.state = { ...snap, pricedTokens: prices.size, eligibility: elig };
reg.save();

// ---------------------------------------------------------------------------
// Stage 6 — cross-venue completion for every eligible pair
// ---------------------------------------------------------------------------
if (doComplete) {
  say('\n[6/7] cross-venue completion');
  const eligiblePairs = new Set();
  for (const p of Object.values(reg.pools)) if (p.eligible && p.pair) eligiblePairs.add(p.pair);
  // Enumerable factories are already complete, so asking them again is waste.
  const skip = new Set(Object.entries(enumeration.factories).filter(([, f]) => f.enumerable && f.poolCount <= maxEnum).map(([k]) => k));
  const probes = buildCompletionProbes(cfg, [...eligiblePairs], { skipVenues: skip });
  say(`  ${eligiblePairs.size} eligible pairs x venues/fee tiers = ${probes.length.toLocaleString()} getPool/getPair probes`);
  const comp = await runCompletionProbes({ mc, registry: reg, probes, log: progress });
  endProgress();
  say(`  ${comp.hits} pools found (${comp.newPools} not previously known)`);
  for (const [v, n] of Object.entries(comp.byVenue).sort((a, b) => b[1] - a[1])) say(`    ${v.padEnd(20)} ${n}`);
  runLog.stages.completion = { eligiblePairs: eligiblePairs.size, ...comp };
  reg.save();

  // Newly discovered pools need identity, tokens, state and a re-screen.
  say('\n[6b/7] resolving newly discovered pools');
  const fresh = Object.values(reg.pools).filter((p) => !p.state && !p.singleton && isAddr(p.id));
  if (fresh.length) {
    const need = fresh.filter((p) => !p.token0 || !p.token1).map((p) => p.id);
    if (need.length) { await resolvePoolIdentity({ mc, registry: reg, ids: need, cfg, log: progress }); endProgress(); }
    attributeVenues(reg, cfg);
    const newToks = new Set();
    for (const p of fresh) { if (p.token0) newToks.add(p.token0); if (p.token1) newToks.add(p.token1); }
    await resolveTokens({ mc, registry: reg, addresses: [...newToks], log: progress });
    const s2 = await snapshotState({ mc, registry: reg, pools: Object.values(reg.pools).filter((p) => !p.singleton && p.token0 && p.token1 && !p.state), block: snapshotBlock, log: progress });
    endProgress();
    say(`  ${fresh.length} new pools resolved and snapshotted (${s2.v2} v2 + ${s2.v3} v3)`);
  } else say('  none');
  const prices2 = buildScreeningPrices({ registry: reg, cfg });
  elig = applyEligibility({ registry: reg, prices: prices2, minDepthUsd });
  say(`  re-screened: ${elig.eligible} eligible pools, ${prices2.size} priced tokens`);
  runLog.stages.rescreen = { eligibility: elig, pricedTokens: prices2.size };
}

// ---------------------------------------------------------------------------
// Stage 7 — index and report
// ---------------------------------------------------------------------------
say('\n[7/7] indexing');
reg.recomputeTokenPoolCounts();
const stats = reg.stats();
const byPair = reg.indexByPair({ eligibleOnly: true });
const multiEligible = [...byPair.entries()].filter(([, v]) => v.length >= 2);
const routeCount = multiEligible.reduce((a, [, v]) => a + (v.length * (v.length - 1)) / 2, 0);

reg.noteRun({
  stage: 'discovery', head, snapshotBlock, sweepFrom, sweepTo,
  reads: mc.stats.reads, rpcCalls: rpc.stats.calls, seconds: Math.round((Date.now() - t0) / 1000),
});
reg.save();

const summary = {
  ...runLog,
  finishedAt: new Date().toISOString(),
  seconds: Math.round((Date.now() - t0) / 1000),
  reads: mc.stats.reads, rpcCalls: rpc.stats.calls, rpcErrors: rpc.stats.errors,
  registry: stats,
  eligibleUniverse: {
    eligiblePools: stats.eligiblePools,
    eligiblePairs: byPair.size,
    eligiblePairsWithTwoOrMorePools: multiEligible.length,
    twoPoolRoutes: routeCount,
    directionalTwoPoolRoutes: routeCount * 2,
  },
  deferredFactories: deferred,
  ineligibilityReasons: elig.reasons,
};
writeFileSync(join(ROOT, 'data', `discovery-${chainId}.json`), `${JSON.stringify(summary, null, 2)}\n`);

say('');
say('=== registry ===');
say(`  pools                       ${String(stats.pools).padStart(9)}`);
say(`  pools with token identity   ${String(stats.poolsWithTokens).padStart(9)}`);
say(`  quotable pools              ${String(stats.quotablePools).padStart(9)}`);
say(`  eligible pools (>= $${minDepthUsd})     ${String(stats.eligiblePools).padStart(9)}`);
say(`  tokens                      ${String(stats.tokens).padStart(9)}`);
say(`  token pairs (all)           ${String(stats.pairs).padStart(9)}`);
say(`  eligible pairs              ${String(byPair.size).padStart(9)}`);
say(`  eligible pairs, >=2 pools   ${String(multiEligible.length).padStart(9)}`);
say(`  two-pool routes             ${String(routeCount).padStart(9)}`);
say(`  directional routes          ${String(routeCount * 2).padStart(9)}`);
say('');
say('pools by venue');
for (const [v, n] of Object.entries(stats.byVenue).sort((a, b) => b[1] - a[1])) say(`  ${v.padEnd(26)} ${String(n).padStart(8)}`);
say('');
say('ineligibility reasons');
for (const [r, n] of Object.entries(elig.reasons).sort((a, b) => b[1] - a[1])) say(`  ${r.padEnd(40)} ${String(n).padStart(8)}`);
say(`\n${mc.stats.reads.toLocaleString()} contract reads in ${summary.seconds}s; wrote data/discovery-${chainId}.json and data/market/*-${chainId}.json`);
