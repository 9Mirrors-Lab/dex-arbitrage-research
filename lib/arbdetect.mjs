// Atomic-arbitrage detection from a single transaction receipt.
//
// The detector builds the operator's complete balance sheet for the
// transaction and values it in USD. Working in USD rather than raw token units
// is not cosmetic: raw integers are not comparable across tokens with
// different decimals, and comparing them directly makes a 1500 USDC outflow
// (1.5e9 raw) look negligible next to a 0.66 WETH inflow (6.6e17 raw).
//
// Token prices come from the executed rates inside the same transaction,
// chained back to WETH or a stablecoin. That is the most defensible basis
// available: it is the price the trade actually got, at that block.

import { toEventSelector, decodeAbiParameters, parseAbiParameters } from 'viem';

export const NATIVE = '0x0000000000000000000000000000000000000000';
const DEPOSIT = toEventSelector('Deposit(address,uint256)');
const WITHDRAWAL = toEventSelector('Withdrawal(address,uint256)');
const lc = (s) => (s ?? '').toLowerCase();

// Normalise a decoded swap into (tokenIn, amountIn, tokenOut, amountOut).
// Input amounts are pool-perspective deltas (see lib/events.mjs).
export function swapLeg(swap, poolMeta, v4pools) {
  if (swap.family === 'balancer-v2') {
    return { tokenIn: lc(swap.tokenIn), amountIn: swap.amountIn, tokenOut: lc(swap.tokenOut), amountOut: swap.amountOut, resolved: true };
  }
  let token0; let token1;
  if (swap.family === 'uniswap-v4') {
    const p = v4pools?.pools?.[swap.poolId];
    if (!p) return { resolved: false, reason: 'v4 poolId not in registry', poolId: swap.poolId };
    token0 = p.currency0; token1 = p.currency1;
  } else {
    if (!poolMeta?.token0 || !poolMeta?.token1) return { resolved: false, reason: 'pool tokens unresolved', pool: swap.pool };
    token0 = poolMeta.token0; token1 = poolMeta.token1;
  }
  const a0 = swap.amount0; const a1 = swap.amount1;
  if (a0 === 0n && a1 === 0n) return { resolved: false, reason: 'zero-amount swap' };
  const inIs0 = a0 > 0n;
  return {
    tokenIn: inIs0 ? token0 : token1,
    amountIn: inIs0 ? a0 : a1,
    tokenOut: inIs0 ? token1 : token0,
    amountOut: inIs0 ? -a1 : -a0,
    resolved: true,
  };
}

// Human-unit exchange rates observed in this transaction, both directions.
export function buildRateGraph(legs, decimalsOf) {
  const g = new Map();
  const add = (a, b, rate) => {
    if (!Number.isFinite(rate) || rate <= 0) return;
    if (!g.has(a)) g.set(a, new Map());
    // Keep the rate from the largest leg: deeper trades price better.
    g.get(a).set(b, rate);
  };
  for (const l of legs) {
    if (!l.resolved || l.amountIn <= 0n || l.amountOut <= 0n) continue;
    const di = decimalsOf(l.tokenIn); const dout = decimalsOf(l.tokenOut);
    if (di == null || dout == null) continue;
    const hi = Number(l.amountIn) / 10 ** di;
    const ho = Number(l.amountOut) / 10 ** dout;
    if (hi <= 0 || ho <= 0) continue;
    add(l.tokenIn, l.tokenOut, ho / hi);
    add(l.tokenOut, l.tokenIn, hi / ho);
  }
  return g;
}

// USD per human unit of `token`, found by walking the in-transaction rate
// graph to an anchor whose USD price is known.
export function priceViaGraph(token, graph, anchors) {
  if (anchors.has(token)) return { usd: anchors.get(token), hops: 0, basis: 'anchor' };
  const seen = new Set([token]);
  let frontier = [[token, 1]];
  for (let hop = 1; hop <= 4; hop++) {
    const next = [];
    for (const [t, acc] of frontier) {
      for (const [nb, rate] of graph.get(t) ?? []) {
        if (seen.has(nb)) continue;
        const accNext = acc * rate; // units of nb per unit of `token`
        if (anchors.has(nb)) {
          return { usd: accNext * anchors.get(nb), hops: hop, basis: `in-tx rate path (${hop} hop${hop > 1 ? 's' : ''})` };
        }
        seen.add(nb);
        next.push([nb, accNext]);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return { usd: null, basis: 'no in-tx path to a priced anchor' };
}

// Full per-address, per-token ledger for one transaction, including the
// native-ETH legs that ERC-20 Transfer logs cannot show.
export function buildLedger({ receipt, txValue, swaps, transfers, poolMetaOf, v4pools, wethAddress }) {
  const from = lc(receipt.from);
  const to = lc(receipt.to);
  const entity = new Set([from, to].filter(Boolean));

  const legs = swaps.map((s) => ({ ...swapLeg(s, poolMetaOf(s.pool), v4pools), swap: s }));
  const unresolvedLegs = legs.filter((l) => !l.resolved);

  const byAddr = new Map();
  const bump = (addr, token, delta) => {
    if (!byAddr.has(addr)) byAddr.set(addr, new Map());
    const m = byAddr.get(addr);
    m.set(token, (m.get(token) ?? 0n) + delta);
  };
  for (const t of transfers) { bump(t.from, t.token, -t.value); bump(t.to, t.token, t.value); }

  // WETH wrap/unwrap emits no Transfer, so patch both sides in.
  let wrapEvents = 0;
  for (const log of receipt.logs) {
    if (lc(log.address) !== wethAddress) continue;
    const who = log.topics?.[1] ? lc(`0x${log.topics[1].slice(26)}`) : null;
    if (!who) continue;
    let wad;
    try { [wad] = decodeAbiParameters(parseAbiParameters('uint256'), log.data); } catch { continue; }
    if (log.topics[0] === DEPOSIT) { bump(who, wethAddress, wad); bump(who, NATIVE, -wad); wrapEvents++; }
    if (log.topics[0] === WITHDRAWAL) { bump(who, wethAddress, -wad); bump(who, NATIVE, wad); wrapEvents++; }
  }

  // Native-ETH swap legs (Uniswap V4 pools whose currency is address(0)).
  // The pool side is known; the counterparty is the transaction's operator.
  let nativeLegs = 0;
  for (const l of legs) {
    if (!l.resolved) continue;
    if (l.tokenIn === NATIVE) { bump(to || from, NATIVE, -l.amountIn); nativeLegs++; }
    if (l.tokenOut === NATIVE) { bump(to || from, NATIVE, l.amountOut); nativeLegs++; }
  }

  const poolSet = new Set();
  for (const s of swaps) poolSet.add(s.pool);
  // Uniswap V4's singleton holds pool balances; treat it as a pool.
  for (const l of legs) if (l.swap?.family === 'uniswap-v4') poolSet.add(lc(receipt.logs.find((g) => g.topics?.[1] === l.swap.poolId)?.address ?? ''));

  const entityNet = new Map();
  for (const addr of entity) {
    for (const [token, v] of byAddr.get(addr) ?? []) entityNet.set(token, (entityNet.get(token) ?? 0n) + v);
  }

  return {
    from, to, entity, legs, unresolvedLegs, byAddr, poolSet, entityNet,
    txValue: BigInt(txValue ?? 0),
    flags: {
      unresolvedSwapLegs: unresolvedLegs.length,
      nativeSwapLegs: nativeLegs,
      wrapEvents,
      txValueNonZero: BigInt(txValue ?? 0) > 0n,
    },
  };
}

// Decide what the transaction is, in USD terms.
//   usdOf(token, rawAmount) -> { usd|null, basis }
// Materiality is an absolute USD floor; anything smaller is rounding dust.
export function classifyLedger(ledger, usdOf, { materialUsd = 0.01, fundingAddrs = new Set() } = {}) {
  const priced = [];
  let unpriceable = 0;
  for (const [token, raw] of ledger.entityNet) {
    if (raw === 0n) continue;
    const p = usdOf(token, raw);
    if (p.usd == null) { unpriceable++; priced.push({ token, raw: raw.toString(), usd: null, basis: p.basis }); continue; }
    priced.push({ token, raw: raw.toString(), usd: p.usd, basis: p.basis });
  }
  const materialUnpriced = priced.filter((p) => p.usd == null).length;
  const grossUsd = priced.reduce((a, p) => a + (p.usd ?? 0), 0);

  if (ledger.flags.unresolvedSwapLegs > 0) {
    return { kind: 'unverified', reason: 'swap legs could not be resolved to tokens', grossUsd: null, legsPriced: priced };
  }
  if (materialUnpriced > 0) {
    return { kind: 'unverified', reason: `${materialUnpriced} balance-sheet leg(s) could not be priced from on-chain state`, grossUsd: null, legsPriced: priced };
  }

  // Did anyone outside the operator pay for this?
  const thirdParty = [];
  for (const [addr, m] of ledger.byAddr) {
    if (ledger.entity.has(addr) || ledger.poolSet.has(addr) || fundingAddrs.has(addr) || addr === NATIVE) continue;
    let net = 0;
    for (const [token, raw] of m) {
      if (raw === 0n) continue;
      const p = usdOf(token, raw);
      if (p.usd != null) net += p.usd;
    }
    if (net < -materialUsd) thirdParty.push({ addr, netUsd: net });
  }

  if (grossUsd <= materialUsd) {
    return { kind: 'not-profitable', reason: 'operator balance sheet does not end up materially positive', grossUsd, legsPriced: priced, thirdParty };
  }
  if (thirdParty.length) {
    return { kind: 'third-party-funded', reason: 'a non-pool third party funded the trade (user swap, router fee or transfer)', grossUsd, legsPriced: priced, thirdParty };
  }

  // A closed arbitrage cycle ends up ahead in exactly one token; the rest of
  // the cycle nets to dust. Gains in two or more tokens at once mean the
  // transaction did something other than trade a cycle - withdrawing
  // liquidity, collecting fees, claiming rewards, a liquidation. Those are
  // real balance changes but they are not arbitrage profit, and they are not
  // repeatable by a trading bot, so they are reported separately.
  const floor = Math.max(materialUsd, grossUsd * 0.01);
  const materialGains = priced.filter((p) => (p.usd ?? 0) > floor);
  if (materialGains.length > 1) {
    return {
      kind: 'multi-token-gain',
      reason: `operator ends ahead in ${materialGains.length} tokens at once (${materialGains.map((g) => g.token.slice(0, 10)).join(', ')}), which a closed trading cycle cannot do`,
      grossUsd, legsPriced: priced, thirdParty,
    };
  }

  return { kind: 'self-funded-arb', grossUsd, legsPriced: priced, thirdParty: [] };
}
