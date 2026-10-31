// PART 3 - the investigation ledger.
//
// Writes registry.json from the measured data, applying the VALIDATED gate
// strictly: a row can only be VALIDATED if all four documented criteria are
// satisfied, and setEntry() downgrades anything that cannot show its work.
//
//   node scripts/07-registry.mjs --chain base --ranking data/ranking-base.json \
//     --validation data/validation-base-*.json --funding data/funding-base.json

import { readFileSync, existsSync } from 'node:fs';
import { loadChain } from '../lib/rpc.mjs';
import { load, save, setEntry, STATUS, VALIDATION_CRITERIA } from '../lib/registry.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const cfg = loadChain(args.chain ?? 'base');
const reg = load();
const jread = (p) => (p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

const ranking = jread(args.ranking);
const validation = jread(args.validation);
const funding = jread(args.funding);
const chainProfileBase = jread('data/chain-profile-base.json');
const chainProfileEth = jread('data/chain-profile-ethereum.json');

reg.validationCriteria = VALIDATION_CRITERIA;

// ---- chains -------------------------------------------------------------
if (chainProfileBase) {
  setEntry(reg, 'chains', 'base', {
    status: STATUS.PROMISING,
    rationale: 'Dense DEX activity, very low execution cost and live zero-fee flash-loan capacity. Promising as a venue to keep investigating; this is not a statement that we can earn money here.',
    evidence: [
      `${chainProfileBase.dexActivity?.totalEstSwapsPerDay?.toLocaleString()} swaps/day estimated across ${Object.keys(chainProfileBase.dexActivity?.byFamily ?? {}).length} venue families`,
      `median total transaction fee ${chainProfileBase.txCost?.medianTotalFeeEth} ETH (L2 gas + L1 data fee)`,
      `measured block time ${chainProfileBase.cadence?.measuredMeanBlockTimeSec}s`,
      `all ${Object.keys(chainProfileBase.contractChecks?.dexes ?? {}).length} configured DEX contracts and ${Object.values(chainProfileBase.contractChecks?.flashLoanProviders ?? {}).filter((p) => p.exists).length} flash-loan providers verified present on-chain`,
    ],
    dataFiles: ['data/chain-profile-base.json'],
  });
}
if (chainProfileEth) {
  setEntry(reg, 'chains', 'ethereum', {
    status: STATUS.VALIDATION_REQUIRED,
    rationale: 'Stage 1 observed one 24-hour window and found the pairs tested too competitive after builder payments. That is a negative result for those pairs in that window, not a finding that Ethereum arbitrage is unprofitable. Re-measuring with the Base toolchain would settle it.',
    evidence: [
      `median total transaction fee ${chainProfileEth.txCost?.medianTotalFeeEth} ETH, about ${chainProfileBase?.txCost?.medianTotalFeeEth ? Math.round(chainProfileEth.txCost.medianTotalFeeEth / chainProfileBase.txCost.medianTotalFeeEth) : '?'}x Base`,
      `base fee p50 ${chainProfileEth.fees?.baseFeeGwei?.p50} gwei vs p95 ${chainProfileEth.fees?.baseFeeGwei?.p95} gwei in the same sample - two orders of magnitude apart`,
      'free endpoints refused unfiltered eth_getLogs, so swap activity by venue was not measured for Ethereum',
    ],
    dataFiles: ['data/chain-profile-ethereum.json'],
  });
}

// ---- DEX combinations (Step 2) ------------------------------------------
for (const c of ranking?.step2_dexCombinations ?? []) {
  const key = `base:${c.combo}`;
  // Observing other operators arbitraging a combination tells us the
  // combination is live. It says nothing about whether we could win it.
  const status = c.arbTxCount >= 20 ? STATUS.INVESTIGATING : STATUS.NOT_TESTED;
  setEntry(reg, 'dexCombos', key, {
    status,
    chain: 'base',
    observedArbTxs: c.arbTxCount,
    sharePctOfObservedArb: c.sharePct,
    netUsdPerArb: c.netUsd,
    distinctOperatorContracts: c.distinctOperatorContracts,
    rationale: status === STATUS.INVESTIGATING
      ? 'Other operators arbitrage this combination often enough to be worth studying. Not evidence that we could capture it.'
      : 'Too few observations in the sampled windows to say anything.',
    dataFiles: ['data/ranking-base.json'],
  });
}

// ---- cycles / pairs (Step 3) --------------------------------------------
for (const c of ranking?.step3_tokenCycles ?? []) {
  setEntry(reg, 'pairs', `base:${c.cycle}`, {
    status: c.arbTxCount >= 10 ? STATUS.INVESTIGATING : STATUS.NOT_TESTED,
    chain: 'base',
    observedArbTxs: c.arbTxCount,
    netUsd: c.netUsd,
    distinctOperators: c.distinctOperators,
    venueCombos: c.venueCombos,
    rationale: 'Frequency of other operators\' arbitrage on this cycle. Revalidation against exact historical state is what decides whether it is ours to take.',
    dataFiles: ['data/ranking-base.json'],
  });
}

// ---- the opportunities that went through the full gate ------------------
let validatedCount = 0;
for (const r of validation?.results ?? []) {
  if (r.skipped) continue;
  const rev = r.revalidatedAtPrevBlock;
  const criteriaMet = {
    exactQuote: Boolean(rev?.quoteBasis?.length),
    netPositive: rev?.netProfitUsd != null && rev.netProfitUsd > 0,
    sizeRealistic: rev?.optimalSizeX != null && rev.optimalSizeX > 0,
    captureShown: r.captureTest?.profitableAtPreviousBlock === true
      && r.captureTest?.earlierSameBlockSwapsOnThesePools === 0,
  };
  const allMet = Object.values(criteriaMet).every(Boolean);
  if (allMet) validatedCount++;
  const entry = setEntry(reg, 'opportunities', r.hash, {
    status: allMet ? STATUS.VALIDATED : (criteriaMet.netPositive ? STATUS.PROMISING : STATUS.FAILED),
    chain: 'base',
    block: r.block,
    cycle: r.cycle,
    venueCombo: r.venueCombo,
    criteriaMet,
    observedNetUsdForTheOperatorWhoTookIt: r.observedNetUsd,
    revalidatedNetUsdForUs: rev?.netProfitUsd ?? null,
    optimalSize: rev?.optimalSizeX ?? null,
    captureVerdict: r.captureTest?.verdict,
    quoteBasis: rev?.quoteBasis ?? null,
    dataFiles: [validation.source, args.validation],
  });
  if (entry.downgradedBecause) entry.note = 'Could not satisfy the VALIDATED criteria; see downgradedBecause.';
}

// ---- funding (Step 4) ---------------------------------------------------
for (const [key, p] of Object.entries(funding?.providers ?? {})) {
  const cap = p.capacity?.WETH?.human ?? null;
  setEntry(reg, 'funding', `base:${key}`, {
    status: STATUS.INVESTIGATING,
    chain: 'base',
    feeBps: p.feeBps,
    feeSource: p.feeSource ?? p.note ?? null,
    capacityWeth: cap,
    capacityUsdc: p.capacity?.USDC?.human ?? null,
    rationale: 'Fee and capacity read from chain state. Selecting a provider is gated on an opportunity existing that needs borrowed capital at all.',
    dataFiles: ['data/funding-base.json'],
  });
}

// ---- other arbitrage models kept on the roadmap (Part 5) ---------------
const models = {
  'two-pool-same-pair': 'The instructor\'s model and our current focus. Measured directly in the forensics windows.',
  'triangular': 'Three pools, three tokens. Observed in the data as 3-swap cycles but not separately validated.',
  'multi-hop-3plus': 'Observed: a share of detected arbitrage uses 3 or more swaps.',
  'cross-quote': 'Same asset pair quoted in different quote currencies. Not tested.',
  'cex-dex': 'Needs off-chain venue access and inventory on both sides; outside the on-chain-only toolchain here.',
  'same-block-backrun': 'Directly relevant: the capture test shows much observed Base arbitrage is same-block reaction to a specific trade.',
  'pool-native-credit': 'Borrow inside the swap callback instead of a separate flash loan. Cheapest in gas where it applies.',
};
for (const [k, v] of Object.entries(models)) {
  setEntry(reg, 'models', k, {
    status: k === 'two-pool-same-pair' ? STATUS.INVESTIGATING : STATUS.NOT_TESTED,
    rationale: v,
  });
}

save(reg);
const tally = {};
for (const section of ['chains', 'dexCombos', 'pairs', 'opportunities', 'funding', 'models']) {
  for (const row of Object.values(reg[section] ?? {})) {
    tally[`${section}:${row.status}`] = (tally[`${section}:${row.status}`] ?? 0) + 1;
  }
}
console.log(JSON.stringify(tally, null, 2));
console.log(`\nopportunities meeting all four VALIDATED criteria: ${validatedCount}`);
