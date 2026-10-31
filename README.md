# DEX arbitrage research

A research framework that asks two separate questions about on-chain arbitrage
and never lets one answer stand in for the other:

1. **Where do profitable opportunities exist**, whether or not anyone has
   traded them?
2. **Who captured opportunities, how, and what did they keep?**

Ethereum mainnet and Base run the same analytical process through per-chain
configuration rather than duplicated code.

**This repository does not trade.** It holds no private keys, signs nothing,
and sends no transactions. Every script is read-only: `eth_call`,
`eth_getLogs`, `eth_getBlockReceipts`, `eth_getBlockByNumber`.

---

## Where this stands

Stage 3 is complete on both chains. The independent discovery engine works and
its coverage is measured rather than assumed.

| | Base | Ethereum mainnet |
|---|---|---|
| Registry status | `PROMISING` | `VALIDATION REQUIRED` |
| Pools discovered | 67,599 | 19,413 |
| Eligible pools | 3,668 | 2,441 |
| Routes generated | 2,820 | 1,562 |
| Routes exactly quoted | 2,741 (97.20%) | 1,494 (95.65%) |
| Net positive at median gas | 3 | 5 |
| Still net positive across 2+ block boundaries | 3 | 3 |
| Best net profit, median gas | **$0.3131** | **$1.2194** |
| Best net profit, contested gas | **−$2.79** | **−$2.17** |
| Reached `SIMULATION VALIDATED` | **0** | **0** |

### The honest reading

**No route on either chain is a trading signal, and none has been
fork-simulated.** Every candidate is net positive only under a median-gas
assumption and goes negative the moment gas is contested. On Ethereum the
block-builder payment that actually decides inclusion is not modelled
anywhere, so every Ethereum net figure is an upper bound.

For scale, Stage 2 measured the *entire* Base chain's arbitrage take at
roughly **$40,456/day split across 131 operator contracts**, with a median
individual arbitrage netting **$0.0172**. The operator that sent the most
transactions (174 of them) netted **$1.10** in total. That is the pool being
competed for.

So the engine is sound and the measurements are reproducible. What is not
established is that any of it survives contact with execution.

---

## Next step — Stage 4

Stage 4 is validation-first, then expansion. The reasoning: the decisive
unknown is not "are there more routes" but **the size of the gap between a
quoted profit and a realised one**. Measuring that first turns it into a
filter applied to everything the expansion phase finds.

| Phase | Work | Answers |
|---|---|---|
| 0 | Install Foundry; `ArbExecutor.sol` deployed to a **local anvil fork only** | toolchain |
| 1 | **Realizable USD pricing** — value a token profit by an exact quote of selling *that exact amount* into the deepest reserve-verified anchor pool, not by a spot reserve ratio | the 77 routes with real token-denominated spreads but no USD basis |
| 2 | **Fork validation** at the scanned block: real transfer behaviour, real gas, real reverts, self-funded and flash-loaned variants, plus a negative control on a `NO SPREAD` route | whether a quoted $0.31 survives execution |
| 3 | **Honest economics** — measured effective-gas-price distribution from the 1,222 real winning arbitrages; a receipts-based probe of Ethereum builder payments as a share of gross | retained profit vs theoretical spread |
| 4 | **Factory triage** of the 138 Base and 89 Ethereum unconfigured factories, four-way: include / no-depth / unquotable / spoofed | coverage gap 1 |
| 5 | **Uniswap V4 + Balancer V2** exact quotes via the deployed `V4Quoter` and `Vault.queryBatchSwap` | the venue combination that carried 31.6% of observed Base arbitrage |
| 6 | **Incremental V2 enumeration**, watermarked three-pass: addresses → cheap depth gate → identity for survivors only | 3,073,680 deferred Base pairs without scanning spam |
| 7 | **Multiple observation windows** — 5 per chain, 4 spaced ~24h apart plus 1 chosen for peak volatility | frequency, persistence, recurrence |
| 8 | **Coverage ledger** reporting discovered / eligible / generated / quoted / unsupported / excluded each against a named denominator | never equating 100% of routes with 100% of the chain |

A confirmed prerequisite for Phase 5: the V4 PoolManager, V4 Quoter and
Balancer Vault all have code at Base block 53,266,711 and the Vault answers an
`eth_call` at that block — so exact quoting is reachable through deployed
contracts at historical state, with no singleton math to reimplement.

**Scope is unchanged: research and simulation only.** No funded trading, no
contract deployment to any live chain, no transactions.

---

## Findings overview by stage

Each stage is listed with what it found *and* what it established about the
method, because several stages mattered mainly by invalidating the previous
stage's assumption.

### Stage 0 — methodology audit

34 course videos read in full and scored; 179 files across `pack/`,
`transcripts/` and `raw/` counted and checksummed; contradictions and gaps
catalogued.

**Validated:** that the method under test was written down precisely enough to
be falsifiable before any chain was touched — two exchanges with the same swap
interface, Balancer flash loans first with DODO as fallback, an off-chain
Node.js bot on `contract.on("Swap")`, min-out left at zero.

### Stage 1 — Ethereum long tail · `reported, not reproducible`

Concluded that the Ethereum pairs tested were too competitive after builder
payments, over one 24-hour window on a handful of manually chosen pairs. Its
scripts and datasets were never persisted, and a thorough search of the
machine confirmed no file anywhere contains Ethereum's Uniswap V3 factory
address.

**Validated:** the discipline itself. This finding is carried forward as
*reported, not reproducible*, and Ethereum is therefore marked
`VALIDATION REQUIRED` rather than `FAILED`. A conclusion whose evidence no
longer exists is not evidence.

### Stage 2 — Base forensics · gate did not pass

Base is a far better *place* to look: **1,381× cheaper** per transaction
(median 1.25×10⁻⁶ vs 1.73×10⁻³ ETH), 2.0s blocks, ~10.2M transactions and
~2.6M swaps per day across six venue families, zero-fee Balancer flash loans
live and deep. Real arbitrage is constant — **1,662 self-funded atomic
arbitrages in 33.3 minutes** of chain time, run by **131 distinct operator
contracts**, drawn from 9,284 multi-swap transactions.

Then the gate: 68 of those real arbitrages were re-priced against exact pool
state at the **end of the previous block** — the information a bot that reacts
to `Swap` events would actually have.

- **0 of 68 were profitable at that moment.**
- **65 of 68** were created by an earlier transaction *inside the same block*.
- A 20-candidate **random** sample gave 20 of 20 same-block and 20 of 20
  unprofitable, so the result is not an artefact of looking only at large
  trades.

**Validated:** that exact historical re-pricing is the right instrument, and
that the course's architecture targets something which on Base does not exist
long enough to be found that way. Supporting control: local V3 tick maths
checked wei-for-wei against the deployed Uniswap QuoterV2 — **32/32 exact**,
including a 410-tick trade. Honestly bounded: 20.3% of multi-swap transactions
(1,880) could not be fully attributed and were excluded from every profit
figure rather than estimated.

### Stage 3a — same-block feasibility · detection reachable, capture untested

- **The infrastructure objection does not hold.** Base's Flashblocks stream is
  publicly reachable from an ordinary workstation: 645 sub-blocks across 61
  blocks in 120s, arrival interval p50 **169ms**, median 11 per block. Round
  trip 43ms, warm decision 55ms, end-to-end budget **246ms against a measured
  median 800ms of remaining block** — roughly 3× margin, with no co-located
  server and no paid feed.
- **But the feed carries no receipts and no logs.** To know a pending
  transaction moves a pool you must decode its raw calldata and simulate the
  swap against your own pool state. `contract.on("Swap")` cannot work
  pre-confirmation, because logs exist only once the block is sealed — which is
  exactly too late.
- **Cold state blows the budget**: 717–935ms versus 246ms warm, which forces
  narrow specialisation. That is precisely what the most profitable operator
  observed actually does.
- **The economics argue against proceeding more strongly than the latency
  does** — see the chain-wide $40,456/day figure above.

**Validated:** that "detect" and "capture" are separable, and that the
untested link is capture. No transaction was ever built, signed or sent, so
nothing here claims the sequencer would place ours in the same block, or that
it would win against 131 competitors.

### Stage 3b — independent discovery · the shape of the project changed

Phase A audited what the forensics pipeline had actually scanned, against a
measured denominator. The finding was structural:

| | Base |
|---|---|
| Pools any script had ever resolved | 1,804 |
| Pools on factories exposing an on-chain array | 3,129,641 |
| Coverage of that floor | **0.0576%** |
| Two-pool routes ever evaluated | **0** |

Independent-discovery coverage was not low, it was **zero** — the old pipeline
only re-priced transactions that already existed. Stage 3b replaced that with
mechanical discovery: enumerate the market, generate every eligible route,
quote each exactly with leg two priced on the actual output of leg one, and
keep a ledger in which a route not reached is recorded as not reached.

| | Base | Ethereum |
|---|---|---|
| Tokens discovered | 49,956 | 14,064 |
| Pools discovered | 67,599 | 19,413 |
| Exchanges configured / exact-quotable | 16 / 14 | 10 / 9 |
| Distinct token pairs | 56,441 | 15,478 |
| Eligible pools | 3,668 | 2,441 |
| Route-bearing pairs | 261 | 275 |
| Routes generated → evaluated | 2,820 → 2,741 | 1,562 → 1,494 |
| `NO SPREAD` | 2,645 | 1,316 |
| `NEGATIVE NET` | 93 | 173 |
| `UNSUPPORTED` | 79 | 68 |
| `PROFITABLE / TIMING UNKNOWN` | 3 | 5 |
| Scanned at block | 53,266,711 | 26,302,653 |

**Validated:** that mechanical discovery finds a *different category* of
opportunity than forensics could. Stage 2 found that 65 of 68 arbitrages taken
by others existed only inside a block. The routes found here sat at completed
block boundaries for 30s (Base) and 84–180s (Ethereum) with no observed
competing arbitrage on either pool. Forensics on other operators'
transactions could not have revealed them.

**Still unresolved and deliberately not counted:** 77 routes (9 Base, 68
Ethereum) returned a genuine positive round trip *in token terms* — the exact
quote paid back more of the input token than it consumed — but the input
token's only USD rate was a weak multi-hop screening price. They are recorded
`UNSUPPORTED` with the token-denominated spread preserved: neither profitable
nor unprofitable. This is the single largest unquantified result in the run
and it is Phase 1 of Stage 4.

---

## What the correctness controls caught

This is the strongest evidence that the approach validates itself. Each
control below exists because an earlier run of the scanner produced a
confident, **wrong** answer without it.

| Control | What went wrong without it |
|---|---|
| **Per-chain gas calibration** | The cost model defaulted to Base's measured gas price (0.0229 gwei) on every chain. Applied to Ethereum at a 1.98 gwei base fee it understated execution cost by ~2 orders of magnitude and turned **136 routes into false positives**. Gas *used* transfers between EVM chains; gas *price* must be read from the chain. |
| **Address-only price anchors** | Anchors matched on `symbol()`, so a counterfeit token calling itself "USDT" was valued at $1.00. Sitting in a pool against real WETH it propagated a WETH price of **$1.2×10²¹**. Base alone holds **144 tokens with stablecoin-looking symbols**. A token's identity is its address; `symbol()` is attacker-controlled text. |
| **Reserve verification against balances** | Any contract can answer `getReserves()` with any number, and a depth-ranked queue puts spoofed pools first. They produced persistent "capture candidates" worth **$1.7×10²¹**. 533 Base and 28 Ethereum pools are excluded as spoofed. |
| **Ratio and depth read separately** | Clamping reserves to real token balances is right for depth but distorts the price *ratio*. Clamping both priced Base WETH at **$522 instead of ~$2,215**. |
| **Family from `stable()`, not the event signature** | Solidly pools emit the same `Swap` signature as Uniswap V2 but use the x³y+y³x invariant. Quoting one with constant-product maths made a USDC/USDT pool appear to yield **$20 on a $201 round trip**. |
| **Unidentified implementations excluded** | A pool that does not report a factory cannot be tied to a known implementation, so its maths *and* its fee are assumptions. Two such pools drove **five of eleven** "profitable" Ethereum candidates. |

The common thread: **every one of these failures produced a large apparent
profit rather than a small one**, because the scanner ranks by depth and
optimises size. A discovery engine without these guards does not fail quietly
— it fails loudly, in the direction of false optimism.

---

## Two systems, kept separate

**System A — independent opportunity discovery** (`scripts/20`–`27`)
enumerates the market, generates every eligible route mechanically, quotes
each one exactly, and records what it did not reach. **It reads no historical
arbitrage transaction at any point.**

**System B — historical arbitrage forensics** (`scripts/00`–`10`)
reconstructs real transactions from block receipts.

System B *informs* System A — it calibrates the cost model and supplies the
competition signal attached to every candidate — but it is never the source of
candidates. A pool nobody has ever arbitraged is examined on exactly the same
terms as a contested one.

---

## Layout

```
chains/<id>.json     chain config: RPC endpoints and measured capabilities, DEX
                     factories with the on-chain evidence that identifies them,
                     tokens, flash-loan providers
lib/rpc.mjs          JSON-RPC with provider failover, concurrency cap, batching
lib/multicall.mjs    Multicall3 aggregate3 batching (~4,800 reads/s measured)
lib/events.mjs       swap / transfer / funding / liquidity event decoders
lib/pools.mjs        pool + token metadata with a retrying on-disk cache
lib/v3math.mjs       exact Uniswap V3 swap simulation against historical state
lib/quote.mjs        one exact-quote interface across pool families
lib/price.mjs        USD pricing from on-chain state at a given block
lib/costs.mjs        execution cost model, calibrated against measured receipts
lib/arbdetect.mjs    balance-sheet construction and arbitrage classification
lib/discovery.mjs    factory enumeration, swap sweep, cross-venue completion
lib/poolregistry.mjs the indexed token + pool inventory, incremental
lib/marketstate.mjs  state snapshot, screening prices, the eligibility gate
lib/routes.mjs       route generation and the coverage ledger
lib/registry.mjs     the investigation ledger and the VALIDATED gate
scripts/             the numbered pipeline (below)
data/                measured output, committed as evidence
data/market/         the pool and token registry (Git LFS)
reports/             the plain-English reports
```

## Pipeline

### System B — historical forensics

| Script | Step | What it does |
|---|---|---|
| `00-v4-registry.mjs` | setup | Builds poolId → currencies for Uniswap V4, which uses one singleton so a Swap log carries no pool address |
| `01-chain-profile.mjs` | 1 | Measures block cadence, throughput, fee components, swap activity by venue family, contract existence, live flash-loan fees |
| `02-forensics.mjs` | 4 | Detects self-funded atomic arbitrage from block receipts; records venues, tokens, funding, gross profit, real cost, net |
| `03-validate-quotemath.mjs` | gate | Correctness check: local V3 maths vs the deployed Uniswap QuoterV2 |
| `04-validate-opportunity.mjs` | 3 | Re-prices observed opportunities against exact historical state and runs the capture test |
| `05-rank.mjs` | 2,3,4 | Ranks DEX combinations, token cycles, funding methods, operator concentration |
| `06-funding.mjs` | 4 | Reads each provider's live fee and lendable capacity |
| `07-registry.mjs` | 3 | Writes the status ledger, enforcing the VALIDATED criteria |
| `08-latency-probe.mjs` | same-block | RTT per endpoint, whether `pending` serves sub-block state, Flashblocks reachability, headroom arithmetic |
| `09-flashblock-observer.mjs` | same-block | Streams Base Flashblocks (brotli JSON), measures arrival intervals and reaction room |
| `10-decision-latency.mjs` | same-block | Cold / warm / optimal-search benchmarks on real cycles |
| `inspect-tx.mjs` | audit | Full decoded ledger for one transaction, for checking the detector by hand |

### System A — independent discovery

| Script | Phase | What it does |
|---|---|---|
| `20-enumeration-probe.mjs` | B prep | Measures how each factory can be enumerated and the real `eth_getLogs` range cap per provider |
| `21-coverage-audit.mjs` | A | What the forensics pipeline actually scanned, against a measured denominator |
| `22-discover-pools.mjs` | B | Builds the pool + token registry: enumeration, swap-log sweep, identity reads, state snapshot, eligibility, cross-venue completion |
| `23-identify-factories.mjs` | B | Ranks factories seen trading that are not configured, and fingerprints each on-chain |
| `24-scan-routes.mjs` | C | Generates every eligible two-pool route and quotes it exactly — leg two on the actual output of leg one — with size optimisation and the cost model |
| `25-persistence.mjs` | D | Re-quotes each profitable route at consecutive block boundaries to measure duration |
| `26-coverage-report.mjs` | report | Assembles the coverage and discovery dashboard and the report |
| `27-verify-reserves.mjs` | gate | Cross-checks every pool's reported reserves against the ERC-20 balances it holds |

**`scripts/27-verify-reserves.mjs` must run before any scan is trusted.**

---

## How the detector decides what is arbitrage

For each successful transaction with two or more AMM swaps:

1. Build the operator entity's complete balance sheet — ERC-20 transfers, plus
   the native-ETH legs transfers cannot show (WETH wrap/unwrap, Uniswap V4
   native-currency pools).
2. Value every leg in USD **at that block**: stablecoins at $1.00, WETH/ETH
   from the Uniswap V3 WETH/USDC pool's own `slot0`, everything else from the
   exchange rates executed inside that same transaction.
3. Reject it unless the balance sheet closes as a self-funded cycle:

| Verdict | Meaning |
|---|---|
| `self-funded-arb` | Ends ahead in exactly one token, no material loss anywhere, nobody else paid |
| `not-profitable` | Does not end materially positive — most multi-swap traffic |
| `third-party-funded` | A non-pool address funded it: a user swap, an aggregator route, a router fee |
| `liquidity-event` | Contains Mint/Burn/Collect/ModifyLiquidity, so the change is the operator's own capital |
| `multi-token-gain` | Ends ahead in two or more tokens at once, which a closed cycle cannot do |
| `unverified` | A leg could not be resolved or priced from on-chain state. **Never counted as profit** |

Working in USD rather than raw token units is load-bearing: raw integers are
not comparable across tokens with different decimals, and comparing them
directly makes a 1,500 USDC outflow (1.5e9 raw) look negligible beside a
0.66 WETH inflow (6.6e17 raw).

## The VALIDATED gate

`VALIDATED` in `registry.json` requires all four, and `setEntry()` downgrades
any row that cannot show them:

1. **exactQuote** — both legs priced by exact on-chain state at a named block.
2. **netPositive** — net profit above zero after swap fees, funding fee, L2
   execution gas and L1 data fee, at an executable size.
3. **sizeRealistic** — the profitable size is reachable and within measured
   pool depth.
4. **captureShown** — the opportunity was already profitable at the previous
   block boundary **and** no earlier transaction in the same block swapped on
   either pool.

Criterion 4 is the one that matters. Another operator's profitable transaction
is not evidence that we could have earned it.

Status vocabulary: `NOT TESTED` · `INVESTIGATING` · `VALIDATION REQUIRED` ·
`FAILED` · `PROMISING` · `VALIDATED`

---

## Adding a chain

Write `chains/<id>.json`. Nothing in `lib/` or `scripts/` is chain-specific.

- `rpc`: public endpoints, tried in order with failover.
- `rpcCapabilities`: what the free endpoints actually permit, **measured
  rather than assumed** — log range caps differ per provider and silently
  truncate.
- `kind`: `op-stack-l2` makes the pipeline account for the L1 data fee from
  each receipt's `l1Fee`; `l1` omits it.
- `dexes`: each entry needs `family` (`uniswap-v3`, `uniswap-v2`,
  `solidly-v2`, `pancake-v3`, `uniswap-v4`, `balancer-v2`) and a factory. The
  `evidence` field records how the brand was established, because several Base
  factories are only distinguishable by on-chain fingerprint.

---

## Known limits

- Price anchors are matched by **contract address from the chain config only**.
- Uniswap V4 and Balancer V2 are enumerated and recorded but classified
  `UNSUPPORTED`: no exact-quote implementation for a singleton-pool design
  exists here yet. On Base that excludes the venue combination that carried
  **31.6%** of observed arbitrage. (Stage 4 Phase 5.)
- 3,073,680 Base and 526,497 Ethereum Uniswap V2 pairs were not enumerated;
  they are reached only via `getPair()` when a pair already has an eligible
  pool elsewhere. (Stage 4 Phase 6.)
- 138 Base and 89 Ethereum factories were seen trading but are not configured.
  Their pools are recorded and excluded as `factory-not-configured`.
  (Stage 4 Phase 4.)
- 49 of 200 Base swap-sweep windows failed on the public endpoints even after
  retry, so activity figures are incomplete by that fraction.
- Gas *used* is calibrated from Base receipts; on Ethereum it is borrowed and
  unconfirmed. On an L1 the **block-builder payment is not modelled**, so net
  profit there is an upper bound. (Stage 4 Phase 3.)
- Transfer taxes, rebasing and other non-standard token behaviour are not
  detected. A fee-on-transfer token would quote as profitable and fail in
  execution. (Stage 4 Phase 2.)
- Screening prices are spot reserve ratios, used only to rank and to size.
  Every candidate row records which price basis applied.
- Public endpoints cap `eth_getLogs` — measured caps are in each chain config.
  Unfiltered queries are refused outright on the free Ethereum endpoints.
- No trace API and no state overrides on public endpoints, so native-ETH
  movements that are neither a transfer nor a WETH wrap are invisible; those
  transactions are marked `unverified`.
- Base's archive depth on public endpoints is about 50,000 blocks (~27 hours).
- Aerodrome Slipstream charges a dynamic fee through a swap-fee module; quotes
  use the pool's `fee()` at that block.
- Stablecoins are assumed to be worth exactly $1.00.
- Capture feasibility is tested only at completed-block boundaries under the
  stated latency model. It is **not** a claim that we would win a race.

---

## Cloning

Large artefacts are in Git LFS. Without it you get pointer files:

```bash
brew install git-lfs && git lfs install
git clone git@github.com:9Mirrors-Lab/dex-arbitrage-research.git
cd dex-arbitrage-research && git lfs pull && npm install
```

## Reproducing a chain run

```bash
node scripts/00-v4-registry.mjs       --chain <id>
node scripts/01-chain-profile.mjs     --chain <id>
node scripts/03-validate-quotemath.mjs --chain <id>   # must pass first
node scripts/20-enumeration-probe.mjs --chain <id>
node scripts/21-coverage-audit.mjs    --chain <id>
node scripts/22-discover-pools.mjs    --chain <id> --sweep-blocks 20000
node scripts/27-verify-reserves.mjs   --chain <id>    # must pass first
node scripts/23-identify-factories.mjs --chain <id>
node scripts/24-scan-routes.mjs       --chain <id> --block <n> --top 2000
node scripts/25-persistence.mjs       --chain <id> --blocks 12
node scripts/26-coverage-report.mjs   --chain <id>
```

Read-only throughout. No keys, no signing, no transactions.

## Reports

- [`reports/stage2-base-investigation.md`](reports/stage2-base-investigation.md) — Base forensics and the capture gate
- [`reports/stage3-sameblock-feasibility.md`](reports/stage3-sameblock-feasibility.md) — Flashblocks, latency, and the economics argument
- [`reports/stage3-discovery-base.md`](reports/stage3-discovery-base.md) — Base coverage and opportunity
- [`reports/stage3-discovery-ethereum.md`](reports/stage3-discovery-ethereum.md) — Ethereum coverage and opportunity
- [`FRAMEWORK.md`](FRAMEWORK.md) — five-step status across chains, and what prior research exists
