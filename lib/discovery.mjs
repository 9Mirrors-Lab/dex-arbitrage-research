// Market-wide pool discovery.
//
// Three independent mechanisms, because no single one is complete on Base:
//
//  1. enumerateFactory      — factories that keep an on-chain array
//     (allPools/allPairs). Exhaustive and cheap. Covers Aerodrome classic, all
//     four Slipstream CL factories, SushiSwap V2, BaseSwap V2 and — at
//     3.07M pairs — Uniswap V2.
//
//  2. sweepSwapLogs         — topic-filtered Swap logs. The free endpoints
//     refuse an unfiltered log query wider than 100 blocks, so this walks in
//     100-block windows. It is the only mechanism that finds pools on the
//     factories with no on-chain array (Uniswap V3, PancakeSwap V3, SushiSwap
//     V3, Solidly V3, two unidentified V3 forks, Uniswap V4) without scanning
//     52M blocks of creation events. It finds what actually trades, which is
//     also the set that can host an executable arbitrage.
//
//  3. completeCrossVenue    — for a token pair we already know about, ask every
//     other configured factory whether it has a pool for that same pair, via
//     getPool()/getPair(). This is what turns a pool list into a route
//     universe: a two-pool arbitrage needs two pools on one pair, so the
//     question "where else does this pair exist?" is the one that matters.
//     It also sidesteps Uniswap V2's 3.07M mostly-spam pairs: we never
//     enumerate them, we ask only about pairs that already have liquidity
//     somewhere.
//
// What this combination does NOT cover, stated so the coverage report can say
// it: a token pair whose only pools sit on a non-enumerable factory AND which
// did not trade inside the sweep window. Such a pair is recorded as NOT TESTED,
// and 22-discover-pools.mjs measures the size of that gap rather than assuming
// it away.

import { encodeFunctionData, decodeFunctionResult, parseAbi, keccak256, encodePacked, getCreate2Address } from 'viem';
import { SWAP_EVENTS, SWAP_TOPICS } from './events.mjs';
import { toHex } from './rpc.mjs';
import { pairKey } from './poolregistry.mjs';

export const FACTORY_ABI = parseAbi([
  'function allPools(uint256) view returns (address)',
  'function allPairs(uint256) view returns (address)',
  'function getPool(address,address,uint24) view returns (address)',
  'function getPool(address,address,int24) view returns (address)',
  'function getPool(address,address,bool) view returns (address)',
  'function getPair(address,address) view returns (address)',
]);

export const POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function stable() view returns (bool)',
  'function factory() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
]);

export const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

const enc = (abi, fn, args = []) => encodeFunctionData({ abi, functionName: fn, args });
const dec = (abi, fn, data) => {
  if (data == null) return undefined;
  try { return decodeFunctionResult({ abi, functionName: fn, data }); } catch { return undefined; }
};
const ZERO = '0x0000000000000000000000000000000000000000';
const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-f]{40}$/i.test(a) && a.toLowerCase() !== ZERO;

// Fee tiers to probe when a factory's are not declared in config. The union of
// what Uniswap-V3-family deployments actually use; which ones return a pool is
// recorded, so the probe list is self-documenting.
export const FEE_TIER_PROBE = [100, 250, 400, 450, 500, 2500, 3000, 10000];

// ---------------------------------------------------------------------------
// 1. Exhaustive enumeration from an on-chain array
// ---------------------------------------------------------------------------
export async function enumerateFactory({ mc, registry, key, dex, count, from = 0, limit = Infinity, log = () => {} }) {
  const method = dex.enumMethod; // 'allPools' | 'allPairs'
  const to = Math.min(count, from + (limit === Infinity ? count : limit));
  if (to <= from) return { added: 0, scanned: 0, nextIndex: from };

  let added = 0;
  const CHUNK = 20000; // keep the call array bounded in memory
  for (let start = from; start < to; start += CHUNK) {
    const end = Math.min(to, start + CHUNK);
    const calls = [];
    for (let i = start; i < end; i++) {
      calls.push({ target: dex.factory, callData: enc(FACTORY_ABI, method, [BigInt(i)]) });
    }
    const res = await mc.read(calls);
    res.forEach((d, k) => {
      const addr = dec(FACTORY_ABI, method, d);
      const a = addr ? String(addr) : null;
      if (!isAddr(a)) return;
      registry.upsertPool(a, {
        venue: key, family: dex.family, label: dex.label, factory: dex.factory.toLowerCase(),
        factoryIndex: start + k, protocol: dex.family, tickSpacingBased: !!dex.tickSpacingBased,
      }, `factory-array:${key}`);
      added++;
    });
    log(`    ${key}: enumerated ${end - from}/${to - from} (${added} addresses)`);
  }
  return { added, scanned: to - from, nextIndex: to };
}

// ---------------------------------------------------------------------------
// 2. Swap-log sweep — finds pools that actually trade, on any factory
// ---------------------------------------------------------------------------
export async function sweepSwapLogs({ rpc, registry, fromBlock, toBlock, windowSize = 100, concurrency = 6, log = () => {} }) {
  const windows = [];
  for (let b = fromBlock; b <= toBlock; b += windowSize) windows.push([b, Math.min(toBlock, b + windowSize - 1)]);

  const found = new Map(); // poolKey -> { family, swaps, lastBlock, poolId? }
  let logsSeen = 0;
  const failedWindows = [];

  const fetchWindow = async ([f, t]) => {
    const r = await rpc.call('eth_getLogs', [{ topics: [SWAP_TOPICS], fromBlock: toHex(f), toBlock: toHex(t) }], { allowError: true });
    return r.error ? null : r.result;
  };

  const consume = (logs) => {
    logsSeen += logs.length;
    for (const lg of logs) {
      const spec = SWAP_EVENTS[lg.topics?.[0]];
      if (!spec) continue;
      const singleton = spec.family === 'uniswap-v4' || spec.family === 'balancer-v2';
      const id = (singleton ? lg.topics?.[1] : lg.address)?.toLowerCase();
      if (!id) continue;
      const prev = found.get(id) ?? { family: spec.family, swaps: 0, lastBlock: 0, singleton };
      prev.swaps++;
      prev.lastBlock = Math.max(prev.lastBlock, Number(BigInt(lg.blockNumber)));
      found.set(id, prev);
    }
  };

  for (let i = 0; i < windows.length; i += concurrency) {
    const group = windows.slice(i, i + concurrency);
    const results = await Promise.all(group.map(fetchWindow));
    results.forEach((logs, k) => { if (logs) consume(logs); else failedWindows.push(group[k]); });
    log(`    swap sweep ${Math.min(i + concurrency, windows.length)}/${windows.length} windows, ${found.size} distinct pools, ${logsSeen} logs`);
  }

  // A window that failed is a hole in the activity data, not an empty window.
  // Retry each one on its own — the failures are rate-limit responses from
  // hammering three public endpoints, and they usually succeed when spaced out.
  let stillFailed = 0;
  if (failedWindows.length) {
    log(`    swap sweep: retrying ${failedWindows.length} failed windows`);
    for (const w of failedWindows) {
      const logs = await fetchWindow(w);
      if (logs) consume(logs); else stillFailed++;
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  for (const [id, v] of found) {
    registry.upsertPool(id, {
      family: v.family, singleton: v.singleton,
      activity: {
        swapsObserved: (registry.pool(id)?.activity?.swapsObserved ?? 0) + v.swaps,
        lastSwapBlock: Math.max(registry.pool(id)?.activity?.lastSwapBlock ?? 0, v.lastBlock),
        windowFrom: fromBlock, windowTo: toBlock,
      },
    }, 'swap-log-sweep');
  }
  return {
    pools: found.size, logs: logsSeen, windows: windows.length,
    windowsFailedFirstPass: failedWindows.length, failedWindows: stillFailed,
    coverageOfWindow: windows.length ? +(100 * (windows.length - stillFailed) / windows.length).toFixed(3) : null,
  };
}

// ---------------------------------------------------------------------------
// Resolve pool identity: token0/token1/fee/tickSpacing/stable/factory
// ---------------------------------------------------------------------------
export async function resolvePoolIdentity({ mc, registry, ids, cfg = null, log = () => {} }) {
  const targets = ids.filter((id) => isAddr(id));
  if (!targets.length) return { resolved: 0 };

  const read = async (subset, field) => {
    const res = await mc.read(subset.map((t) => ({ target: t, callData: enc(POOL_ABI, field) })));
    log(`    identity: ${field} read for ${subset.length} pools`);
    return res.map((d) => dec(POOL_ABI, field, d));
  };

  // Pass one asks only what every pool family answers. fee(), tickSpacing()
  // and stable() revert on most pools — a V2 pair has no fee(), a V3 pool has
  // no stable() — and a 500-call batch where most sub-calls revert can exceed
  // the endpoint's gas ceiling, which degrades the batch into individual
  // calls. Reading them only where they exist removes ~150k wasted reads.
  const got = { token0: null, token1: null, factory: null, fee: [], tickSpacing: [], stable: [] };
  got.token0 = await read(targets, 'token0');
  got.token1 = await read(targets, 'token1');
  got.factory = await read(targets, 'factory');

  const familyByFactory = {};
  for (const d of Object.values(cfg?.dexes ?? {})) {
    if (d.factory) familyByFactory[d.factory.toLowerCase()] = d.family;
  }
  const idx = { v3: [], solidly: [], unknown: [] };
  targets.forEach((id, k) => {
    const f = got.factory[k] ? String(got.factory[k]).toLowerCase() : null;
    const fam = f ? familyByFactory[f] : undefined;
    if (fam === 'uniswap-v3' || fam === 'pancake-v3') idx.v3.push(k);
    else if (fam === 'solidly-v2') idx.solidly.push(k);
    else if (fam === 'uniswap-v2') { /* reserves only; nothing more to read */ }
    else idx.unknown.push(k); // unconfigured factory: probe everything
  });

  const sub = (keys) => keys.map((k) => targets[k]);
  const scatter = (keys, values, field) => { keys.forEach((k, i) => { got[field][k] = values[i]; }); };

  const v3Keys = [...idx.v3, ...idx.unknown];
  if (v3Keys.length) {
    scatter(v3Keys, await read(sub(v3Keys), 'fee'), 'fee');
    scatter(v3Keys, await read(sub(v3Keys), 'tickSpacing'), 'tickSpacing');
  }
  const stKeys = [...idx.solidly, ...idx.unknown];
  if (stKeys.length) scatter(stKeys, await read(sub(stKeys), 'stable'), 'stable');
  let resolved = 0;
  targets.forEach((id, k) => {
    const t0 = got.token0[k]; const t1 = got.token1[k];
    const patch = {
      token0: isAddr(String(t0)) ? String(t0) : null,
      token1: isAddr(String(t1)) ? String(t1) : null,
      feeTier: got.fee[k] != null ? Number(got.fee[k]) : null,
      tickSpacing: got.tickSpacing[k] != null ? Number(got.tickSpacing[k]) : null,
      stable: got.stable[k] ?? null,
      factoryOnChain: got.factory[k] ? String(got.factory[k]).toLowerCase() : null,
      identityResolvedAt: new Date().toISOString(),
    };
    if (patch.token0 && patch.token1) resolved++;
    registry.upsertPool(id, patch, 'identity-read');
  });
  return { resolved, attempted: targets.length };
}

// Attribute a pool to a configured venue using the factory it reports.
export function attributeVenues(registry, cfg) {
  const byFactory = {};
  for (const [k, d] of Object.entries(cfg.dexes ?? {})) {
    for (const a of [d.factory, d.poolManager, d.vault]) if (a) byFactory[a.toLowerCase()] = { key: k, dex: d };
  }
  let attributed = 0; let unknown = 0; let familyCorrected = 0;

  // A pool's family decides which arithmetic prices it, so getting it wrong
  // produces a confidently wrong quote. The swap-log sweep can only infer a
  // family from the Swap event signature, and Solidly-style pools emit the
  // same signature as Uniswap V2 while using a completely different invariant
  // (x³y + y³x instead of xy = k).
  //
  // This cost us a real false positive: a USDC/USDT stableswap pool was
  // quoted as constant-product and appeared to yield $20 on a $201 round
  // trip. A pool that answers stable() is a Solidly-family pool, and the
  // solidly path quotes it through its OWN getAmountOut() view, which is
  // exact whatever the invariant.
  for (const p of Object.values(registry.pools)) {
    if (p.stable != null && p.family === 'uniswap-v2') {
      p.family = 'solidly-v2';
      p.familyCorrectedBy = 'stable() present — Solidly-family invariant, not constant product';
      familyCorrected++;
    }
  }

  for (const p of Object.values(registry.pools)) {
    if (p.venue && p.family) { attributed++; continue; }
    const hit = p.factoryOnChain ? byFactory[p.factoryOnChain] : null;
    if (hit) {
      p.venue = hit.key; p.family = hit.dex.family; p.label = hit.dex.label;
      p.factory = hit.dex.factory?.toLowerCase() ?? null;
      p.tickSpacingBased = !!hit.dex.tickSpacingBased;
      attributed++;
    } else {
      // A pool whose factory is not configured is a real pool on an
      // unconfigured venue. It is recorded, and excluded from routes with a
      // reason — not deleted and not counted as evaluated.
      p.venue ??= p.factoryOnChain ? `unconfigured:${p.factoryOnChain}` : 'unknown';
      unknown++;
    }
  }
  return { attributed, unknown, familyCorrected };
}

// ---------------------------------------------------------------------------
// 3. Cross-venue completion — where else does this pair exist?
// ---------------------------------------------------------------------------
// Returns the probe plan so the coverage ledger can record exactly which
// (pair, factory, feeTier) questions were asked.
export function buildCompletionProbes(cfg, pairs, { skipVenues = new Set() } = {}) {
  const probes = [];
  for (const [key, d] of Object.entries(cfg.dexes ?? {})) {
    if (skipVenues.has(key)) continue;
    const factory = d.factory;
    if (!factory) continue; // V4 PoolManager / Balancer Vault have no getPool(token,token,...)
    for (const pk of pairs) {
      const [a, b] = pk.split('/');
      if (d.family === 'uniswap-v3' || d.family === 'pancake-v3') {
        if (d.tickSpacingBased) continue; // enumerable; and getPool takes tickSpacing, not fee
        const tiers = d.feeTiers?.length ? d.feeTiers : FEE_TIER_PROBE;
        for (const fee of tiers) {
          probes.push({ venue: key, dex: d, pair: pk, kind: 'v3', arg: fee,
            target: factory, callData: enc(FACTORY_ABI, 'getPool', [a, b, fee]) });
        }
      } else if (d.family === 'uniswap-v2') {
        probes.push({ venue: key, dex: d, pair: pk, kind: 'v2', arg: null,
          target: factory, callData: enc(FACTORY_ABI, 'getPair', [a, b]) });
      } else if (d.family === 'solidly-v2') {
        for (const stable of [false, true]) {
          probes.push({ venue: key, dex: d, pair: pk, kind: 'solidly', arg: stable,
            target: factory, callData: enc(FACTORY_ABI, 'getPool', [a, b, stable]) });
        }
      }
    }
  }
  return probes;
}

export async function runCompletionProbes({ mc, registry, probes, log = () => {} }) {
  const out = { probes: probes.length, hits: 0, newPools: 0, byVenue: {} };
  const CHUNK = 50000;
  for (let s = 0; s < probes.length; s += CHUNK) {
    const slice = probes.slice(s, s + CHUNK);
    const res = await mc.read(slice.map((p) => ({ target: p.target, callData: p.callData })));
    res.forEach((d, k) => {
      const p = slice[k];
      const fn = p.kind === 'v2' ? 'getPair' : 'getPool';
      const addr = dec(FACTORY_ABI, fn, d);
      const a = addr ? String(addr) : null;
      if (!isAddr(a)) return;
      out.hits++;
      out.byVenue[p.venue] = (out.byVenue[p.venue] ?? 0) + 1;
      const existed = registry.pool(a) != null;
      const [t0, t1] = p.pair.split('/');
      registry.upsertPool(a, {
        venue: p.venue, family: p.dex.family, label: p.dex.label,
        factory: p.target.toLowerCase(), token0: t0, token1: t1,
        feeTier: p.kind === 'v3' ? p.arg : (registry.pool(a)?.feeTier ?? null),
        stable: p.kind === 'solidly' ? p.arg : (registry.pool(a)?.stable ?? null),
        discoveredBy: 'cross-venue-completion',
      }, `cross-venue:${p.venue}`);
      if (!existed) out.newPools++;
    });
    log(`    completion ${Math.min(s + CHUNK, probes.length)}/${probes.length} probes, ${out.hits} pools found`);
  }
  return out;
}

// Deterministic Uniswap-V2 pair address. Verified against a live Base pair
// before use; a fork with a different init-code hash must not use this path, so
// the hash is passed in rather than assumed.
export function v2PairAddress(factory, tokenA, tokenB, initCodeHash) {
  const [t0, t1] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  return getCreate2Address({ from: factory, salt: keccak256(encodePacked(['address', 'address'], [t0, t1])), bytecodeHash: initCodeHash });
}

// ---------------------------------------------------------------------------
// Token metadata
// ---------------------------------------------------------------------------
export async function resolveTokens({ mc, registry, addresses, log = () => {} }) {
  const todo = [...new Set(addresses.filter(isAddr).map((a) => a.toLowerCase()))]
    .filter((a) => registry.token(a)?.decimals == null);
  if (!todo.length) return { resolved: 0, attempted: 0 };
  const [syms, decs, sups] = [
    await mc.read(todo.map((t) => ({ target: t, callData: enc(ERC20_ABI, 'symbol') }))),
    await mc.read(todo.map((t) => ({ target: t, callData: enc(ERC20_ABI, 'decimals') }))),
    await mc.read(todo.map((t) => ({ target: t, callData: enc(ERC20_ABI, 'totalSupply') }))),
  ];
  let resolved = 0;
  todo.forEach((a, k) => {
    let symbol = dec(ERC20_ABI, 'symbol', syms[k]);
    if (symbol == null && syms[k]) {
      // Pre-standard tokens return a bare bytes32 rather than a string.
      try { symbol = Buffer.from(syms[k].slice(2), 'hex').toString('utf8').replace(/[\u0000-\u001f]+/g, '') || null; } catch { symbol = null; }
    }
    const d = dec(ERC20_ABI, 'decimals', decs[k]);
    if (d != null) resolved++;
    registry.upsertToken(a, {
      symbol: symbol != null ? String(symbol).slice(0, 40) : null,
      decimals: d != null ? Number(d) : null,
      totalSupply: sups[k] ? String(dec(ERC20_ABI, 'totalSupply', sups[k]) ?? '') : null,
      resolvedAt: new Date().toISOString(),
    }, 'erc20-read');
  });
  log(`    tokens: ${resolved}/${todo.length} resolved decimals`);
  return { resolved, attempted: todo.length };
}

export { isAddr, pairKey, enc as encodeCall, dec as decodeCall };
