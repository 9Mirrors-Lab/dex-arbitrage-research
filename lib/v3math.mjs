// Exact Uniswap V3 swap simulation against historical on-chain state.
//
// Why implement the maths instead of calling a deployed Quoter: a Quoter only
// works for pools created by the factory it was deployed against. Base's
// arbitrage happens largely on V3 *forks* (Aerodrome Slipstream x3, Aero,
// Solidly V3) that have no quoter we can rely on. Reproducing the pool's own
// arithmetic lets one code path price every fork, at any historical block.
//
// This is a faithful port of Uniswap V3's TickMath / SqrtPriceMath /
// SwapMath / TickBitmap. It is cross-checked against the deployed Uniswap
// QuoterV2 in scripts/03-validate-quotemath.mjs.

import { encodeFunctionData, decodeFunctionResult, parseAbi, decodeAbiParameters, parseAbiParameters } from 'viem';

const ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function tickBitmap(int16) view returns (uint256)',
  'function ticks(int24) view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128,int56 tickCumulativeOutside,uint160 secondsPerLiquidityOutsideX128,uint32 secondsOutside,bool initialized)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

const Q96 = 2n ** 96n;
const MAX_U256 = 2n ** 256n - 1n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const mulDiv = (a, b, d) => (a * b) / d;
const mulDivRoundUp = (a, b, d) => {
  const p = a * b;
  return p / d + (p % d === 0n ? 0n : 1n);
};
const divRoundUp = (a, b) => a / b + (a % b === 0n ? 0n : 1n);

export function getSqrtRatioAtTick(tick) {
  const absTick = BigInt(Math.abs(tick));
  if (absTick > BigInt(MAX_TICK)) throw new Error(`tick out of range: ${tick}`);
  const M = [
    0xfffcb933bd6fad37aa2d162d1a594001n, 0xfff97272373d413259a46990580e213an,
    0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
    0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n,
    0xff2ea16466c96a3843ec78b326b52861n, 0xfe5dee046a99a2a811c461f1969c3053n,
    0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
    0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n,
    0xd097f3bdfd2022b8845ad8f792aa5825n, 0xa9f746462d870fdf8a65dc1f90e061e5n,
    0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
    0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n,
    0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n,
  ];
  let ratio = (absTick & 1n) !== 0n ? M[0] : 1n << 128n;
  for (let i = 1; i < M.length; i++) {
    if ((absTick >> BigInt(i)) & 1n) ratio = (ratio * M[i]) >> 128n;
  }
  if (tick > 0) ratio = MAX_U256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

// Only needed to report the resulting tick; binary search is exact enough
// because getSqrtRatioAtTick is monotonic and we bracket to one tick.
export function getTickAtSqrtRatio(sqrtPriceX96) {
  let lo = MIN_TICK; let hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (getSqrtRatioAtTick(mid) <= sqrtPriceX96) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function getAmount0Delta(sqrtA, sqrtB, liquidity, roundUp) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const num1 = liquidity << 96n;
  const num2 = sqrtB - sqrtA;
  return roundUp
    ? divRoundUp(mulDivRoundUp(num1, num2, sqrtB), sqrtA)
    : mulDiv(num1, num2, sqrtB) / sqrtA;
}

function getAmount1Delta(sqrtA, sqrtB, liquidity, roundUp) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp ? mulDivRoundUp(liquidity, sqrtB - sqrtA, Q96) : mulDiv(liquidity, sqrtB - sqrtA, Q96);
}

function nextSqrtFromAmount0RoundingUp(sqrtP, liquidity, amount, add) {
  if (amount === 0n) return sqrtP;
  const num1 = liquidity << 96n;
  if (add) {
    const product = amount * sqrtP;
    if (product / amount === sqrtP) {
      const denom = num1 + product;
      if (denom >= num1) return mulDivRoundUp(num1, sqrtP, denom);
    }
    return divRoundUp(num1, num1 / sqrtP + amount);
  }
  const product = amount * sqrtP;
  const denom = num1 - product;
  return mulDivRoundUp(num1, sqrtP, denom);
}

function nextSqrtFromAmount1RoundingDown(sqrtP, liquidity, amount, add) {
  if (add) return sqrtP + mulDiv(amount, Q96, liquidity);
  const quotient = divRoundUp(amount << 96n, liquidity);
  return sqrtP - quotient;
}

function nextSqrtFromInput(sqrtP, liquidity, amountIn, zeroForOne) {
  return zeroForOne
    ? nextSqrtFromAmount0RoundingUp(sqrtP, liquidity, amountIn, true)
    : nextSqrtFromAmount1RoundingDown(sqrtP, liquidity, amountIn, true);
}

function computeSwapStep(sqrtCurrent, sqrtTarget, liquidity, amountRemaining, feePips) {
  const zeroForOne = sqrtCurrent >= sqrtTarget;
  const exactIn = amountRemaining >= 0n;
  let sqrtNext; let amountIn = 0n; let amountOut = 0n;
  const fp = BigInt(feePips);

  if (exactIn) {
    const amountRemainingLessFee = mulDiv(amountRemaining, 1000000n - fp, 1000000n);
    amountIn = zeroForOne
      ? getAmount0Delta(sqrtTarget, sqrtCurrent, liquidity, true)
      : getAmount1Delta(sqrtCurrent, sqrtTarget, liquidity, true);
    sqrtNext = amountRemainingLessFee >= amountIn
      ? sqrtTarget
      : nextSqrtFromInput(sqrtCurrent, liquidity, amountRemainingLessFee, zeroForOne);
  } else {
    amountOut = zeroForOne
      ? getAmount1Delta(sqrtTarget, sqrtCurrent, liquidity, false)
      : getAmount0Delta(sqrtCurrent, sqrtTarget, liquidity, false);
    const neg = -amountRemaining;
    sqrtNext = neg >= amountOut ? sqrtTarget : (() => {
      // getNextSqrtPriceFromOutput
      if (zeroForOne) return nextSqrtFromAmount1RoundingDown(sqrtCurrent, liquidity, neg, false);
      return nextSqrtFromAmount0RoundingUp(sqrtCurrent, liquidity, neg, false);
    })();
  }

  const max = sqrtTarget === sqrtNext;
  if (zeroForOne) {
    amountIn = max && exactIn ? amountIn : getAmount0Delta(sqrtNext, sqrtCurrent, liquidity, true);
    amountOut = max && !exactIn ? amountOut : getAmount1Delta(sqrtNext, sqrtCurrent, liquidity, false);
  } else {
    amountIn = max && exactIn ? amountIn : getAmount1Delta(sqrtCurrent, sqrtNext, liquidity, true);
    amountOut = max && !exactIn ? amountOut : getAmount0Delta(sqrtCurrent, sqrtNext, liquidity, false);
  }

  if (!exactIn && amountOut > -amountRemaining) amountOut = -amountRemaining;

  const feeAmount = (exactIn && sqrtNext !== sqrtTarget)
    ? amountRemaining - amountIn
    : mulDivRoundUp(amountIn, fp, 1000000n - fp);

  return { sqrtNext, amountIn, amountOut, feeAmount };
}

// Lazily reads and caches a pool's state at one block.
export class V3PoolState {
  constructor(rpc, pool, block) {
    this.rpc = rpc; this.pool = pool; this.block = block;
    this.bitmap = new Map(); this.ticks = new Map(); this.meta = null;
    this.rpcReads = 0;
  }

  async #call(fn, args) {
    this.rpcReads++;
    const r = await this.rpc.ethCall(this.pool, encodeFunctionData({ abi: ABI, functionName: fn, args }), this.block);
    if (r.error || !r.result || r.result === '0x') throw new Error(`${fn} failed on ${this.pool} @${this.block}: ${r.error?.message ?? 'empty'}`);
    return decodeFunctionResult({ abi: ABI, functionName: fn, data: r.result });
  }

  // slot0's tail differs between forks - Uniswap V3 returns 7 fields,
  // Aerodrome Slipstream returns 6 (no feeProtocol). Only the first two
  // fields matter here and they sit at the same offsets in every fork, so
  // decode just those from the raw words instead of matching a full tuple.
  async #slot0Head() {
    this.rpcReads++;
    const r = await this.rpc.ethCall(this.pool, '0x3850c7bd', this.block); // slot0()
    if (r.error || !r.result || r.result.length < 2 + 128) {
      throw new Error(`slot0 failed on ${this.pool} @${this.block}: ${r.error?.message ?? 'short response'}`);
    }
    const [sqrtPriceX96, tick] = decodeAbiParameters(parseAbiParameters('uint160,int24'), `0x${r.result.slice(2, 2 + 128)}`);
    return { sqrtPriceX96, tick: Number(tick) };
  }

  async load() {
    if (this.meta) return this.meta;
    const [head, liquidity, fee, tickSpacing, token0, token1] = await Promise.all([
      this.#slot0Head(), this.#call('liquidity'), this.#call('fee'),
      this.#call('tickSpacing'), this.#call('token0'), this.#call('token1'),
    ]);
    this.meta = {
      sqrtPriceX96: head.sqrtPriceX96, tick: head.tick, liquidity,
      fee: Number(fee), tickSpacing: Number(tickSpacing),
      token0: token0.toLowerCase(), token1: token1.toLowerCase(),
    };
    return this.meta;
  }

  async word(wordPos) {
    if (!this.bitmap.has(wordPos)) this.bitmap.set(wordPos, await this.#call('tickBitmap', [wordPos]));
    return this.bitmap.get(wordPos);
  }

  // Like slot0, the ticks() tuple differs between forks (trailing fields and
  // the final bool are not consistent), so decoding the whole tuple throws on
  // some pools. liquidityNet is the second word in every implementation, so
  // read just that word as an int128.
  async liquidityNet(tick) {
    if (this.ticks.has(tick)) return this.ticks.get(tick);
    this.rpcReads++;
    const data = encodeFunctionData({ abi: ABI, functionName: 'ticks', args: [tick] });
    const r = await this.rpc.ethCall(this.pool, data, this.block);
    if (r.error || !r.result || r.result.length < 2 + 128) {
      throw new Error(`ticks(${tick}) failed on ${this.pool} @${this.block}: ${r.error?.message ?? 'short response'}`);
    }
    const [liquidityNet] = decodeAbiParameters(parseAbiParameters('int128'), `0x${r.result.slice(2 + 64, 2 + 128)}`);
    this.ticks.set(tick, liquidityNet);
    return liquidityNet;
  }
}

const mostSignificantBit = (x) => { let r = 0; while (x > 1n) { x >>= 1n; r++; } return r; };
const leastSignificantBit = (x) => { let r = 0; while ((x & 1n) === 0n) { x >>= 1n; r++; } return r; };

async function nextInitializedTickWithinOneWord(state, tick, tickSpacing, lte) {
  // Solidity divides integers toward zero, then corrects for negatives.
  // Math.floor already rounds down, so using it here AND applying the
  // correction shifts the starting word by one and corrupts the traversal.
  let compressed = Math.trunc(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) compressed -= 1;
  if (lte) {
    const wordPos = compressed >> 8;
    const bitPos = compressed & 255;
    const mask = (1n << BigInt(bitPos)) - 1n + (1n << BigInt(bitPos));
    const masked = (await state.word(wordPos)) & mask;
    const initialized = masked !== 0n;
    const next = initialized
      ? (compressed - (bitPos - mostSignificantBit(masked))) * tickSpacing
      : (compressed - bitPos) * tickSpacing;
    return { next, initialized };
  }
  const c = compressed + 1;
  const wordPos = c >> 8;
  const bitPos = c & 255;
  const mask = ~((1n << BigInt(bitPos)) - 1n) & ((1n << 256n) - 1n);
  const masked = (await state.word(wordPos)) & mask;
  const initialized = masked !== 0n;
  const next = initialized
    ? (c + (leastSignificantBit(masked) - bitPos)) * tickSpacing
    : (c + (255 - bitPos)) * tickSpacing;
  return { next, initialized };
}

// Exact-input quote. Returns the output amount the pool would actually pay,
// having crossed every tick the trade crosses.
export async function quoteExactInputV3(state, { tokenIn, amountIn, feeOverride = null }) {
  const m = await state.load();
  const zeroForOne = tokenIn.toLowerCase() === m.token0;
  const fee = feeOverride ?? m.fee;
  const sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;

  let remaining = BigInt(amountIn);
  let calculated = 0n;
  let sqrtPriceX96 = m.sqrtPriceX96;
  let tick = m.tick;
  let liquidity = m.liquidity;
  let ticksCrossed = 0;
  let guard = 0;

  while (remaining !== 0n && sqrtPriceX96 !== sqrtPriceLimitX96) {
    if (++guard > 512) return { amountOut: -calculated, exhausted: true, ticksCrossed, reason: 'tick-crossing guard hit' };
    const start = sqrtPriceX96;
    let { next: tickNext, initialized } = await nextInitializedTickWithinOneWord(state, tick, m.tickSpacing, zeroForOne);
    if (tickNext < MIN_TICK) tickNext = MIN_TICK;
    if (tickNext > MAX_TICK) tickNext = MAX_TICK;
    const sqrtNextTick = getSqrtRatioAtTick(tickNext);
    const target = zeroForOne
      ? (sqrtNextTick < sqrtPriceLimitX96 ? sqrtPriceLimitX96 : sqrtNextTick)
      : (sqrtNextTick > sqrtPriceLimitX96 ? sqrtPriceLimitX96 : sqrtNextTick);

    const step = computeSwapStep(sqrtPriceX96, target, liquidity, remaining, fee);
    sqrtPriceX96 = step.sqrtNext;
    remaining -= step.amountIn + step.feeAmount;
    calculated -= step.amountOut;

    if (sqrtPriceX96 === sqrtNextTick) {
      if (initialized) {
        let net = await state.liquidityNet(tickNext);
        if (zeroForOne) net = -net;
        liquidity += net;
        ticksCrossed++;
      }
      tick = zeroForOne ? tickNext - 1 : tickNext;
    } else if (sqrtPriceX96 !== start) {
      tick = getTickAtSqrtRatio(sqrtPriceX96);
    }
    // Zero liquidity is not an error: the pool steps across the empty range to
    // the next initialised tick, exactly as the real contract does. The step
    // guard above is what protects against a non-progressing loop.
  }

  return {
    amountOut: -calculated,
    amountInUsed: BigInt(amountIn) - remaining,
    exhausted: remaining !== 0n,
    ticksCrossed,
    sqrtPriceAfter: sqrtPriceX96,
    rpcReads: state.rpcReads,
  };
}

export { ABI as V3_ABI };
