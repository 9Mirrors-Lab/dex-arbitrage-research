// The token and liquidity-pool registry: an indexed inventory of the market.
//
// Design rules that the rest of the engine depends on:
//
//  * A token's identity is its contract address, lower-cased. Symbols are
//    display labels only. Base has several distinct tokens sharing a symbol
//    (and spam deployments deliberately reuse popular ones), so any index keyed
//    by symbol would silently merge unrelated assets.
//  * A pool's identity is its address, except Uniswap V4 where the singleton
//    PoolManager holds every pool and the identity is the 32-byte poolId.
//  * Every pool records WHERE it came from (`sources`) and when it was last
//    confirmed from chain state (`lastValidated`). A pool discovered by one
//    method and later confirmed by another keeps both sources.
//  * Discovery is incremental. `cursors` records how far each factory and each
//    log sweep has progressed, so a re-run extends the registry instead of
//    rebuilding it.
//  * Nothing here deletes. A pool that stops quoting is marked, not dropped,
//    because "we could not quote it" and "it does not exist" are different
//    facts and only one of them is a reason to exclude it from a route.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'market');

export const pairKey = (a, b) => [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('/');

function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

// Write via a temp file and rename: a discovery run that is interrupted
// mid-write must not leave a truncated registry behind.
function writeJsonAtomic(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj)}\n`);
  renameSync(tmp, p);
}

export class PoolRegistry {
  constructor(chainId) {
    this.chainId = chainId;
    this.poolPath = join(DIR, `pools-${chainId}.json`);
    this.tokenPath = join(DIR, `tokens-${chainId}.json`);
    this.metaPath = join(DIR, `meta-${chainId}.json`);

    this.pools = readJson(this.poolPath, {});
    this.tokens = readJson(this.tokenPath, {});
    this.meta = readJson(this.metaPath, {
      chain: chainId, createdAt: new Date().toISOString(), updatedAt: null,
      cursors: {}, runs: [],
    });
  }

  save() {
    this.meta.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.poolPath, this.pools);
    writeJsonAtomic(this.tokenPath, this.tokens);
    writeJsonAtomic(this.metaPath, this.meta);
  }

  // ---- pools ---------------------------------------------------------------
  // `id` is the pool address, or the poolId for Uniswap V4.
  upsertPool(id, patch, source) {
    const key = String(id).toLowerCase();
    const prev = this.pools[key] ?? {
      id: key, chain: this.chainId, sources: [], firstSeenAt: new Date().toISOString(),
    };
    const next = { ...prev, ...patch };
    if (patch.token0) next.token0 = String(patch.token0).toLowerCase();
    if (patch.token1) next.token1 = String(patch.token1).toLowerCase();
    if (next.token0 && next.token1) next.pair = pairKey(next.token0, next.token1);
    if (source && !next.sources.includes(source)) next.sources = [...next.sources, source];
    this.pools[key] = next;
    return next;
  }

  pool(id) { return this.pools[String(id).toLowerCase()] ?? null; }

  // ---- tokens --------------------------------------------------------------
  upsertToken(addr, patch, source) {
    const key = String(addr).toLowerCase();
    const prev = this.tokens[key] ?? { address: key, sources: [], poolCount: 0 };
    const next = { ...prev, ...patch };
    if (source && !next.sources.includes(source)) next.sources = [...next.sources, source];
    this.tokens[key] = next;
    return next;
  }

  token(addr) { return this.tokens[String(addr).toLowerCase()] ?? null; }

  // ---- derived indexes -----------------------------------------------------
  // Rebuilt on demand rather than stored, so they can never drift from the
  // pool table they describe.
  indexByPair({ eligibleOnly = false } = {}) {
    const byPair = new Map();
    for (const p of Object.values(this.pools)) {
      if (!p.pair) continue;
      if (eligibleOnly && !p.eligible) continue;
      if (!byPair.has(p.pair)) byPair.set(p.pair, []);
      byPair.get(p.pair).push(p);
    }
    return byPair;
  }

  recomputeTokenPoolCounts() {
    for (const t of Object.values(this.tokens)) t.poolCount = 0;
    for (const p of Object.values(this.pools)) {
      for (const t of [p.token0, p.token1]) {
        if (t && this.tokens[t]) this.tokens[t].poolCount++;
      }
    }
  }

  cursor(key, fallback = null) { return this.meta.cursors[key] ?? fallback; }
  setCursor(key, value) { this.meta.cursors[key] = value; }

  noteRun(entry) {
    this.meta.runs = [...(this.meta.runs ?? []), { at: new Date().toISOString(), ...entry }].slice(-50);
  }

  stats() {
    const pools = Object.values(this.pools);
    const byVenue = {}; const bySource = {};
    let withTokens = 0; let eligible = 0; let quotable = 0;
    for (const p of pools) {
      byVenue[p.venue ?? 'unknown'] = (byVenue[p.venue ?? 'unknown'] ?? 0) + 1;
      for (const s of p.sources ?? []) bySource[s] = (bySource[s] ?? 0) + 1;
      if (p.token0 && p.token1) withTokens++;
      if (p.eligible) eligible++;
      if (p.quotable) quotable++;
    }
    const byPair = this.indexByPair();
    const multi = [...byPair.values()].filter((v) => v.length >= 2);
    return {
      pools: pools.length, poolsWithTokens: withTokens, eligiblePools: eligible, quotablePools: quotable,
      tokens: Object.keys(this.tokens).length,
      pairs: byPair.size, pairsWithTwoOrMorePools: multi.length,
      byVenue, bySource,
    };
  }
}
