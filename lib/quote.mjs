// One exact-quote interface across pool families, priced against historical
// on-chain state.
//
//   uniswap-v3 / pancake-v3 and every V3 fork -> local tick maths, validated
//     wei-for-wei against the deployed Uniswap QuoterV2
//     (scripts/03-validate-quotemath.mjs)
//   solidly-v2 (Aerodrome classic, volatile and stable) -> the pool's own
//     getAmountOut() view, so the venue's exact arithmetic including its
//     stable-pool invariant is used rather than a reimplementation
//   uniswap-v2 -> closed-form constant-product with the venue's fee
//
// Nothing here uses a displayed or off-chain price.

import { encodeFunctionData, decodeFunctionResult, parseAbi, decodeAbiParameters, parseAbiParameters } from 'viem';
import { V3PoolState, quoteExactInputV3, V3_ABI } from './v3math.mjs';

const ABI = parseAbi([
  'function getAmountOut(uint256,address) view returns (uint256)',
  'function getReserves() view returns (uint256,uint256,uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function stable() view returns (bool)',
]);

export class QuoteEngine {
  constructor(rpc, cfg) {
    this.rpc = rpc; this.cfg = cfg;
    this.v3 = new Map(); // `${pool}@${block}` -> V3PoolState (caches tick reads)
    this.v2 = new Map();
    this.calls = 0;
  }

  // Pre-load V3 pool state for many pools in a handful of batched calls.
  //
  // Without this, the first quote against each pool costs six serial eth_calls
  // (slot0, liquidity, fee, tickSpacing, token0, token1). Across a few thousand
  // pools on a rate-limited public endpoint that dominates the scan: measured
  // 0.4 routes/s before, with the cold reads accounting for nearly all of it.
  // Batched through Multicall3 the same reads cost about a minute in total.
  //
  // Only `meta` is pre-filled. Tick bitmap words and tick liquidity are still
  // read lazily, because a probe only needs them if it actually crosses a
  // tick, and most ladder probes do not.
  async prewarmV3({ mc, pools, block, log = () => {} }) {
    const ids = [...new Set(pools.map((p) => String(p).toLowerCase()))];
    if (!ids.length) return { prewarmed: 0, attempted: 0 };
    const fields = ['liquidity', 'fee', 'tickSpacing', 'token0', 'token1'];
    const got = {};
    // slot0's tuple tail differs between forks, so read the raw word and take
    // sqrtPriceX96 and tick from fixed offsets — the same approach V3PoolState
    // uses for exactly this reason.
    const slots = await mc.read(ids.map((id) => ({ target: id, callData: '0x3850c7bd' })), { block });
    for (const f of fields) {
      got[f] = await mc.read(ids.map((id) => ({ target: id, callData: encodeFunctionData({ abi: V3_ABI, functionName: f }) })), { block });
      log(`    prewarm: ${f} for ${ids.length} pools`);
    }

    let ok = 0;
    ids.forEach((id, k) => {
      const raw = slots[k];
      if (!raw || raw.length < 2 + 128) return;
      let head;
      try {
        head = decodeAbiParameters(parseAbiParameters('uint160,int24'), `0x${raw.slice(2, 2 + 128)}`);
      } catch { return; }
      const d = (f) => {
        try { return decodeFunctionResult({ abi: V3_ABI, functionName: f, data: got[f][k] }); } catch { return undefined; }
      };
      const liquidity = d('liquidity'); const fee = d('fee'); const tickSpacing = d('tickSpacing');
      const token0 = d('token0'); const token1 = d('token1');
      if (liquidity == null || fee == null || tickSpacing == null || !token0 || !token1) return;
      const st = new V3PoolState(this.rpc, id, block);
      st.meta = {
        sqrtPriceX96: head[0], tick: Number(head[1]), liquidity: BigInt(liquidity),
        fee: Number(fee), tickSpacing: Number(tickSpacing),
        token0: String(token0).toLowerCase(), token1: String(token1).toLowerCase(),
      };
      this.v3.set(`${id}@${block}`, st);
      ok++;
    });
    return { prewarmed: ok, attempted: ids.length };
  }

  // Second prewarm phase for V3 pools: the tick bitmap words around the
  // current tick, and the liquidityNet of every initialised tick inside them.
  //
  // A swap walks outward from the current tick, so these are exactly the
  // reads a quote will demand. Fetched lazily they are serial round trips
  // inside the hot loop; fetched here they are two batched passes.
  async prewarmV3Ticks({ mc, block, wordRadius = 2, maxTicksPerPool = 96, log = () => {} }) {
    const states = [...this.v3.entries()].filter(([k, s]) => k.endsWith(`@${block}`) && s.meta);
    if (!states.length) return { pools: 0, words: 0, ticks: 0 };

    // --- pass one: bitmap words
    const wordCalls = []; const wordMeta = [];
    for (const [, s] of states) {
      const { tick, tickSpacing } = s.meta;
      let compressed = Math.trunc(tick / tickSpacing);
      if (tick < 0 && tick % tickSpacing !== 0) compressed -= 1;
      const centre = compressed >> 8;
      for (let w = centre - wordRadius; w <= centre + wordRadius; w++) {
        wordCalls.push({ target: s.pool, callData: encodeFunctionData({ abi: V3_ABI, functionName: 'tickBitmap', args: [w] }) });
        wordMeta.push({ state: s, wordPos: w });
      }
    }
    const wordRes = await mc.read(wordCalls, { block });
    log(`    prewarm: ${wordCalls.length} tick bitmap words`);

    // --- decode which ticks are initialised, so only those are fetched
    const tickCalls = []; const tickMeta = [];
    const perPool = new Map();
    wordRes.forEach((d, k) => {
      const { state, wordPos } = wordMeta[k];
      let word;
      try { word = BigInt(decodeFunctionResult({ abi: V3_ABI, functionName: 'tickBitmap', data: d })); } catch { return; }
      state.bitmap.set(wordPos, word);
      if (word === 0n) return;
      const count = perPool.get(state.pool) ?? 0;
      if (count >= maxTicksPerPool) return;
      let added = 0;
      for (let bit = 0; bit < 256; bit++) {
        if (((word >> BigInt(bit)) & 1n) === 0n) continue;
        const tick = ((wordPos << 8) + bit) * state.meta.tickSpacing;
        tickCalls.push({ target: state.pool, callData: encodeFunctionData({ abi: V3_ABI, functionName: 'ticks', args: [tick] }) });
        tickMeta.push({ state, tick });
        added++;
        if (count + added >= maxTicksPerPool) break;
      }
      perPool.set(state.pool, count + added);
    });

    // --- pass two: liquidityNet. Like V3PoolState.liquidityNet, read the
    // second word as int128 rather than decoding the whole tuple, because the
    // ticks() tuple tail differs between forks.
    let ticksLoaded = 0;
    if (tickCalls.length) {
      const tickRes = await mc.read(tickCalls, { block });
      tickRes.forEach((d, k) => {
        if (!d || d.length < 2 + 128) return;
        const { state, tick } = tickMeta[k];
        try {
          const [net] = decodeAbiParameters(parseAbiParameters('int128'), `0x${d.slice(2 + 64, 2 + 128)}`);
          state.ticks.set(tick, net);
          ticksLoaded++;
        } catch { /* leave it to the lazy path */ }
      });
      log(`    prewarm: ${ticksLoaded} initialised ticks`);
    }
    return { pools: states.length, words: wordCalls.length, ticks: ticksLoaded };
  }

  // Quote many input sizes through one pool.
  //
  // This exists for solidly-v2, which is priced by calling the pool's own
  // getAmountOut() view — one network round trip per size. A ladder of eight
  // sizes across two legs is sixteen serial calls per route, which was the
  // single largest cost in the first scan. Batched through Multicall3 it is
  // one call per leg, and the venue's exact arithmetic is still what answers.
  async quoteExactInBatch({ pool, family, factory, tokenIn, amounts, block, mc = null }) {
    if (family === 'solidly-v2' && mc && amounts.length > 1) {
      const calls = amounts.map((a) => ({
        target: pool,
        callData: encodeFunctionData({ abi: ABI, functionName: 'getAmountOut', args: [a, tokenIn] }),
      }));
      const res = await mc.read(calls, { block });
      this.calls += amounts.length;
      return res.map((d) => {
        if (d == null) return { amountOut: null, reason: 'getAmountOut reverted or returned nothing' };
        try {
          return { amountOut: decodeFunctionResult({ abi: ABI, functionName: 'getAmountOut', data: d }), basis: `pool.getAmountOut() view @${block} (batched)` };
        } catch { return { amountOut: null, reason: 'getAmountOut decode failed' }; }
      });
    }
    const out = [];
    for (const a of amounts) out.push(await this.quoteExactIn({ pool, family, factory, tokenIn, amountIn: a, block }));
    return out;
  }

  // Pre-load V2-family reserves the same way.
  async prewarmV2({ mc, pools, block, log = () => {} }) {
    const ids = [...new Set(pools.map((p) => String(p).toLowerCase()))];
    if (!ids.length) return { prewarmed: 0, attempted: 0 };
    const [reserves, token0s, stables] = [
      await mc.read(ids.map((id) => ({ target: id, callData: encodeFunctionData({ abi: ABI, functionName: 'getReserves' }) })), { block }),
      await mc.read(ids.map((id) => ({ target: id, callData: encodeFunctionData({ abi: ABI, functionName: 'token0' }) })), { block }),
      await mc.read(ids.map((id) => ({ target: id, callData: encodeFunctionData({ abi: ABI, functionName: 'stable' }) })), { block }),
    ];
    log(`    prewarm: reserves for ${ids.length} v2-family pools`);
    let ok = 0;
    ids.forEach((id, k) => {
      let res; let t0; let stable = null;
      try { res = decodeFunctionResult({ abi: ABI, functionName: 'getReserves', data: reserves[k] }); } catch { return; }
      try { t0 = decodeFunctionResult({ abi: ABI, functionName: 'token0', data: token0s[k] }); } catch { return; }
      try { stable = decodeFunctionResult({ abi: ABI, functionName: 'stable', data: stables[k] }); } catch { stable = null; }
      if (!res || !t0) return;
      this.v2.set(`${id}@${block}`, {
        reserve0: BigInt(res[0]), reserve1: BigInt(res[1]), token0: String(t0).toLowerCase(), stable: stable ?? null,
      });
      ok++;
    });
    return { prewarmed: ok, attempted: ids.length };
  }

  #dexByFactory(factory) {
    for (const [key, d] of Object.entries(this.cfg.dexes ?? {})) {
      if (d.factory?.toLowerCase() === factory?.toLowerCase()) return { key, ...d };
    }
    return null;
  }

  async #v2State(pool, block) {
    const k = `${pool}@${block}`;
    if (this.v2.has(k)) return this.v2.get(k);
    const read = async (fn, args) => {
      this.calls++;
      const r = await this.rpc.ethCall(pool, encodeFunctionData({ abi: ABI, functionName: fn, args }), block);
      if (r.error || !r.result || r.result === '0x') return null;
      try { return decodeFunctionResult({ abi: ABI, functionName: fn, data: r.result }); } catch { return null; }
    };
    const [reserves, token0, stable] = await Promise.all([read('getReserves'), read('token0'), read('stable')]);
    const st = reserves ? { reserve0: BigInt(reserves[0]), reserve1: BigInt(reserves[1]), token0: String(token0).toLowerCase(), stable: stable ?? null } : null;
    this.v2.set(k, st);
    return st;
  }

  // Exact output for `amountIn` of `tokenIn` through `pool` at `block`.
  // Returns { amountOut, basis } or { amountOut: null, reason }.
  async quoteExactIn({ pool, family, factory, tokenIn, amountIn, block, feeBpsHint = null }) {
    if (amountIn <= 0n) return { amountOut: 0n, basis: 'zero input' };

    if (family === 'uniswap-v3' || family === 'pancake-v3') {
      const k = `${pool}@${block}`;
      if (!this.v3.has(k)) this.v3.set(k, new V3PoolState(this.rpc, pool, block));
      try {
        const res = await quoteExactInputV3(this.v3.get(k), { tokenIn, amountIn });
        this.calls += 1;
        if (res.exhausted) return { amountOut: res.amountOut, exhausted: true, ticksCrossed: res.ticksCrossed, basis: `local V3 tick maths @${block} (input not fully consumed: ${res.reason ?? 'price limit'})` };
        return { amountOut: res.amountOut, ticksCrossed: res.ticksCrossed, basis: `local V3 tick maths @${block}` };
      } catch (e) {
        return { amountOut: null, reason: `V3 state read failed: ${String(e.message).slice(0, 90)}` };
      }
    }

    if (family === 'solidly-v2') {
      this.calls++;
      const r = await this.rpc.ethCall(pool, encodeFunctionData({ abi: ABI, functionName: 'getAmountOut', args: [amountIn, tokenIn] }), block);
      if (r.error || !r.result || r.result === '0x') return { amountOut: null, reason: `getAmountOut reverted: ${r.error?.message?.slice(0, 80) ?? 'empty'}` };
      try {
        return { amountOut: decodeFunctionResult({ abi: ABI, functionName: 'getAmountOut', data: r.result }), basis: `pool.getAmountOut() view @${block}` };
      } catch { return { amountOut: null, reason: 'getAmountOut decode failed' }; }
    }

    if (family === 'uniswap-v2') {
      const st = await this.#v2State(pool, block);
      if (!st) return { amountOut: null, reason: 'getReserves failed' };
      const dex = this.#dexByFactory(factory);
      const feeBps = BigInt(feeBpsHint ?? dex?.feeBps ?? 30);
      const zeroForOne = tokenIn.toLowerCase() === st.token0;
      const [rIn, rOut] = zeroForOne ? [st.reserve0, st.reserve1] : [st.reserve1, st.reserve0];
      if (rIn === 0n || rOut === 0n) return { amountOut: null, reason: 'empty reserves' };
      const inWithFee = amountIn * (10000n - feeBps);
      const amountOut = (inWithFee * rOut) / (rIn * 10000n + inWithFee);
      return { amountOut, basis: `constant product on getReserves() @${block}, fee ${feeBps} bps` };
    }

    return { amountOut: null, reason: `no exact quote path for family ${family}` };
  }
}

// Maximise net profit over input size. The profit curve of a two-pool
// arbitrage is unimodal in size, so a ternary search on integers finds the
// optimum; each probe is a full exact quote through both pools.
export async function optimalSize({ quoteCycle, lo, hi, iterations = 42 }) {
  let a = lo; let b = hi;
  const seen = new Map();
  const f = async (x) => {
    if (seen.has(x.toString())) return seen.get(x.toString());
    const v = await quoteCycle(x);
    seen.set(x.toString(), v);
    return v;
  };
  for (let i = 0; i < iterations && b - a > 1n; i++) {
    const m1 = a + (b - a) / 3n;
    const m2 = b - (b - a) / 3n;
    const [p1, p2] = [await f(m1), await f(m2)];
    if ((p1?.profit ?? -1n) < (p2?.profit ?? -1n)) a = m1 + 1n; else b = m2 - 1n;
  }
  let best = null;
  for (const x of [a, b, a + (b - a) / 2n]) {
    const v = await f(x);
    if (v && (best == null || v.profit > best.profit)) best = { ...v, size: x };
  }
  return { best, probes: seen.size };
}
