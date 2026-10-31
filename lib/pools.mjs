// Pool and token metadata resolver with an on-disk cache, so repeated
// forensics runs do not re-query the same immutable facts.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeFunctionData, decodeFunctionResult, parseAbi, getAddress } from 'viem';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'data', 'cache');

const ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function factory() view returns (address)',
  'function stable() view returns (bool)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);

const enc = (fn) => encodeFunctionData({ abi: ABI, functionName: fn });
const dec = (fn, data) => decodeFunctionResult({ abi: ABI, functionName: fn, data });

function loadCache(name) {
  const p = join(CACHE_DIR, name);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}
function saveCache(name, obj) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, name), `${JSON.stringify(obj, null, 1)}\n`);
}

export class MetaStore {
  constructor(rpc, chainId, cfg = null) {
    this.rpc = rpc;
    this.chainId = chainId;
    this.pools = loadCache(`pools-${chainId}.json`);
    this.tokens = loadCache(`tokens-${chainId}.json`);
    // Config tokens are a last-resort fallback for symbol/decimals.
    this.configTokens = cfg?.tokenByAddress ?? {};
  }

  flush() {
    saveCache(`pools-${this.chainId}.json`, this.pools);
    saveCache(`tokens-${this.chainId}.json`, this.tokens);
  }

  // Read one field off many contracts. Returns a Map of addr -> decoded value.
  // A batch that comes back short or errored is retried one call at a time,
  // because silently caching a transport failure as "this token has no
  // decimals" corrupts every number computed downstream.
  async #readField(addrs, field, chunk = 10) {
    const out = new Map();
    const missing = [];
    for (let i = 0; i < addrs.length; i += chunk) {
      const slice = addrs.slice(i, i + chunk);
      const res = await this.rpc.batch(slice.map((a) => ({ method: 'eth_call', params: [{ to: a, data: enc(field) }, 'latest'] })), { chunk });
      slice.forEach((addr, k) => {
        const r = res[k];
        if (!r || r.error || !r.result) { if (!r || r.error) missing.push(addr); return; }
        if (r.result === '0x') { out.set(addr, undefined); return; } // genuinely absent
        try { out.set(addr, dec(field, r.result)); } catch { out.set(addr, this.#rawFallback(field, r.result)); }
      });
    }
    for (const addr of missing) {
      const r = await this.rpc.ethCall(addr, enc(field));
      if (r.error || !r.result) continue;
      if (r.result === '0x') { out.set(addr, undefined); continue; }
      try { out.set(addr, dec(field, r.result)); } catch { out.set(addr, this.#rawFallback(field, r.result)); }
    }
    return out;
  }

  // Pre-ERC20-standard tokens encode symbol as a bare bytes32.
  #rawFallback(field, data) {
    if (field !== 'symbol') return undefined;
    try {
      const s = Buffer.from(data.slice(2), 'hex').toString('utf8').replace(/[\u0000-\u001f]+/g, '');
      return s || undefined;
    } catch { return undefined; }
  }

  // Resolve token0/token1/fee/tickSpacing/factory/stable for many pools at once.
  async resolvePools(addresses) {
    const todo = [...new Set(addresses.map((a) => a.toLowerCase()))]
      .filter((a) => !this.pools[a] || this.pools[a].incomplete);
    if (!todo.length) return this.pools;
    const FIELDS = ['token0', 'token1', 'fee', 'tickSpacing', 'factory', 'stable'];
    const got = {};
    for (const f of FIELDS) got[f] = await this.#readField(todo, f);
    for (const addr of todo) {
      const token0 = got.token0.get(addr);
      this.pools[addr] = {
        token0: token0 ? String(token0).toLowerCase() : null,
        token1: got.token1.get(addr) ? String(got.token1.get(addr)).toLowerCase() : null,
        fee: got.fee.get(addr) != null ? Number(got.fee.get(addr)) : null,
        tickSpacing: got.tickSpacing.get(addr) != null ? Number(got.tickSpacing.get(addr)) : null,
        factory: got.factory.get(addr) ? String(got.factory.get(addr)).toLowerCase() : null,
        stable: got.stable.get(addr) ?? null,
        // A pool with no token0 is either a singleton (Uniswap V4 PoolManager)
        // or unreachable; either way do not treat it as resolved.
        incomplete: token0 == null,
      };
    }
    this.flush();
    return this.pools;
  }

  async resolveTokens(addresses) {
    const known = this.configTokens ?? {};
    const todo = [...new Set(addresses.filter(Boolean).map((a) => a.toLowerCase()))]
      .filter((a) => this.tokens[a]?.decimals == null);
    if (!todo.length) return this.tokens;
    const symbols = await this.#readField(todo, 'symbol');
    const decimals = await this.#readField(todo, 'decimals');
    for (const addr of todo) {
      const d = decimals.get(addr);
      this.tokens[addr] = {
        symbol: symbols.get(addr) ?? known[addr]?.symbol ?? null,
        decimals: d != null ? Number(d) : (known[addr]?.decimals ?? null),
      };
    }
    this.flush();
    return this.tokens;
  }

  token(addr) { return this.tokens[addr?.toLowerCase()] ?? { symbol: null, decimals: null }; }
  pool(addr) { return this.pools[addr?.toLowerCase()] ?? null; }
}

// Map a resolved pool to a configured DEX key using its factory address.
export function makeVenueResolver(cfg) {
  const byFactory = {};
  for (const [key, d] of Object.entries(cfg.dexes ?? {})) {
    for (const f of [d.factory, d.poolManager, d.vault]) {
      if (f) byFactory[f.toLowerCase()] = key;
    }
  }
  return (poolMeta, family) => {
    if (poolMeta?.factory && byFactory[poolMeta.factory]) return byFactory[poolMeta.factory];
    // Fall back to the only configured DEX in that family, if unambiguous.
    const inFamily = Object.entries(cfg.dexes ?? {}).filter(([, d]) => d.family === family);
    if (inFamily.length === 1) return inFamily[0][0];
    return `unknown:${family}`;
  };
}

export { ABI as POOL_ABI, enc as encPool, dec as decPool, getAddress };
