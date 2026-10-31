// Event signatures used by the forensics pass. Topic0 values are derived with
// viem rather than hardcoded, so a typo cannot silently drop a whole venue.

import { toEventSelector, decodeAbiParameters, parseAbiParameters } from 'viem';

const sig = (s) => toEventSelector(s);

// --- AMM swap events, keyed by topic0 -------------------------------------
// `family` is what the decoder needs to know; several venues share a family.
//
// NORMALISATION: every decoder returns amount0/amount1 as the *pool's* balance
// delta - positive means the pool received that token (it is the token going
// in), negative means the pool paid it out. Uniswap V2/V3 already emit this
// convention; Uniswap V4 emits the swapper's perspective and is negated below.
// Verified empirically against PoolManager ERC-20 transfers on Base.
export const SWAP_EVENTS = {
  [sig('Swap(address,uint256,uint256,uint256,uint256,address)')]: {
    name: 'UniV2Swap', family: 'uniswap-v2',
    // sender indexed, to indexed; data = amount0In, amount1In, amount0Out, amount1Out
    decode: (log) => {
      const [a0i, a1i, a0o, a1o] = decodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'), log.data);
      return { amount0: a0i - a0o, amount1: a1i - a1o };
    },
  },
  [sig('Swap(address,address,uint256,uint256,uint256,uint256)')]: {
    name: 'SolidlySwap', family: 'solidly-v2',
    // Aerodrome/Velodrome: sender indexed, to indexed; data = amount0In, amount1In, amount0Out, amount1Out
    decode: (log) => {
      const [a0i, a1i, a0o, a1o] = decodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'), log.data);
      return { amount0: a0i - a0o, amount1: a1i - a1o };
    },
  },
  [sig('Swap(address,address,int256,int256,uint160,uint128,int24)')]: {
    name: 'UniV3Swap', family: 'uniswap-v3',
    decode: (log) => {
      const [a0, a1, sqrtP, liq, tick] = decodeAbiParameters(
        parseAbiParameters('int256,int256,uint160,uint128,int24'), log.data);
      return { amount0: a0, amount1: a1, sqrtPriceX96: sqrtP, liquidity: liq, tick };
    },
  },
  [sig('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)')]: {
    name: 'PancakeV3Swap', family: 'pancake-v3',
    decode: (log) => {
      const [a0, a1, sqrtP, liq, tick] = decodeAbiParameters(
        parseAbiParameters('int256,int256,uint160,uint128,int24,uint128,uint128'), log.data);
      return { amount0: a0, amount1: a1, sqrtPriceX96: sqrtP, liquidity: liq, tick };
    },
  },
  [sig('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)')]: {
    name: 'UniV4Swap', family: 'uniswap-v4',
    decode: (log) => {
      const [a0, a1, sqrtP, liq, tick, fee] = decodeAbiParameters(
        parseAbiParameters('int128,int128,uint160,uint128,int24,uint24'), log.data);
      // V4 emits the swapper's delta; negate to get the pool's delta.
      return { amount0: -a0, amount1: -a1, sqrtPriceX96: sqrtP, liquidity: liq, tick, fee, poolId: log.topics[1] };
    },
  },
  [sig('Swap(bytes32,address,address,uint256,uint256)')]: {
    name: 'BalancerV2Swap', family: 'balancer-v2',
    decode: (log) => {
      const [amountIn, amountOut] = decodeAbiParameters(parseAbiParameters('uint256,uint256'), log.data);
      return {
        poolId: log.topics[1],
        tokenIn: `0x${log.topics[2].slice(26)}`,
        tokenOut: `0x${log.topics[3].slice(26)}`,
        amountIn, amountOut,
      };
    },
  },
};

export const TRANSFER_TOPIC = sig('Transfer(address,address,uint256)');

// --- funding / credit events ---------------------------------------------
export const FUNDING_EVENTS = {
  [sig('FlashLoan(address,address,uint256,uint256)')]: { provider: 'balancer-v2', kind: 'flash-loan' },
  [sig('FlashLoan(address,address,address,uint256,uint8,uint256,uint16)')]: { provider: 'aave-v3', kind: 'flash-loan' },
  [sig('Flash(address,address,uint256,uint256,uint256,uint256)')]: { provider: 'uniswap-v3-flash', kind: 'pool-native-credit' },
  [sig('FlashLoan(address,address,uint256)')]: { provider: 'morpho-blue', kind: 'flash-loan' },
};

// --- liquidity management -------------------------------------------------
// A transaction that adds or removes liquidity moves the operator's own
// capital. Its balance sheet can look exactly like a large arbitrage profit
// (tokens arrive from a pool, nothing is paid), so these must be excluded
// before any profit is attributed. Missing this counts an LP withdrawing a
// position as a six-figure arbitrage.
export const LIQUIDITY_EVENTS = {
  [sig('Mint(address,address,int24,int24,uint128,uint256,uint256)')]: 'uniswap-v3 Mint',
  [sig('Burn(address,int24,int24,uint128,uint256,uint256)')]: 'uniswap-v3 Burn',
  [sig('Collect(address,address,int24,int24,uint128,uint128)')]: 'uniswap-v3 Collect',
  [sig('Mint(address,uint256,uint256)')]: 'uniswap-v2 Mint',
  [sig('Burn(address,uint256,uint256,address)')]: 'uniswap-v2 Burn',
  [sig('Burn(address,address,uint256,uint256)')]: 'solidly Burn',
  [sig('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)')]: 'uniswap-v4 ModifyLiquidity',
  [sig('IncreaseLiquidity(uint256,uint128,uint256,uint256)')]: 'position manager IncreaseLiquidity',
  [sig('DecreaseLiquidity(uint256,uint128,uint256,uint256)')]: 'position manager DecreaseLiquidity',
  [sig('CollectFees(address,uint256,uint256)')]: 'solidly CollectFees',
  [sig('PoolBalanceChanged(bytes32,address,address[],int256[],uint256[])')]: 'balancer PoolBalanceChanged',
};

export const SWAP_TOPICS = Object.keys(SWAP_EVENTS);
export const FUNDING_TOPICS = Object.keys(FUNDING_EVENTS);
export const LIQUIDITY_TOPICS = new Set(Object.keys(LIQUIDITY_EVENTS));

export function liquidityEventsIn(logs) {
  const found = [];
  for (const log of logs ?? []) {
    const name = LIQUIDITY_EVENTS[log.topics?.[0]];
    if (name) found.push({ name, address: log.address.toLowerCase() });
  }
  return found;
}

export function decodeSwap(log) {
  const spec = SWAP_EVENTS[log.topics?.[0]];
  if (!spec) return null;
  try {
    return { ...spec.decode(log), event: spec.name, family: spec.family, pool: log.address.toLowerCase() };
  } catch {
    return null;
  }
}

export function decodeTransfer(log) {
  if (log.topics?.[0] !== TRANSFER_TOPIC) return null;
  // Skip ERC-721 style (3 indexed args) — tokenId, not an amount.
  if (log.topics.length !== 3 || !log.data || log.data === '0x') return null;
  try {
    const [value] = decodeAbiParameters(parseAbiParameters('uint256'), log.data);
    return {
      token: log.address.toLowerCase(),
      from: `0x${log.topics[1].slice(26)}`.toLowerCase(),
      to: `0x${log.topics[2].slice(26)}`.toLowerCase(),
      value,
    };
  } catch {
    return null;
  }
}
