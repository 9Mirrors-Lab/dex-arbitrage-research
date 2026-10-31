// Pool state snapshot, screening prices, and the eligibility gate.
//
// IMPORTANT distinction, and the whole reason this file is separate from
// lib/quote.mjs: everything here is a SCREEN, not a quote.
//
// A screening price is a spot ratio derived from reserves or sqrtPrice. It
// tells us a pool has roughly $40k of depth and is therefore worth the expense
// of an exact quote. It is never evidence of profit. Stage 1 on Ethereum went
// wrong precisely by treating spot differences as opportunities, so the two
// concepts are kept in different files with different vocabulary:
//
//   screeningPriceUsd / depthUsd   — this file. Cheap, approximate, for ranking.
//   amountOut / netProfit          — lib/quote.mjs. Exact, protocol-aware.
//
// No number produced here may appear in a profitability claim.

import { parseAbi } from 'viem';
import { decodeCall, encodeCall, POOL_ABI } from './discovery.mjs';

export const STATE_ABI = POOL_ABI;
const Q96 = 2n ** 96n;

// A V3 pool's in-range liquidity converts to the "virtual reserves" of the
// constant-product curve it is currently on:  x = L/sqrtP,  y = L*sqrtP.
// That is the right depth proxy because it is the amount the pool can trade
// before it must cross a tick, which is exactly the size regime a screen cares
// about. It understates total depth for a pool with liquidity stacked in
// nearby ticks, so it is conservative in the safe direction.
export function virtualReservesFromV3(sqrtPriceX96, liquidity) {
  if (!sqrtPriceX96 || sqrtPriceX96 === 0n || !liquidity || liquidity === 0n) return { r0: 0n, r1: 0n };
  return { r0: (liquidity * Q96) / sqrtPriceX96, r1: (liquidity * sqrtPriceX96) / Q96 };
}

// slot0's tuple tail differs between V3 forks (Slipstream drops feeProtocol),
// so decoding the declared 7-field tuple throws on some pools. sqrtPriceX96 is
// the first word in every implementation; read just that word.
export function sqrtPriceFromSlot0(raw) {
  if (!raw || raw.length < 2 + 64) return null;
  try { return BigInt(`0x${raw.slice(2, 66)}`); } catch { return null; }
}

const V3_FAMILIES = new Set(['uniswap-v3', 'pancake-v3']);
const V2_FAMILIES = new Set(['uniswap-v2', 'solidly-v2']);

export function isV3Family(f) { return V3_FAMILIES.has(f); }
export function isV2Family(f) { return V2_FAMILIES.has(f); }

// ---------------------------------------------------------------------------
// Snapshot reserves / liquidity for many pools at one block
// ---------------------------------------------------------------------------
export async function snapshotState({ mc, registry, pools, block = 'latest', log = () => {} }) {
  const v3 = pools.filter((p) => isV3Family(p.family) && !p.singleton);
  const v2 = pools.filter((p) => isV2Family(p.family) && !p.singleton);

  if (v2.length) {
    const res = await mc.read(v2.map((p) => ({ target: p.id, callData: encodeCall(STATE_ABI, 'getReserves') })), { block });
    v2.forEach((p, k) => {
      const d = decodeCall(STATE_ABI, 'getReserves', res[k]);
      registry.upsertPool(p.id, {
        state: d
          ? { block, reserve0: String(d[0]), reserve1: String(d[1]), basis: 'getReserves()' }
          : { block, error: 'getReserves reverted or returned nothing', basis: 'getReserves()' },
        lastValidated: new Date().toISOString(),
      }, 'state-read');
    });
    log(`    state: ${v2.length} v2-family pools`);
  }

  if (v3.length) {
    const [slots, liqs] = [
      await mc.read(v3.map((p) => ({ target: p.id, callData: encodeCall(STATE_ABI, 'slot0') })), { block }),
      await mc.read(v3.map((p) => ({ target: p.id, callData: encodeCall(STATE_ABI, 'liquidity') })), { block }),
    ];
    v3.forEach((p, k) => {
      const sqrtP = sqrtPriceFromSlot0(slots[k]);
      const L = decodeCall(STATE_ABI, 'liquidity', liqs[k]);
      const liquidity = L != null ? BigInt(L) : null;
      const vr = sqrtP != null && liquidity != null ? virtualReservesFromV3(sqrtP, liquidity) : null;
      registry.upsertPool(p.id, {
        state: sqrtP != null && liquidity != null
          ? {
            block, sqrtPriceX96: String(sqrtP), liquidity: String(liquidity),
            reserve0: String(vr.r0), reserve1: String(vr.r1),
            basis: 'slot0()+liquidity() -> virtual reserves of the active range',
          }
          : { block, error: 'slot0/liquidity unreadable', basis: 'slot0()+liquidity()' },
        lastValidated: new Date().toISOString(),
      }, 'state-read');
    });
    log(`    state: ${v3.length} v3-family pools`);
  }

  return { v2: v2.length, v3: v3.length, skipped: pools.length - v2.length - v3.length };
}

// ---------------------------------------------------------------------------
// Screening price graph
// ---------------------------------------------------------------------------
// Anchors are the tokens whose USD value is asserted rather than derived:
// stablecoins at 1.00, which is the same assumption the forensics pass makes
// and is recorded as a known limitation. Every other price is propagated
// outward from an anchor through the deepest available pool, and each token
// records how many hops from an anchor it sits, so a long-tail token priced
// through three thin pools can be told apart from WETH.
const STABLE_SYMBOLS = new Set(['USDC', 'USDBC', 'USDT', 'DAI', 'USDC.E', 'EURC', 'USDS', 'USD+', 'LUSD', 'CRVUSD']);

// No single pool holds this much of one asset. A pool that claims to is
// either spoofed or non-standard, and must not be allowed to set a price —
// even for a genuine anchor token, whose address check it would otherwise pass.
const MAX_PLAUSIBLE_POOL_SIDE_USD = 5e9;

export function buildScreeningPrices({ registry, cfg, maxHops = 3, minPoolSideRaw = 10n ** 3n }) {
  const prices = new Map(); // token -> { usd, hops, via }
  const tok = (a) => registry.token(a);

  // ANCHORS COME FROM CONFIG ADDRESSES ONLY.
  //
  // An earlier version also anchored any token whose on-chain symbol() looked
  // like a stablecoin. A scam token that calls itself "USDT" was therefore
  // priced at $1.00, and because it sat in a pool against real WETH, it
  // propagated a WETH price of $1.2e21 — which then turned every genuine WETH
  // spread on the chain into a fictional multi-sextillion-dollar profit.
  //
  // This is the identity rule the registry is built on, applied here too: a
  // token's identity is its address. symbol() is attacker-controlled display
  // text and can never confer trust.
  for (const [sym, t] of Object.entries(cfg.tokens ?? {})) {
    if (STABLE_SYMBOLS.has(sym.toUpperCase())) {
      prices.set(t.address.toLowerCase(), { usd: 1, hops: 0, via: `anchor:${sym}=1.00 (config address ${t.address.toLowerCase()})` });
    }
  }

  // A spoofed pool must never set a price: its fabricated reserve ratio would
  // propagate a fabricated USD value to a real token.
  const pools = Object.values(registry.pools)
    .filter((p) => p.token0 && p.token1 && p.state && !p.state.error && !p.state.reservesSpoofed);

  // Two different quantities, and conflating them produces a wrong price.
  //
  // The RATIO must come from the reserves as reported. For a V3 pool those are
  // the virtual reserves of the active range, whose ratio IS the pool's price;
  // clamping either side to the token balance distorts that ratio. Doing so
  // priced Base WETH at $522 instead of about $2,320.
  //
  // The DEPTH must come from the clamped value, because a pool cannot trade
  // more of a token than it holds.
  const ratioRaw = (p, which) => {
    try { return BigInt(which === 0 ? p.state.reserve0 : p.state.reserve1); } catch { return 0n; }
  };
  const depthRaw = (p, which) => {
    try {
      const r = BigInt(which === 0 ? p.state.reserve0 : p.state.reserve1);
      const b = p.state[which === 0 ? 'balance0' : 'balance1'];
      if (b == null) return r;
      const bal = BigInt(b);
      return r < bal ? r : bal;
    } catch { return 0n; }
  };

  for (let hop = 1; hop <= maxHops; hop++) {
    const candidates = new Map(); // token -> best { usd, depth, via }
    for (const p of pools) {
      const d0 = tok(p.token0)?.decimals; const d1 = tok(p.token1)?.decimals;
      if (d0 == null || d1 == null) continue;
      const r0 = ratioRaw(p, 0); const r1 = ratioRaw(p, 1);
      if (r0 <= minPoolSideRaw || r1 <= minPoolSideRaw) continue;
      const a0 = Number(r0) / 10 ** d0; const a1 = Number(r1) / 10 ** d1;
      if (!(a0 > 0) || !(a1 > 0)) continue;
      // Tradeable amounts, for depth only.
      const t0a = Number(depthRaw(p, 0)) / 10 ** d0; const t1a = Number(depthRaw(p, 1)) / 10 ** d1;

      for (const [known, unknown, aKnown, aUnknown, tKnown] of [
        [p.token0, p.token1, a0, a1, t0a], [p.token1, p.token0, a1, a0, t1a],
      ]) {
        const kp = prices.get(known);
        if (!kp || kp.hops >= hop) continue;
        if (prices.has(unknown)) continue;
        // Screening price: the pool's own reserve ratio. Spot, not executable.
        const usd = (aKnown * kp.usd) / aUnknown;
        if (!Number.isFinite(usd) || usd <= 0) continue;
        const depthUsd = tKnown * kp.usd;
        // A pool claiming an implausible amount of the priced side is not
        // evidence of anything. Catches spoofed balances of a real anchor.
        if (!(depthUsd < MAX_PLAUSIBLE_POOL_SIDE_USD)) continue;
        const prev = candidates.get(unknown);
        if (!prev || depthUsd > prev.depth) {
          candidates.set(unknown, { usd, depth: depthUsd, via: `${p.venue ?? p.family} ${p.id.slice(0, 10)} vs ${tok(known)?.symbol ?? known.slice(0, 8)}` });
        }
      }
    }
    for (const [t, c] of candidates) prices.set(t, { usd: c.usd, hops: hop, via: c.via, pricingDepthUsd: c.depth });
    if (!candidates.size) break;
  }

  for (const [addr, p] of prices) {
    const t = registry.token(addr);
    if (t) {
      t.screeningPriceUsd = p.usd;
      t.priceHopsFromAnchor = p.hops;
      t.priceVia = p.via;
      // How much anchor-denominated value sat in the pool that set this
      // price. A consumer uses it to decide whether the price is strong
      // enough to carry a claim; a $300 pool's spot ratio is not.
      t.pricingDepthUsd = p.pricingDepthUsd ?? null;
      t.priceBasis = 'SCREENING ONLY — spot reserve ratio, never used in a profit calculation';
    }
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Eligibility gate
// ---------------------------------------------------------------------------
// A pool is eligible for route generation when it can plausibly execute a
// trade of the minimum size we would ever bother with. Pools failing this are
// kept in the registry and marked with the reason, because "too thin to trade"
// is a measured exclusion that belongs in the coverage ledger — not a silent
// drop and not a finding about profitability.
export function applyEligibility({ registry, prices, minDepthUsd = 500, minSideRaw = 10n ** 3n, requireVerifiedReserves = false }) {
  const reasons = {};
  let eligible = 0;
  const bump = (r) => { reasons[r] = (reasons[r] ?? 0) + 1; };

  for (const p of Object.values(registry.pools)) {
    const t0 = registry.token(p.token0); const t1 = registry.token(p.token1);
    let reason = null; let depthUsd = null;

    if (p.singleton) reason = 'singleton-pool-no-exact-quote-path';
    else if (!p.token0 || !p.token1) reason = 'token-identity-unresolved';
    else if (!isV2Family(p.family) && !isV3Family(p.family)) reason = `family-not-quotable:${p.family ?? 'unknown'}`;
    else if (String(p.venue ?? '').startsWith('unconfigured:')) reason = 'factory-not-configured';
    // A pool that does not report a factory cannot be tied to a known
    // protocol implementation, so which arithmetic prices it — and what fee
    // it charges — is an assumption rather than a fact. Two such pools drove
    // five of eleven "profitable" Ethereum candidates in an earlier run.
    else if (p.venue === 'unknown' || p.venue == null) reason = 'pool-implementation-not-identified';
    else if (!p.state) reason = 'state-not-snapshotted';
    else if (p.state.error) reason = 'state-unreadable';
    else if (t0?.decimals == null || t1?.decimals == null) reason = 'token-decimals-unresolved';
    else {
      let r0; let r1;
      try { r0 = BigInt(p.state.reserve0); r1 = BigInt(p.state.reserve1); } catch { r0 = 0n; r1 = 0n; }

      // A pool cannot pay out more of a token than it actually holds, so
      // reported reserves are cross-checked against the ERC-20 balances of
      // the pool address (scripts/27-verify-reserves.mjs).
      //
      // This is not a theoretical control. The first Ethereum run ranked its
      // whole queue by depth and put spoofed pools at the top: contracts whose
      // getReserves() claimed more WETH than exists, which the quote maths
      // faithfully turned into "profits" of $1.7e21. Anyone can deploy a
      // contract that answers getReserves() with any number; only the token
      // balance is hard to fake.
      if (p.state.balance0 != null && p.state.balance1 != null) {
        let b0; let b1;
        try { b0 = BigInt(p.state.balance0); b1 = BigInt(p.state.balance1); } catch { b0 = 0n; b1 = 0n; }
        // Clamp to what the pool holds, then judge depth on the clamped value.
        r0 = r0 < b0 ? r0 : b0;
        r1 = r1 < b1 ? r1 : b1;
        if (p.state.reservesSpoofed) reason = 'reported-reserves-exceed-token-balances';
      } else if (requireVerifiedReserves) {
        reason = 'reserves-not-verified-against-token-balances';
      }

      if (reason) { /* already decided */ }
      else if (r0 <= minSideRaw || r1 <= minSideRaw) reason = 'reserves-dust-or-empty';
      else {
        const p0 = prices.get(p.token0)?.usd; const p1 = prices.get(p.token1)?.usd;
        const v0 = p0 != null ? (Number(r0) / 10 ** t0.decimals) * p0 : null;
        const v1 = p1 != null ? (Number(r1) / 10 ** t1.decimals) * p1 : null;
        if (v0 == null && v1 == null) reason = 'no-screening-price-for-either-token';
        else {
          // Conservative: the shallower side bounds what a round trip can move.
          depthUsd = v0 != null && v1 != null ? Math.min(v0, v1) : (v0 ?? v1);
          if (!(depthUsd >= minDepthUsd)) reason = 'below-min-depth';
        }
      }
    }

    p.depthUsd = depthUsd;
    p.quotable = !p.singleton && (isV2Family(p.family) || isV3Family(p.family));
    p.quotableReason = p.quotable ? `exact quote available for family ${p.family}` : `no exact-quote implementation for family ${p.family ?? 'unknown'}`;
    p.eligible = reason == null;
    p.ineligibleReason = reason;
    if (reason) bump(reason); else eligible++;
  }
  return { eligible, total: Object.keys(registry.pools).length, reasons, minDepthUsd };
}
