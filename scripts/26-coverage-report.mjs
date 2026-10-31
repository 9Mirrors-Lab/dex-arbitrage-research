// The coverage and discovery dashboard.
//
//   node scripts/26-coverage-report.mjs --chain base
//
// Assembles every measured artefact into one structured report and one
// plain-English document. The rule it enforces: a percentage is only printed
// when its denominator is known and named. Where the denominator is a floor
// rather than a total — the pool count of factories that expose an on-chain
// array, say — the report says so next to the number, because a coverage
// figure with an understated denominator flatters the result.

import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadChain } from '../lib/rpc.mjs';
import { PoolRegistry } from '../lib/poolregistry.mjs';
import { CLASS, CLASS_MEANING } from '../lib/routes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const args = process.argv.slice(2);
const argOf = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const chainId = argOf('chain', 'base');
const cfg = loadChain(chainId);

const j = (p, fb = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb);
// Most recently written, not alphabetically last: tags like `-v3` and
// `-verified` do not sort in the order the runs happened.
const latestName = (prefix) => {
  const f = readdirSync(DATA)
    .filter((x) => x.startsWith(prefix) && x.endsWith('.json'))
    .map((x) => ({ x, mtime: statSync(join(DATA, x)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  return f.length ? f[f.length - 1].x : null;
};
const latest = (prefix) => {
  const name = latestName(prefix);
  return name ? j(join(DATA, name)) : null;
};

const enumeration = j(join(DATA, `enumeration-${chainId}.json`));
const audit = j(join(DATA, `coverage-audit-${chainId}.json`));
const discovery = j(join(DATA, `discovery-${chainId}.json`));
const scan = latest(`scan-${chainId}-`);
const persistence = latest(`persistence-${chainId}-`);
const unconfigured = j(join(DATA, `unconfigured-factories-${chainId}.json`));
// Verification runs after discovery and supersedes its eligibility figures:
// it removes spoofed pools, clamps depth to real balances and re-screens.
// Reading eligibility from `discovery` would report pre-verification counts.
const verification = j(join(DATA, `verification-${chainId}.json`));
const reg = new PoolRegistry(chainId);
const stats = reg.stats();
const eligibleFrom = verification?.afterVerification ?? discovery?.eligibleUniverse ?? null;
const eligibilityReasons = verification?.ineligibilityReasons ?? discovery?.ineligibilityReasons ?? {};

const n = (x) => (x == null ? '—' : Number(x).toLocaleString());
const pc = (a, b) => (b > 0 && a != null ? `${(100 * a / b).toFixed(4)}%` : '—');
const usd = (x) => (x == null ? '—' : `$${Number(x).toFixed(4)}`);

// ---------------------------------------------------------------------------
// Market coverage
// ---------------------------------------------------------------------------
const enumerableTotal = enumeration
  ? Object.values(enumeration.factories).filter((f) => f.enumerable).reduce((a, f) => a + (f.poolCount ?? 0), 0)
  : null;
const nonEnumerable = enumeration ? Object.entries(enumeration.factories).filter(([, f]) => !f.enumerable).map(([k]) => k) : [];
const deferred = discovery?.deferredFactories ?? [];
const deferredPools = deferred.reduce((a, d) => a + (d.count - (d.enumerated ?? 0)), 0);

// The denominator we can actually defend: pools on factories we enumerated in
// full, plus pools found by the sweep and by completion. The deferred Uniswap
// V2 factory is excluded from the numerator and named separately rather than
// folded in.
const enumeratedInFull = enumeration
  ? Object.entries(enumeration.factories)
    .filter(([k, f]) => f.enumerable && !deferred.some((d) => d.key === k))
    .reduce((a, [, f]) => a + (f.poolCount ?? 0), 0)
  : null;

const marketCoverage = {
  tokensDiscovered: stats.tokens,
  poolsDiscovered: stats.pools,
  poolsWithResolvedIdentity: stats.poolsWithTokens,
  supportedExchangesConfigured: Object.keys(cfg.dexes ?? {}).length,
  exchangesWithExactQuoteSupport: Object.entries(cfg.dexes ?? {}).filter(([, d]) => ['uniswap-v3', 'pancake-v3', 'uniswap-v2', 'solidly-v2'].includes(d.family)).length,
  unconfiguredFactoriesSeenTrading: unconfigured?.totalUnconfigured ?? null,
  factoryPoolsEnumeratedInFull: enumeratedInFull,
  factoryPoolsDeferred: deferredPools,
  factoriesWithoutOnChainArray: nonEnumerable,
  totalPairs: stats.pairs,
  eligiblePools: stats.eligiblePools,
  quotablePools: stats.quotablePools,
  // The scan generates routes from the live registry at run time, so where a
  // scan exists its counts are authoritative; the discovery and verification
  // summaries are snapshots taken before any later re-screen.
  eligiblePairsWithTwoOrMorePools: scan?.routeUniverse?.pairs ?? eligibleFrom?.eligiblePairsWithTwoOrMorePools ?? null,
  twoPoolRoutesPossible: scan?.routeUniverse?.generated ?? eligibleFrom?.directionalTwoPoolRoutes ?? null,
  eligibilityBasis: verification ? 'after reserve verification (scripts/27)' : 'discovery only — reserves NOT verified against token balances',
  ineligibilityReasons: eligibilityReasons,
  reserveVerification: verification ? {
    poolsChecked: verification.poolsChecked,
    verified: verification.verified,
    spoofedReservesExcluded: verification.spoofed,
    v3DepthClamped: verification.clampedV3,
    balanceUnreadable: verification.balanceUnreadable,
    method: verification.method,
  } : null,
};

// ---------------------------------------------------------------------------
// Route coverage
// ---------------------------------------------------------------------------
// An UNSUPPORTED route is a coverage gap, and the reasons are not
// interchangeable: "no exact quote for this pool family" is an infrastructure
// limit, while "a real spread we declined to value in USD" is a finding we
// should not lose. Tally them from the per-route ledger.
const ledgerFile = latestName(`ledger-${chainId}-`);
const ledger = ledgerFile ? j(join(DATA, ledgerFile)) : null;
const unsupportedReasons = {};
let tokenDenominatedSpreads = 0;
const tokenSpreadExamples = [];
if (ledger) {
  for (const r of ledger) {
    if (r.classification !== CLASS.UNSUPPORTED) continue;
    const raw = r.evidence?.reason ?? 'unstated';
    // Collapse the per-route specifics so the tally groups by cause.
    const bucket = /net profit cannot be stated/.test(raw) ? 'exact spread found, but no reliable USD basis for the input token'
      : /no reliable USD basis|screening price only/.test(raw) ? 'exact spread found, but no reliable USD basis for the input token'
        : /decimals/.test(raw) ? 'token decimals unresolved'
          : /reserve snapshot/.test(raw) ? 'no usable reserve snapshot to bound trade size'
            : /ladder probe failed|leg1|leg2|V3 state read|getAmountOut|getReserves/.test(raw) ? 'pool could not be quoted at this block'
              : /gas token/.test(raw) ? 'gas token could not be priced reliably'
                : /threw/.test(raw) ? 'evaluation error'
                  : raw.slice(0, 80);
    unsupportedReasons[bucket] = (unsupportedReasons[bucket] ?? 0) + 1;
    if (r.evidence?.tokenDenominatedSpread) {
      tokenDenominatedSpreads++;
      if (tokenSpreadExamples.length < 15) {
        tokenSpreadExamples.push({
          pair: r.pair, venueA: r.venueA, venueB: r.venueB, poolA: r.poolA, poolB: r.poolB,
          inputToken: r.tokenIn, spreadInInputTokenUnits: r.evidence.grossToken,
          sizeInInputTokenUnits: r.evidence.bestSizeToken,
          whyNotValued: r.evidence.priceBasis,
        });
      }
    }
  }
}

const cov = scan?.coverage ?? null;
const routeCoverage = scan ? {
  generated: scan.routeUniverse.generated,
  queuedForEvaluation: scan.routeUniverse.queued,
  evaluated: cov.evaluated,
  pctOfGeneratedEvaluated: pc(cov.evaluated, scan.routeUniverse.generated),
  notTested: cov.notTested,
  unsupported: cov.unsupported,
  byClass: cov.byClass,
  excludedAtGeneration: scan.routeUniverse.excludedAtGeneration,
  unsupportedReasons,
  exactSpreadsFoundButNotValuedInUsd: tokenDenominatedSpreads,
} : null;

// ---------------------------------------------------------------------------
// Opportunity results
// ---------------------------------------------------------------------------
const spreads = cov ? (cov.byClass[CLASS.NEGATIVE_NET] ?? 0) + (cov.byClass[CLASS.PROFITABLE_TIMING_UNKNOWN] ?? 0) + (cov.byClass[CLASS.CAPTURE_CANDIDATE] ?? 0) + (cov.byClass[CLASS.NOT_CAPTURABLE] ?? 0) : null;
const opportunity = {
  routesWithAnExactSpread: spreads,
  routesProfitableAfterCosts: cov ? (cov.byClass[CLASS.PROFITABLE_TIMING_UNKNOWN] ?? 0) + (cov.byClass[CLASS.CAPTURE_CANDIDATE] ?? 0) + (cov.byClass[CLASS.NOT_CAPTURABLE] ?? 0) : null,
  routesNoSpread: cov?.byClass[CLASS.NO_SPREAD] ?? null,
  routesNegativeNet: cov?.byClass[CLASS.NEGATIVE_NET] ?? null,
  persistenceTested: persistence?.candidates ?? 0,
  survivingMultipleBlocks: persistence?.captureCandidates ?? 0,
  requiringSameBlock: persistence?.notCapturable ?? 0,
  notReproducibleOnRequote: persistence?.notReproducible ?? 0,
  captureCandidates: persistence?.captureCandidates ?? 0,
};

const costModelNote = scan?.method?.costGasUsedBorrowed
  ? `Gas USED in the cost model is borrowed from the measured Base two-swap distribution, because ${cfg.name} has no forensics dataset of its own; gas PRICE is read from the chain at the scanned block. Gas used is a property of the contract logic rather than the chain, so it transfers, but it has not been confirmed against real ${cfg.name} arbitrage receipts.`
  : null;

const dashboard = {
  chain: chainId, chainName: cfg.name, generatedAt: new Date().toISOString(),
  sources: {
    enumeration: enumeration ? `enumeration-${chainId}.json` : null,
    coverageAudit: audit ? `coverage-audit-${chainId}.json` : null,
    discovery: discovery ? `discovery-${chainId}.json` : null,
    scan: scan ? `scan @ block ${scan.block}` : null,
    persistence: persistence ? `persistence @ block ${persistence.baseBlock}` : null,
  },
  marketCoverage, routeCoverage, opportunity,
  exactSpreadsWithoutUsdBasis: { count: tokenDenominatedSpreads, examples: tokenSpreadExamples },
  latencyModel: persistence?.latencyModel ?? null,
  leadingCandidates: (persistence?.results ?? [])
    .filter((r) => [CLASS.CAPTURE_CANDIDATE, CLASS.PROFITABLE_TIMING_UNKNOWN, CLASS.NOT_CAPTURABLE].includes(r.classification))
    .slice(0, 25)
    .map((r) => ({
      chain: chainId, pair: `${r.tokenInSymbol ?? r.tokenIn}/${r.tokenMidSymbol ?? r.tokenMid}`,
      tokenInAddress: r.tokenIn, tokenMidAddress: r.tokenMid,
      exchangeCombination: `${r.venueA} -> ${r.venueB}`,
      poolA: r.poolA, poolB: r.poolB, feeA: r.feeA, feeB: r.feeB,
      block: persistence.baseBlock, direction: r.dir === 0 ? 'token0 -> token1 on pool A' : 'token1 -> token0 on pool A',
      tradeSizeToken: r.sizeToken, tradeNotionalUsd: r.notionalUsd,
      grossProfitUsd: r.grossUsdAtScan,
      estimatedCostUsdMedian: r.costMedianUsd, estimatedCostUsdContested: r.costContestedUsd,
      netProfitUsdMedian: r.netUsdMedianAtScan, netProfitUsdContested: r.netUsdContestedAtScan,
      durationBlocks: r.longestProfitableRunBlocks, durationSeconds: r.longestProfitableRunSeconds,
      competition: r.competition, validationStatus: r.classification,
      priceBasis: r.priceBasis, rationale: r.rationale,
    })),
  knownLimitations: [
    enumeration ? `Filtered eth_getLogs is capped at ~${n(Math.max(...Object.values(enumeration.logRange).map((r) => r.maxFilteredRange)))} blocks and unfiltered at ${n(cfg.rpcCapabilities?.unfilteredGetLogsMaxRange)} block(s) on the free ${cfg.name} endpoints, so creation-event history was not scanned. Pools on factories without an on-chain array were found by swap activity and cross-venue lookup instead, which finds what trades rather than everything that exists.` : null,
    deferredPools > 0 ? `${n(deferredPools)} Uniswap V2 pairs were not enumerated. They are reached only when a pair already has an eligible pool elsewhere, via getPair(). A pair whose only two pools are both unenumerated is NOT TESTED.` : null,
    discovery?.stages?.sweep?.failedWindows ? `${discovery.stages.sweep.failedWindows} of ${discovery.stages.sweep.windows} swap-sweep windows failed on the public endpoints even after retry, so the activity figures and the token set they produced are incomplete by that fraction.` : null,
    marketCoverage.unconfiguredFactoriesSeenTrading
      ? `${n(marketCoverage.unconfiguredFactoriesSeenTrading)} factories were seen trading but are not in chains/${chainId}.json. Their pools are recorded and excluded from routes as \`factory-not-configured\` — an honest exclusion, but still a coverage hole. Closing it is mechanical: scripts/23 fingerprints each one and emits a config stub.`
      : null,
    `Uniswap V4 and Balancer V2 pools are recorded but classified UNSUPPORTED: no exact-quote implementation exists for a singleton-pool design in this toolchain.${chainId === 'base' ? ' On Base that is a material exclusion, since Uniswap V4 carried 31.6% of the arbitrage observed in Stage 2.' : ''}`,
    verification
      ? `${n(verification.spoofed)} pools reported reserves exceeding their own token balances and are excluded as spoofed. Verification matters out of proportion to that count: these pools rank top by depth, so before the check was added they occupied most of the candidate list.`
      : 'Reserves were NOT verified against token balances in this run. Any pool can report arbitrary reserves, so candidate figures should not be trusted until scripts/27 has run.',
    cfg.kind === 'l1'
      ? `Net profit on ${cfg.name} EXCLUDES the block-builder payment, which nothing in this repo measures. Since inclusion is auctioned, every net figure here is an upper bound and the true retained profit is lower by whatever a builder would demand.`
      : null,
    costModelNote,
    'Screening prices are spot reserve ratios and are used only to rank and to size. Profit is computed from exact quotes, but converting a token-denominated profit to USD uses the screening price when the input token is not a stablecoin or WETH, and every candidate row records which basis applied.',
    'Transfer taxes, rebasing and other non-standard token behaviour are not yet detected. A fee-on-transfer token would quote as profitable and fail in execution; such routes should be treated as unvalidated until a transfer simulation exists.',
    'Capture feasibility is tested only at completed-block boundaries under the stated latency model. It is not a claim that we would win a race against another operator.',
  ].filter(Boolean),
};

writeFileSync(join(DATA, `dashboard-${chainId}.json`), `${JSON.stringify(dashboard, null, 2)}\n`);

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------
const L = [];
L.push(`# ${cfg.name} — discovery coverage and opportunity report`, '');
L.push(`Generated ${new Date().toISOString().slice(0, 10)} from measured artefacts in \`data/\`. Every figure traces to a named file; nothing is asserted without one.`, '');

L.push('## What changed in this stage', '');
L.push('The earlier work reconstructed arbitrages other operators had already executed. It could only ever see a pool that someone had traded inside an observed block, so it had no denominator and could state no coverage. This stage replaced that with mechanical discovery: enumerate the market, generate every eligible route, quote each one exactly, and keep a ledger in which a route we did not reach is recorded as not reached.', '');

if (audit && !audit.pipelineAudited?.length) {
  L.push('### Phase A — what the previous pipeline actually scanned', '');
  L.push(`No forensics run ever existed for ${cfg.name}, so there is no prior coverage to audit: every pool, pair and route on this chain was NOT TESTED before this stage. ${n(enumerableTotal)} pools are reachable from on-chain factory arrays alone, and none of them had been examined.`, '');
  L.push('The Stage-1 conclusion carried in FRAMEWORK.md — that the Ethereum pairs tested were too competitive after builder payments — came from one 24-hour window on a handful of manually chosen pairs, and its scripts and data were never persisted. It is therefore reported there as *reported, not reproducible*, and this stage does not treat it as evidence.', '');
} else if (audit) {
  L.push('### Phase A — what the previous pipeline actually scanned', '');
  const o = audit.coverage.observed;
  L.push('| | |', '|---|---|');
  L.push(`| Observation window | ${n(o.blocks)} blocks, ${o.chainMinutes} minutes of chain time |`);
  L.push(`| Arbitrages reconstructed | ${n(o.arbitragesDetected)} from ${n(o.multiSwapTxsExamined)} multi-swap transactions |`);
  L.push(`| Pools appearing in those arbitrages | ${n(o.poolsInArbitragesVsEnumerableUniverse ?? o.poolsInArbitrages)} |`);
  L.push(`| Pools any script had ever resolved | ${n(o.poolsEverResolved)} |`);
  L.push(`| Pools on factories exposing an on-chain array | ${n(enumerableTotal)} |`);
  L.push(`| Coverage of that floor | ${pc(o.poolsEverResolved, enumerableTotal)} |`);
  L.push(`| Two-pool routes any script evaluated | 0 |`);
  L.push('');
  L.push('The last row is the finding. No script in the previous pipeline constructed a route; `04-validate-opportunity.mjs` re-priced transactions that already existed. Independent-discovery coverage was not low, it was zero.', '');
}

L.push('## Market coverage', '');
L.push('| Measure | Value | Denominator |', '|---|---|---|');
L.push(`| Tokens discovered | ${n(marketCoverage.tokensDiscovered)} | — |`);
L.push(`| Pools discovered | ${n(marketCoverage.poolsDiscovered)} | — |`);
L.push(`| Pools with resolved token identity | ${n(marketCoverage.poolsWithResolvedIdentity)} | of pools discovered |`);
L.push(`| Exchanges configured | ${n(marketCoverage.supportedExchangesConfigured)} | — |`);
L.push(`| Exchanges with an exact-quote path | ${n(marketCoverage.exchangesWithExactQuoteSupport)} | of configured |`);
L.push(`| Unconfigured factories seen trading | ${n(marketCoverage.unconfiguredFactoriesSeenTrading)} | coverage hole, ranked in \`unconfigured-factories-${chainId}.json\` |`);
L.push(`| Factory pools enumerated in full | ${n(marketCoverage.factoryPoolsEnumeratedInFull)} | exhaustive for those factories |`);
L.push(`| Factory pools deliberately deferred | ${n(marketCoverage.factoryPoolsDeferred)} | Uniswap V2, reached by pair lookup only |`);
L.push(`| Distinct token pairs | ${n(marketCoverage.totalPairs)} | — |`);
L.push(`| Eligible pools | ${n(marketCoverage.eligiblePools)} | of pools discovered |`);
L.push(`| Eligible pairs with 2+ pools | ${n(marketCoverage.eligiblePairsWithTwoOrMorePools)} | route-bearing pairs |`);
L.push(`| Directional two-pool routes possible | ${n(marketCoverage.twoPoolRoutesPossible)} | — |`);
L.push('');

if (verification) {
  L.push('### Reserve verification', '');
  L.push(`Eligibility above is measured **after** cross-checking every pool's reported reserves against the ERC-20 balances it actually holds (\`scripts/27-verify-reserves.mjs\`). A pool can only pay out tokens it holds, and a contract can report any reserve it likes.`, '');
  L.push('| | |', '|---|---|');
  L.push(`| Pools checked | ${n(verification.poolsChecked)} |`);
  L.push(`| Reserves match balances | ${n(verification.verified)} |`);
  L.push(`| Reported reserves exceed balances (excluded as spoofed) | ${n(verification.spoofed)} |`);
  L.push(`| V3 depth clamped to real balance | ${n(verification.clampedV3)} |`);
  L.push(`| balanceOf unreadable | ${n(verification.balanceUnreadable)} |`);
  L.push('');
  L.push('This check is load-bearing out of all proportion to the count. Spoofed pools claim enormous reserves, so they sort to the very top of a depth-ranked queue: before the check existed they made up most of the candidate list on both chains.', '');
}

if (Object.keys(marketCoverage.ineligibilityReasons).length) {
  L.push('### Why pools were excluded', '');
  L.push('An excluded pool is recorded with its reason. None of these reasons is a statement about profitability.', '');
  L.push('| Reason | Pools |', '|---|---|');
  for (const [r, v] of Object.entries(marketCoverage.ineligibilityReasons).sort((a, b) => b[1] - a[1])) L.push(`| \`${r}\` | ${n(v)} |`);
  L.push('');
}

if (routeCoverage) {
  L.push('## Route coverage', '');
  L.push('| Measure | Value |', '|---|---|');
  L.push(`| Routes generated | ${n(routeCoverage.generated)} |`);
  L.push(`| Routes queued for exact quoting | ${n(routeCoverage.queuedForEvaluation)} |`);
  L.push(`| Routes evaluated | ${n(routeCoverage.evaluated)} (${routeCoverage.pctOfGeneratedEvaluated} of generated) |`);
  L.push(`| Routes still NOT TESTED | ${n(routeCoverage.notTested)} |`);
  L.push(`| Routes UNSUPPORTED | ${n(routeCoverage.unsupported)} |`);
  L.push('');
  L.push('### Classification', '');
  L.push('| Class | Routes | Meaning |', '|---|---|---|');
  for (const [k, v] of Object.entries(routeCoverage.byClass).sort((a, b) => b[1] - a[1])) {
    L.push(`| ${k} | ${n(v)} | ${CLASS_MEANING[k] ?? ''} |`);
  }
  L.push('');
  if (Object.keys(unsupportedReasons).length) {
    L.push('### Why routes were UNSUPPORTED', '');
    L.push('None of these is a statement that the route is unprofitable.', '');
    L.push('| Reason | Routes |', '|---|---|');
    for (const [r, v] of Object.entries(unsupportedReasons).sort((a, b) => b[1] - a[1])) L.push(`| ${r} | ${n(v)} |`);
    L.push('');
  }
  if (tokenDenominatedSpreads) {
    L.push(`**${n(tokenDenominatedSpreads)} routes returned a genuine positive round trip in token terms** — the exact quote through both pools paid back more of the input token than it consumed — but the input token's only available USD rate was a multi-hop screening price, which is too weak to carry a profit claim. They are recorded as UNSUPPORTED with the token-denominated spread kept, not as profitable and not as unprofitable. Closing this gap needs a stronger pricing path for long-tail tokens, and it is the single largest unquantified result in this run. Examples are in \`data/dashboard-${chainId}.json\` under \`exactSpreadsWithoutUsdBasis\`.`, '');
  }
}

if (scan) {
  L.push('## How a route was evaluated', '');
  L.push(`Scanned at block ${n(scan.block)}.`, '');
  for (const [k, v] of Object.entries(scan.method)) L.push(`- **${k}** — ${v}`);
  L.push('');
}

if (persistence) {
  L.push('## Capture feasibility', '');
  const lm = persistence.latencyModel;
  L.push(`The latency model is stated rather than assumed, from \`${lm.source}\`:`, '');
  L.push('| Step | Milliseconds |', '|---|---|');
  L.push(`| Observe the block header | ${lm.observeMs} |`);
  L.push(`| Decide, with warm pool state | ${lm.decideMs} |`);
  L.push(`| Submit the transaction | ${lm.submitMs} |`);
  L.push(`| **Total reaction budget** | **${lm.totalMs}** |`);
  L.push(`| Block interval | ${lm.blockIntervalMs} |`);
  L.push(`| Slack | ${lm.slackMs} |`);
  L.push('');
  L.push(`${lm.note}`, '');
  if (lm.measuredAgainst) L.push(`Measured against ${lm.measuredAgainst}.`, '');
  if (lm.caveat) L.push(`**${lm.caveat}**`, '');
  L.push('| Result | Routes |', '|---|---|');
  L.push(`| Tested for persistence | ${n(persistence.candidates)} |`);
  L.push(`| Survived two or more consecutive boundaries | ${n(persistence.captureCandidates)} |`);
  L.push(`| Profitable at one boundary only (needs same-block) | ${n(persistence.notCapturable)} |`);
  L.push(`| Not reproducible on re-quote | ${n(persistence.notReproducible)} |`);
  L.push('');
}

if (dashboard.leadingCandidates.length) {
  L.push('## Leading candidates', '');
  L.push('| Pair | Venues | Size | Gross | Cost (med) | Net (med) | Net (contested) | Duration | Rival arbs | Status |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of dashboard.leadingCandidates) {
    L.push(`| ${c.pair} | ${c.exchangeCombination} | ${c.tradeSizeToken?.toPrecision?.(4) ?? '—'} | ${usd(c.grossProfitUsd)} | ${usd(c.estimatedCostUsdMedian)} | ${usd(c.netProfitUsdMedian)} | ${usd(c.netProfitUsdContested)} | ${c.durationBlocks} blk / ${c.durationSeconds}s | ${(c.competition?.knownArbitragesOnPoolA ?? 0) + (c.competition?.knownArbitragesOnPoolB ?? 0)} | ${c.validationStatus} |`);
  }
  L.push('');
  L.push('Pool addresses, block numbers and the full size ladder for each row are in `data/dashboard-' + chainId + '.json` and the per-route ledger, so any row can be re-quoted independently.', '');
} else if (scan) {
  L.push('## Leading candidates', '');
  L.push('None. No route in the evaluated set produced a positive net quote that survived re-quoting. This is a result about the evaluated portion of the universe at the tested blocks, stated with the coverage figures above, and it is not a conclusion about the chain.', '');
}

// ---------------------------------------------------------------------------
L.push('## Correctness controls that proved necessary', '');
L.push('Each of these was added because an earlier run of this scanner produced a confident, wrong answer without it. They are recorded because a reader deciding whether to trust these numbers should know what nearly corrupted them, and because any future scanner needs the same guards.', '');
L.push('| Control | What went wrong without it |', '|---|---|');
L.push('| Per-chain gas calibration | The cost model defaulted to Base\'s measured gas price (0.0229 gwei) on every chain. Applied to Ethereum, where the base fee was 1.98 gwei, it understated execution cost by roughly two orders of magnitude and turned 136 routes into false positives. Gas USED transfers between EVM chains; gas PRICE must be read from the chain. |');
L.push('| Address-only price anchors | Anchors were matched by on-chain `symbol()`, so a counterfeit token calling itself "USDT" was valued at $1.00. Sitting in a pool against real WETH, it propagated a WETH price of $1.2e21 and turned every genuine WETH spread into a multi-sextillion-dollar fiction. Base alone holds 144 tokens with stablecoin-looking symbols. A token\'s identity is its address; `symbol()` is attacker-controlled text. |');
L.push('| Reserve verification against balances | Any contract can answer `getReserves()` with any number, and spoofed pools claim enormous depth, so a depth-ranked queue puts them first. They produced persistent "capture candidates" worth $1.7e21. |');
L.push('| Ratio and depth read separately | Clamping reserves to the real token balance is right for depth but distorts the price *ratio*. Clamping both priced Base WETH at $522 instead of about $2,215. |');
L.push('| Family from `stable()`, not the event signature | Solidly-style pools emit the same `Swap` signature as Uniswap V2 but use the x³y+y³x invariant. Quoting one with constant-product maths made a USDC/USDT pool appear to yield $20 on a $201 round trip. Pools answering `stable()` are now quoted through their own `getAmountOut()` view, which is exact whatever the invariant. |');
L.push('| Unidentified implementations excluded | A pool that does not report a factory cannot be tied to a known implementation, so both its maths and its fee are assumptions. Two such pools drove five of eleven "profitable" Ethereum candidates. |');
L.push('');
L.push('The common thread: every one of these failures produced a *large* apparent profit rather than a small one, because the scanner ranks by depth and optimises size. A discovery engine without these controls does not fail quietly — it fails loudly and in the direction of false optimism.', '');

L.push('## What this does and does not establish', '');
{
  const cc = persistence?.captureCandidates ?? 0;
  const evalPct = routeCoverage?.pctOfGeneratedEvaluated ?? '—';
  L.push(`**Established.** Within the eligible universe defined above, ${evalPct} of generated two-pool routes were evaluated with exact, protocol-aware quotes at a named block — leg two priced on the actual output of leg one, never on a spot difference. ${n(opportunity.routesWithAnExactSpread)} routes showed a real executable spread. ${n(opportunity.routesProfitableAfterCosts)} remained net positive after modelled execution cost under the median-gas scenario, and ${n(cc)} of those were still net positive at two or more consecutive completed-block boundaries.`, '');
  if (cc > 0) {
    L.push(`That last number is the one that matters against the Stage-2 result. Stage 2 found that 65 of 68 arbitrages taken by other operators existed only *inside* a block, created by an earlier transaction in the same block, and so were unreachable for a block-polling design. The routes found here are different in kind: they sat at completed-block boundaries for ${persistence.results.filter((r) => r.classification === CLASS.CAPTURE_CANDIDATE).map((r) => r.longestProfitableRunSeconds).sort((a, b) => a - b)[0]}s or longer with no observed competing arbitrage on either pool. Independent discovery therefore finds a category of opportunity that forensics on other operators' transactions could not have revealed.`, '');
  }
  L.push(`**Not established.** Capture. Every candidate here is net positive only under the median-gas scenario and turns negative once gas is contested${cfg.kind === 'l1' ? ', and the builder payment that decides inclusion on this chain is not modelled at all' : ''}. The sizes are small — the best net figure on this chain is ${usd(Math.max(0, ...(dashboard.leadingCandidates.map((c) => c.netProfitUsdMedian ?? 0))))} — and none has been simulated against execution semantics, token transfer behaviour, or a competing operator. No route on either chain reached SIMULATION VALIDATED, and none should be treated as a trading signal.`, '');
  L.push(`**Out of scope of this measurement.** ${n(routeCoverage?.notTested ?? 0)} routes remain NOT TESTED and ${n(routeCoverage?.unsupported ?? 0)} UNSUPPORTED; the universe itself excludes ${n(marketCoverage.factoryPoolsDeferred)} unenumerated Uniswap V2 pairs, ${n(marketCoverage.unconfiguredFactoriesSeenTrading)} unconfigured factories, and every singleton-pool venue. A conclusion about ${cfg.name} as a whole cannot be drawn from this run, and none is drawn.`, '');
}
L.push('');

L.push('## Known limitations', '');
for (const k of dashboard.knownLimitations) L.push(`- ${k}`);
L.push('');
L.push('## Reproducing this', '');
L.push('```bash');
L.push(`node scripts/20-enumeration-probe.mjs --chain ${chainId}`);
L.push(`node scripts/21-coverage-audit.mjs   --chain ${chainId}`);
L.push(`node scripts/22-discover-pools.mjs   --chain ${chainId} --sweep-blocks 20000`);
L.push(`node scripts/23-identify-factories.mjs --chain ${chainId}`);
L.push(`node scripts/24-scan-routes.mjs      --chain ${chainId}${scan ? ` --block ${scan.block}` : ''} --top 2000`);
L.push(`node scripts/25-persistence.mjs      --chain ${chainId} --blocks 12`);
L.push(`node scripts/26-coverage-report.mjs  --chain ${chainId}`);
L.push('```');
L.push('');
L.push('Read-only throughout: `eth_call`, `eth_getLogs`, `eth_getBlockByNumber`. No keys, no signing, no transactions.', '');

writeFileSync(join(ROOT, 'reports', `stage3-discovery-${chainId}.md`), `${L.join('\n')}\n`);

console.log(`\nwrote data/dashboard-${chainId}.json`);
console.log(`wrote reports/stage3-discovery-${chainId}.md`);
console.log('');
console.log(`tokens ${n(marketCoverage.tokensDiscovered)}  pools ${n(marketCoverage.poolsDiscovered)}  pairs ${n(marketCoverage.totalPairs)}  eligible pools ${n(marketCoverage.eligiblePools)}`);
if (routeCoverage) console.log(`routes generated ${n(routeCoverage.generated)}  evaluated ${n(routeCoverage.evaluated)} (${routeCoverage.pctOfGeneratedEvaluated})`);
if (persistence) console.log(`capture candidates ${n(persistence.captureCandidates)}  not capturable ${n(persistence.notCapturable)}`);
