// Reserve verification: cross-check what a pool CLAIMS against what it HOLDS.
//
//   node scripts/27-verify-reserves.mjs --chain base
//
// Why this exists, concretely. The first Ethereum scan ranked its route queue
// by screening depth and reported fourteen CAPTURE CANDIDATEs with net profits
// up to $1.7e21. Every one was a pool whose getReserves() claimed more WETH
// than exists on Earth. The quote maths was correct; the input was fabricated.
//
// Anyone can deploy a contract that answers getReserves(), token0(), token1()
// and even slot0() with arbitrary values, and such pools are abundant on both
// chains. What cannot be faked cheaply is the pool's actual ERC-20 balance,
// because a pool can only pay out tokens it holds. So for every pool this
// reads balanceOf(pool) on both tokens and:
//
//   * clamps depth to the real balance,
//   * marks a pool whose reported reserves materially exceed its balances as
//     `reservesSpoofed`, which excludes it from routes and from price
//     propagation — recorded with a reason, not deleted,
//   * re-derives screening prices from verified reserves only,
//   * re-applies the eligibility gate.
//
// A V3 pool is treated differently. Its "reserves" here are the virtual
// reserves of the active tick range, which can legitimately exceed the token
// balance, so exceeding a balance is not evidence of spoofing for V3 — the
// balance is used only to clamp depth.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Rpc, loadChain } from '../lib/rpc.mjs';
import { Multicall } from '../lib/multicall.mjs';
import { PoolRegistry } from '../lib/poolregistry.mjs';
import { ERC20_ABI, encodeCall, decodeCall } from '../lib/discovery.mjs';
import { buildScreeningPrices, applyEligibility, isV2Family } from '../lib/marketstate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

const chainId = argOf('chain', 'base');
const minDepthUsd = Number(argOf('min-depth', 500));
// A V2 pair's reserves track its balances exactly except for unsynced donated
// tokens, which only ever make the balance LARGER. So reserves above balance
// are the suspicious direction, and a 0.5% tolerance absorbs rounding and any
// fee-on-transfer accounting quirk.
const SPOOF_TOLERANCE = 1.005;

const cfg = loadChain(chainId);
const rpc = new Rpc(cfg.rpc, { concurrency: 16 });
const mc = new Multicall(rpc, cfg.multicall3, { batch: 400, parallel: 5 });
const reg = new PoolRegistry(chainId);

const block = argOf('block') ? Number(argOf('block')) : null;
const targets = Object.values(reg.pools).filter((p) => !p.singleton && p.token0 && p.token1 && p.state && !p.state.error);

console.log(`\n=== reserve verification — ${cfg.name} ===`);
console.log(`${targets.length} pools with a state snapshot to verify\n`);

const stateBlock = block ?? targets[0]?.state?.block ?? 'latest';
const pw = (s) => process.stdout.write(`\r  ${s}`.padEnd(90));

// balanceOf(pool) for both tokens, at the same block as the snapshot.
const calls = [];
for (const p of targets) {
  calls.push({ target: p.token0, callData: encodeCall(ERC20_ABI, 'balanceOf', [p.id]) });
  calls.push({ target: p.token1, callData: encodeCall(ERC20_ABI, 'balanceOf', [p.id]) });
}
const res = await mc.read(calls, { block: stateBlock, onProgress: (d, t) => pw(`balanceOf ${d}/${t}`) });
process.stdout.write('\n');

let spoofed = 0; let unreadable = 0; let verified = 0; let clamped = 0;
const spoofExamples = [];

targets.forEach((p, i) => {
  const b0 = decodeCall(ERC20_ABI, 'balanceOf', res[i * 2]);
  const b1 = decodeCall(ERC20_ABI, 'balanceOf', res[i * 2 + 1]);
  if (b0 == null || b1 == null) {
    p.state.balanceCheck = 'unreadable';
    unreadable++;
    return;
  }
  const bal0 = BigInt(b0); const bal1 = BigInt(b1);
  p.state.balance0 = String(bal0);
  p.state.balance1 = String(bal1);
  p.state.balanceBlock = stateBlock;

  let r0; let r1;
  try { r0 = BigInt(p.state.reserve0); r1 = BigInt(p.state.reserve1); } catch { r0 = 0n; r1 = 0n; }

  // Spoofing is only decidable for a constant-product pool, where reserves
  // are supposed to equal balances.
  if (isV2Family(p.family)) {
    const tol = (b) => (b * BigInt(Math.round(SPOOF_TOLERANCE * 1000))) / 1000n;
    const bad = r0 > tol(bal0) || r1 > tol(bal1);
    p.state.reservesSpoofed = bad;
    p.state.balanceCheck = bad ? 'reported reserves exceed token balances' : 'reserves match token balances';
    if (bad) {
      spoofed++;
      if (spoofExamples.length < 25) {
        spoofExamples.push({
          pool: p.id, venue: p.venue, pair: p.pair,
          reserve0: String(r0), balance0: String(bal0),
          reserve1: String(r1), balance1: String(bal1),
          claimedDepthUsd: p.depthUsd ?? null,
        });
      }
    } else verified++;
  } else {
    p.state.reservesSpoofed = false;
    p.state.balanceCheck = 'virtual reserves clamped to token balance (V3: exceeding a balance is legitimate)';
    if (r0 > bal0 || r1 > bal1) clamped++;
    verified++;
  }
});

reg.save();

console.log(`  verified            ${String(verified).padStart(8)}`);
console.log(`  spoofed reserves    ${String(spoofed).padStart(8)}  <- excluded from routes and from price propagation`);
console.log(`  depth clamped (V3)  ${String(clamped).padStart(8)}`);
console.log(`  balanceOf unreadable${String(unreadable).padStart(8)}`);

// Re-derive prices and eligibility from verified data only.
console.log('\nre-screening with verified reserves');
const prices = buildScreeningPrices({ registry: reg, cfg });
const elig = applyEligibility({ registry: reg, prices, minDepthUsd, requireVerifiedReserves: true });
reg.recomputeTokenPoolCounts();
reg.save();

const byPair = reg.indexByPair({ eligibleOnly: true });
const multi = [...byPair.entries()].filter(([, v]) => v.length >= 2);
const routes = multi.reduce((a, [, v]) => a + (v.length * (v.length - 1)) / 2, 0);

const out = {
  chain: chainId, verifiedAt: new Date().toISOString(), stateBlock,
  poolsChecked: targets.length, verified, spoofed, clampedV3: clamped, balanceUnreadable: unreadable,
  spoofTolerance: SPOOF_TOLERANCE,
  method: 'balanceOf(pool) for both tokens at the snapshot block; a constant-product pool whose reported reserves exceed its balances by more than the tolerance is marked reservesSpoofed',
  afterVerification: {
    pricedTokens: prices.size,
    eligiblePools: elig.eligible,
    eligiblePairs: byPair.size,
    eligiblePairsWithTwoOrMorePools: multi.length,
    twoPoolRoutes: routes,
    directionalTwoPoolRoutes: routes * 2,
  },
  ineligibilityReasons: elig.reasons,
  spoofExamples,
};
writeFileSync(join(ROOT, 'data', `verification-${chainId}.json`), `${JSON.stringify(out, null, 2)}\n`);

console.log(`  priced tokens               ${String(prices.size).padStart(8)}`);
console.log(`  eligible pools              ${String(elig.eligible).padStart(8)}`);
console.log(`  eligible pairs with 2+ pools${String(multi.length).padStart(8)}`);
console.log(`  directional two-pool routes ${String(routes * 2).padStart(8)}`);
console.log('\nineligibility reasons');
for (const [r, v] of Object.entries(elig.reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${r.padEnd(46)} ${String(v).padStart(8)}`);
console.log(`\nwrote data/verification-${chainId}.json`);
