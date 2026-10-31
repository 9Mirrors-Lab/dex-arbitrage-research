// Step 1 of the discovery chain: BLOCKCHAIN -> EXCHANGES.
//
// The swap-log sweep finds pools, and a pool reports the factory that created
// it. Any factory that is not in chains/<chain>.json is a venue we are blind
// to — its pools get excluded from routes as `factory-not-configured`, which
// is an honest exclusion but still a coverage hole.
//
// This script ranks those unknown factories by how much trading they actually
// carry, then fingerprints each one on-chain so it can be identified and added
// to the config. Fingerprinting is how the existing Base config was built:
// several heavily-used Base factories match nothing published, and are only
// distinguishable by which methods they answer.
//
//   node scripts/23-identify-factories.mjs --chain base --top 25

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAbi } from 'viem';
import { Rpc, loadChain } from '../lib/rpc.mjs';
import { Multicall } from '../lib/multicall.mjs';
import { PoolRegistry } from '../lib/poolregistry.mjs';
import { encodeCall, decodeCall } from '../lib/discovery.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const chainId = argOf('chain', 'base');
const topN = Number(argOf('top', 25));

const cfg = loadChain(chainId);
const rpc = new Rpc(cfg.rpc, { concurrency: 8 });
const mc = new Multicall(rpc, cfg.multicall3, { batch: 200, parallel: 4 });
const reg = new PoolRegistry(chainId);

// Each probe is a method whose presence or value identifies a protocol family.
// `feeAmountTickSpacing(3000)` is the sharpest single discriminator among V3
// forks: Uniswap answers 60, Solidly V3 answers 50, Slipstream does not
// implement it at all.
const FP_ABI = parseAbi([
  'function feeAmountTickSpacing(uint24) view returns (int24)',
  'function owner() view returns (address)',
  'function voter() view returns (address)',
  'function poolImplementation() view returns (address)',
  'function factoryRegistry() view returns (address)',
  'function allPoolsLength() view returns (uint256)',
  'function allPairsLength() view returns (uint256)',
  'function feeTo() view returns (address)',
  'function feeToSetter() view returns (address)',
  'function protocolFeeController() view returns (address)',
  'function defaultFee() view returns (uint24)',
  'function tickSpacings() view returns (int24[])',
  'function swapFeeModule() view returns (address)',
]);

const PROBES = [
  ['feeAmountTickSpacing', [3000]], ['owner', []], ['voter', []], ['poolImplementation', []],
  ['factoryRegistry', []], ['allPoolsLength', []], ['allPairsLength', []], ['feeTo', []],
  ['feeToSetter', []], ['protocolFeeController', []], ['defaultFee', []], ['tickSpacings', []],
  ['swapFeeModule', []],
];

// ---------------------------------------------------------------------------
// Rank unconfigured factories by observed trading
// ---------------------------------------------------------------------------
const configured = new Set();
for (const d of Object.values(cfg.dexes ?? {})) {
  for (const a of [d.factory, d.poolManager, d.vault]) if (a) configured.add(a.toLowerCase());
}

const unknown = new Map(); // factory -> { pools, swaps, families:Set, samplePools:[], pairs:Set }
for (const p of Object.values(reg.pools)) {
  const f = p.factoryOnChain;
  if (!f || configured.has(f)) continue;
  if (!unknown.has(f)) unknown.set(f, { factory: f, pools: 0, swaps: 0, families: new Set(), samplePools: [], pairs: new Set(), depthUsd: 0 });
  const e = unknown.get(f);
  e.pools++;
  e.swaps += p.activity?.swapsObserved ?? 0;
  e.depthUsd += p.depthUsd ?? 0;
  if (p.pair) e.pairs.add(p.pair);
  if (e.samplePools.length < 3) e.samplePools.push(p.id);
  // The pool's own interface hints at the family even before we fingerprint
  // the factory: a tickSpacing getter means a concentrated-liquidity pool.
  if (p.tickSpacing != null && p.feeTier != null) e.families.add('v3-like (fee + tickSpacing)');
  else if (p.tickSpacing != null) e.families.add('slipstream-like (tickSpacing, no fee)');
  else if (p.stable != null) e.families.add('solidly-like (stable flag)');
  else e.families.add('v2-like (reserves only)');
}

const ranked = [...unknown.values()].sort((a, b) => b.swaps - a.swaps).slice(0, topN);
console.log(`\n=== unconfigured factories on ${cfg.name} ===`);
console.log(`${unknown.size} distinct factories not in chains/${chainId}.json; fingerprinting top ${ranked.length} by observed swaps\n`);

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------
for (const [fn, fargs] of PROBES) {
  const res = await mc.read(ranked.map((r) => ({ target: r.factory, callData: encodeCall(FP_ABI, fn, fargs) })));
  ranked.forEach((r, k) => {
    const v = decodeCall(FP_ABI, fn, res[k]);
    r.fingerprint ??= {};
    if (v !== undefined) r.fingerprint[fn] = Array.isArray(v) ? v.map(String) : String(v);
  });
}

// A guess, clearly labelled as a guess. The config records `evidence`, and
// a brand name is only ever asserted from chain state or left unidentified.
function classify(fp) {
  if (!fp) return { family: null, note: 'no probe answered; may not be a factory' };
  if (fp.poolImplementation && fp.voter) return { family: 'uniswap-v3', note: `Slipstream fingerprint; voter()=${fp.voter}` };
  if (fp.feeAmountTickSpacing === '60') return { family: 'uniswap-v3', note: 'feeAmountTickSpacing(3000)=60 — Uniswap V3 fork' };
  if (fp.feeAmountTickSpacing === '50') return { family: 'uniswap-v3', note: 'feeAmountTickSpacing(3000)=50 — Solidly V3 lineage' };
  if (fp.feeAmountTickSpacing) return { family: 'uniswap-v3', note: `feeAmountTickSpacing(3000)=${fp.feeAmountTickSpacing} — V3 fork with custom spacing` };
  if (fp.allPairsLength) return { family: 'uniswap-v2', note: `V2-style factory, allPairsLength()=${fp.allPairsLength}` };
  if (fp.allPoolsLength) return { family: 'solidly-v2', note: `Solidly-style factory, allPoolsLength()=${fp.allPoolsLength}` };
  if (fp.feeTo || fp.feeToSetter) return { family: 'uniswap-v2', note: 'V2 fee plumbing present, no pair array' };
  return { family: null, note: 'answered only generic methods; family not established' };
}

const out = { chain: chainId, measuredAt: new Date().toISOString(), totalUnconfigured: unknown.size, candidates: [] };

for (const r of ranked) {
  const guess = classify(r.fingerprint);
  const row = {
    factory: r.factory, poolsInRegistry: r.pools, distinctPairs: r.pairs.size,
    swapsObservedInSweep: r.swaps, screeningDepthUsdSum: Math.round(r.depthUsd),
    poolInterfaceHints: [...r.families],
    fingerprint: r.fingerprint ?? {},
    inferredFamily: guess.family, evidence: guess.note,
    samplePools: r.samplePools,
    quotableIfAdded: guess.family === 'uniswap-v3' || guess.family === 'uniswap-v2' || guess.family === 'solidly-v2',
    configStub: guess.family ? {
      label: `Unidentified ${guess.family} factory ${r.factory.slice(0, 10)}`,
      family: guess.family, factory: r.factory, quoter: null,
      tickSpacingBased: !!(r.fingerprint?.poolImplementation && !r.fingerprint?.feeAmountTickSpacing),
      evidence: guess.note,
    } : null,
  };
  out.candidates.push(row);
  console.log(`${r.factory}  pools ${String(r.pools).padStart(5)}  swaps ${String(r.swaps).padStart(7)}  pairs ${String(r.pairs.size).padStart(5)}  -> ${guess.family ?? 'UNIDENTIFIED'}`);
  console.log(`    ${guess.note}`);
}

writeFileSync(join(ROOT, 'data', `unconfigured-factories-${chainId}.json`), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nwrote data/unconfigured-factories-${chainId}.json`);
console.log('Add the config stubs you accept to chains/' + chainId + '.json, then re-run 22-discover-pools.mjs to pull their pools into the registry.');
