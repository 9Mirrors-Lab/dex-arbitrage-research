# The unified arbitrage framework

> **Stage 3 changed the shape of this project.** Steps 1–5 below describe the
> original Dapp University method and the forensics work that tested it. That
> work answers *who captured opportunities and how*. It could not answer *where
> opportunities exist*, because it only ever examined pools that someone had
> already traded. Stage 3 added a second, independent system that enumerates
> the market and generates its own candidates. See
> [Stage 3 — independent discovery](#stage-3--independent-discovery) and
> `reports/stage3-discovery-base.md`.



One analytical process, applied per chain through configuration. This file is
the current state of the investigation and the map of what is shared between
chains versus what is chain-specific.

Status vocabulary: `NOT TESTED` · `INVESTIGATING` · `VALIDATION REQUIRED` ·
`FAILED` · `PROMISING` · `VALIDATED`

---

## Provenance: what prior research exists

This matters for reading everything below, so it comes first.

### What was already here, and is preserved untouched

| Asset | What it is | Status |
|---|---|---|
| `../pack/` (`index.md`, `picks.md`, `notes.md`, `gaps.md`, `verify_quotes.py`) | The Dapp University methodology baseline: 34 videos read in full, scored, with contradictions and gaps catalogued | **Preserved, unmodified** — verified by checksum before and after the Base framework was copied in |
| `../transcripts/` (34 files), `../raw/` (135 files) | The source transcripts and raw caption data | **Preserved, unmodified** |
| `../pack.bak-20261026/`, `*.bak-*` files | Prior backups | **Preserved, unmodified** |
| `../audit.csv`, `../manifest.csv`, `../queue*.tsv`, `../pull.log`, `../STATUS.txt` | The transcript-collection pipeline and its records | **Preserved, unmodified** |

That transcript pack **is** the earlier research, and it is the authority for
"what the course teaches" throughout this framework. 179 files across
`pack/`, `transcripts/`, `raw/` and `pack.bak-20261026/` were counted and
checksummed before and after the copy; none changed.

### What does not exist, stated plainly

**There is no prior Ethereum arbitrage implementation, script, or captured
dataset on this machine.** This was searched for thoroughly before anything
was copied:

- the destination directory, file by file;
- Spotlight across `/Volumes/Fulcrum` and `/Users/m4` (index returned nothing for the volume);
- a filesystem sweep for directories named `*stage*`, `*phase*`, `*forensic*`, `*arb*`, `*mev*`;
- a content search for Ethereum's Uniswap V3 factory address `0x1F98431c…` — **no file on the machine contains it**, and no real Ethereum arbitrage analysis could avoid referencing it;
- a content search for `builder payment`, `flashbots`, `searcher`, `coinbase.transfer` — every hit was an unrelated trade book or the skills registry index;
- the Claude session transcripts, including archived ones, and `~/.cursor/plans/`.

What that search did find is that **"Stage 0" in this project was the
transcript audit** — reading all 34 transcripts and verifying the pack — not
on-chain forensics. The Ethereum Stage 1 long-tail analysis exists as
conclusions in earlier conversations; its scripts and datasets were never
persisted.

So nothing could be, or was, overwritten. The practical consequence:

- The Ethereum Stage 1 finding is carried forward as **reported, not
  reproducible**. It is recorded below as such and is not treated as proof.
- There is **no duplicate Ethereum implementation to reconcile against**. The
  reconciliation work is therefore forward-looking: `chains/ethereum.json`
  already exists so the same code can re-measure Ethereum properly, and
  nothing needs to be deleted or merged.

---

## How the two chains stay separate while sharing everything reusable

The separation is by configuration and by artefact naming, not by forked code.
There is exactly one implementation of every analytical step.

```
chains/base.json          chain-specific: endpoints, measured RPC limits, DEX
chains/ethereum.json      factories with on-chain evidence, tokens, funding
                          providers, L1-vs-L2 cost model selector

lib/*.mjs                 SHARED — no chain-specific branches anywhere
scripts/*.mjs             SHARED — every script takes --chain <id>

data/chain-profile-base.json          every artefact carries its chain in the
data/chain-profile-ethereum.json      filename, so no run can silently mix
data/forensics-base-<from>-<to>.json  chains and no file needs moving when a
data/ranking-base.json                second chain is added
data/cache/pools-base.json            caches are keyed by chain id
```

What makes this work rather than leak:

| Concern | How it is handled |
|---|---|
| Base has an L1 data fee, Ethereum does not | `kind: "op-stack-l2"` vs `"l1"`. The cost model reads `l1Fee` from each receipt when present and omits it otherwise — no `if (chain === 'base')` anywhere |
| Different venues per chain | `dexes` in the config, each with a `family` the shared decoders understand (`uniswap-v3`, `uniswap-v2`, `solidly-v2`, `pancake-v3`, `uniswap-v4`, `balancer-v2`) |
| Endpoints differ in what they permit | `rpcCapabilities` records measured limits (log-range caps, archive depth), so a script adapts instead of silently truncating |
| Block cadence differs 6× | `blockTimeSec` drives window sizing and every per-day extrapolation |
| Ethereum pays builders, Base pays the sequencer | Both are measured from receipts as effective gas price; neither is assumed |

**Reuse available to Ethereum right now, with no new code:** the JSON-RPC
layer, event decoders, pool/token metadata cache, the exact V3 tick maths
(validated wei-for-wei against the deployed Uniswap quoter), the quote
dispatcher, USD pricing, the balance-sheet arbitrage detector, the registry
and all nine pipeline scripts. Ethereum needs no implementation work — only a
run, plus an endpoint that permits unfiltered log queries.

---

## Step 1 — Select the blockchain

| Chain | Status | Basis |
|---|---|---|
| **Base** | `PROMISING` | Measured: 2.0s blocks, ~10.2M tx/day, ~2.6M swaps/day across 6 venue families, median tx fee 1.25×10⁻⁶ ETH (**1,381× cheaper than Ethereum**), all 10 configured DEX contracts and 3 flash-loan providers verified present |
| **Ethereum** | `VALIDATION REQUIRED` | Measured: 12.0s blocks, 1.64M tx/day, median tx fee 1.73×10⁻³ ETH, base fee p50 0.137 gwei against p95 49.68 gwei in the same sample. Swap activity by venue **not measured** — free endpoints refuse unfiltered log queries |

**Carried forward, not verified:** Stage 1 reported that the Ethereum pairs
tested were too competitive after builder payments, over one 24-hour window.
That is one window on specific pairs. It is not evidence that Ethereum
arbitrage is unprofitable, and Ethereum is deliberately **not** marked
`FAILED`.

**Next action:** re-run Ethereum through this toolchain. Ethereum's 12-second
blocks are 6× Base's, and the same-block constraint that decided Stage 2 may
bind very differently there.

---

## Step 2 — Select two exchanges

| Chain | Status |
|---|---|
| Base | **Completed** — ranked shortlist with evidence |
| Ethereum | `NOT TESTED` with this framework |

**The finding that changes the method:** the course's "two exchanges with the
same swap interface" describes **less than half** of real Base arbitrage.

| Shape | Share of 1,662 observed arbitrages |
|---|---|
| Different DEX brands (the course's model) | 42.8% |
| Same protocol, different version or factory | **43.3%** |
| A single venue, two pools across fee tiers | **13.8%** |

Top combinations by observed arbitrage: Uniswap V3 + Uniswap V4 (31.6%, but
97.5% of it one token pair), Aero-merged CL + Uniswap V3 (9.2%), Uniswap V3
alone across fee tiers (8.5%), Aero-merged CL + Aerodrome Slipstream #3
(5.3%).

Venue identification required on-chain fingerprinting: six heavily-used
factories matched nothing published. Aerodrome runs **three** Slipstream CL
factories under one `voter()`; a fourth Slipstream-family factory
(`0x9cb22058…`) has a **different** `voter()` and registry, so it is a
separate protocol. Evidence is recorded per-DEX in `chains/base.json`.

**Implication for Step 5:** an implementation hard-wired to two routers is
blind to 57% of the activity.

---

## Step 3 — Select trading pairs

| Chain | Status |
|---|---|
| **Base** | `INVESTIGATING` — see the Stage 3 reconciliation below. The earlier `FAILED` verdict was correct about the transactions it examined and wrong as a statement about the chain |
| Ethereum | `INVESTIGATING` — 1,562 routes scanned independently in Stage 3; no forensics run yet |

> **Stage 3 reconciliation.** This step was previously marked `FAILED` for a
> block-polling architecture. That conclusion rested on 68 arbitrages *other
> operators had already executed*, 65 of which were created by an earlier
> transaction in the same block. It is sound evidence about those transactions
> and about backrunning as a strategy. It is not evidence about the pair
> universe, because the candidate set was entirely inherited from other
> operators' choices — and the Phase A audit measured that selection bias at
> 0.058% of even the enumerable pool floor, with zero routes ever constructed.
>
> Independent scanning found opportunities of a different shape: three on Base
> and three on Ethereum that were net positive at two or more *completed-block
> boundaries*, persisting 30s and 84–180s respectively, with no competing
> arbitrage observed on either pool. Those do not need same-block reaction, so
> the constraint that decided the old verdict does not bind them.
>
> They are also small — best net $0.31 on Base, $1.22 on Ethereum under median
> gas — and all of them turn negative once gas is contested. So the step is
> reopened, not passed.

Observed economics across 1,662 arbitrages (1,000 blocks, 33.2 minutes of
chain time, four windows spread over ~24h):

| | Value |
|---|---|
| Net per arbitrage, median | **$0.0172** |
| Net per arbitrage, p90 / max | $0.4677 / $250.57 |
| Execution cost, median | $0.0159 |
| Netting > $1 / > $5 / > $25 | 54 / 18 / 5 |

**The gate result:** 68 real arbitrages re-priced against exact pool state at
the end of the previous block. **Zero were profitable at that moment.** 65 of
68 were created by an earlier transaction inside the same block. A 20-candidate
random sample behaved identically (20 of 20), so this is not an artefact of
sampling the largest trades.

Long-tail tokens are **not** less contested: AXIS/USDC drew 654 arbitrages
from **49 operators**, with more than one in the same block in 166 of 274
blocks.

**No cycle reached `VALIDATED`.** The registry holds 67 `FAILED` opportunities;
`exactQuote` and `sizeRealistic` were satisfied 64 times each, `netPositive`
and `captureShown` zero times.

---

## Step 4 — Select the funding method

| Chain | Status |
|---|---|
| Base | **Completed, and gated** — recommendation exists but nothing should be selected until Step 3 passes |
| Ethereum | `NOT TESTED` with this framework |

Read live from chain state:

| Provider | Fee | Lendable WETH | Lendable USDC | Used by real operators |
|---|---|---|---|---|
| **Morpho Blue** | **0 bps** | **84,242** | **$196.1M** | 4.3% |
| Aave V3 | 5 bps | 16,174 | $10.1M | 0% |
| Balancer V2 *(the course's pick)* | 0 bps | **22.9** | **$74.6k** | **0%** |
| Uniswap V3 pool flash | = pool fee tier | per-pool | per-pool | — |

**95.7% of real Base arbitrage uses no flash loan at all.** The course treats
borrowed capital as the default; practitioners fund from inventory, because
the borrow/repay callback costs gas and the median profit is $0.017. Aave's
5 bps would consume the entire median profit on a borrow of about **$34**.

If funding is ever needed: **inventory first, Morpho Blue second.** Not
Balancer, which is the weakest option on Base by capacity and was used zero
times.

---

## Step 5 — Create and test the smart contract

| Chain | Status |
|---|---|
| Base | **Blocked, intentionally** |
| Ethereum | `NOT TESTED` |

No contract has been written and none should be yet. The blocker is not the
contract — it is whether a transaction can reach the same block as the trade
that creates the opportunity. See
`reports/stage3-sameblock-feasibility.md` for the measured answer.

Requirements captured so far: four swap interfaces (not two), factory-driven
pool discovery across multiple factories per protocol, native-ETH handling
(29% of V4 pools), optional rather than mandatory funding, an on-chain
profitability guard, real slippage limits, and revert-on-loss. Historical fork
testing is already available — the validated quote engine re-prices any V3-fork
pool at any historical block.

---

## Stage 3 — independent discovery

The question Steps 1–5 could not answer: **where do opportunities exist,
regardless of whether anyone has traded them?** Answering it needs a
denominator, which meant building one.

### The chain of inference

`Blockchain → Exchanges → Pools → Tokens → Routes → Exact quotes → Net profit → Capture feasibility`

Every arrow is a measured step with its own artefact in `data/`, and every
step records what it could not reach.

### Measured result

| | Base | Ethereum |
|---|---|---|
| Tokens discovered | 49,956 | 14,064 |
| Pools discovered | 67,599 | 19,413 |
| Distinct token pairs | 56,441 | 15,478 |
| Exchanges configured / quotable | 16 / 14 | 10 / 9 |
| Unconfigured factories seen trading | 138 | 89 |
| Eligible pools after verification | 3,668 | 2,441 |
| Route-bearing pairs | 261 | 275 |
| Directional two-pool routes | 2,820 | 1,562 |
| Routes reached | **100%** | **100%** |
| Routes evaluated with exact quotes | 97.2% | 95.7% |
| Routes with a real executable spread | 96 | 178 |
| Net positive after modelled cost | 3 | 5 |
| Net positive across 2+ block boundaries | **3** | **3** |
| Best net, median gas | $0.3131 | $1.2194 |
| Best net, contested gas | negative | negative |

Full reports: `reports/stage3-discovery-base.md`,
`reports/stage3-discovery-ethereum.md`. Dashboards:
`data/dashboard-{base,ethereum}.json`.

### Why the universe is smaller than the market

67,599 pools reduce to 2,820 routes, and that reduction is where the honesty
lives. A two-pool arbitrage needs *two* pools on *one* pair, both deep enough
to trade and both quotable exactly. Base's 3.07M Uniswap V2 pairs are
overwhelmingly spam holding dust; 39,286 pools fell below the $500 depth floor
and 18,864 held dust or nothing. Every exclusion is recorded with its reason,
and none of those reasons is "unprofitable".

The deferred Uniswap V2 factory is the one place the method is deliberately
incomplete rather than exhaustive: enumerating 3.07M pairs to resolve their
tokens would cost roughly 12M contract reads for a set that is almost entirely
worthless. Instead, cross-venue completion asks `getPair()` only about pairs
that already have liquidity somewhere else — which found 1,949 real Uniswap V2
pools on Base and 1,068 on Ethereum. The residual gap, stated plainly: a pair
whose only two pools both sit on unenumerated factories and which did not
trade during the sweep window is NOT TESTED.

### What had to be built, and what was reused

Reused unchanged: the JSON-RPC layer, the exact V3 tick maths (still 32/32
against the deployed quoter), the quote dispatcher, the metadata cache, the
chain configs with their on-chain venue evidence, and the latency and
decision-cost measurements that Phase D's capture model rests on.

Built: `lib/multicall.mjs` (the batching that makes enumeration affordable at
~4,800 reads/s), `lib/discovery.mjs`, `lib/poolregistry.mjs`,
`lib/marketstate.mjs`, `lib/routes.mjs`, `lib/costs.mjs`, and
`scripts/20`–`27`.

### Six correctness controls, each added after a wrong answer

Documented in full in the chain reports. In short: per-chain gas calibration;
price anchors matched by address rather than `symbol()`; reserves verified
against token balances; price ratio and tradeable depth read separately;
pool family taken from `stable()` rather than the Swap event signature; and
pools with unidentified implementations excluded.

Every one of those bugs produced a *large* false profit rather than a small
one, because the scanner ranks by depth and optimises trade size. A discovery
engine fails in the direction of false optimism unless each is guarded.

### Nothing was overwritten

The Stage 2 forensics datasets, rankings, validation runs, the 67 `FAILED`
registry rows and both prior reports are untouched. Stage 3 added files
alongside them. System B now feeds System A in two concrete places: the cost
model's gas-used distribution is calibrated from 1,222 observed Base
arbitrages, and every candidate carries a competition signal counting real
arbitrages and distinct operators on its two pools.

## Other models on the roadmap

| Model | Status | Evidence from Base |
|---|---|---|
| Two-pool, same pair | `INVESTIGATING` | 73.5% of arbitrage; $558 of $933 total net |
| Same-block backrunning | `NOT TESTED` | **65 of 68** validated candidates were this — the one model the evidence points toward |
| Triangular / 3-pool | `NOT TESTED` | 22.7% of arbitrage, median net $0.0126 vs $0.0187 for 2-swap — more complexity, less money |
| Multi-hop (4+) | `NOT TESTED` | 3.8%; includes the single largest observed ($250.57) |
| Pool-native credit | `NOT TESTED` | Cheapest funding in gas where it applies |
| Cross-quote | `NOT TESTED` | — |
| CEX–DEX | `NOT TESTED` | Needs off-chain venue access and two-sided inventory; outside this on-chain-only toolchain |

---

## Running the framework

From `arb-research/` at its permanent location:

```bash
npm install
node scripts/03-validate-quotemath.mjs --chain base   # correctness gate: must be 32/32
node scripts/01-chain-profile.mjs --chain <id>
node scripts/00-v4-registry.mjs --chain <id>          # only where Uniswap V4 exists
node scripts/02-forensics.mjs --chain <id> --blocks 250 --from <block>
node scripts/05-rank.mjs --chain <id> --files <comma-separated forensics files>
node scripts/04-validate-opportunity.mjs --chain <id> --file <forensics file> --top 20 [--random 1]
node scripts/06-funding.mjs --chain <id>
node scripts/07-registry.mjs --chain <id> --ranking ... --validation ... --funding ...
node scripts/08-latency-probe.mjs                     # same-block feasibility
node scripts/09-flashblock-observer.mjs --seconds 120
node scripts/10-decision-latency.mjs --pairs 6
```

Run the correctness gate first. If those 32 cases do not match the deployed
Uniswap quoter exactly, nothing downstream should be trusted.

System A — independent discovery, in order:

```bash
node scripts/20-enumeration-probe.mjs   --chain <id>   # how each factory can be enumerated
node scripts/21-coverage-audit.mjs      --chain <id>   # what the forensics pipeline actually scanned
node scripts/22-discover-pools.mjs      --chain <id> --sweep-blocks 20000
node scripts/23-identify-factories.mjs  --chain <id>   # fingerprint venues missing from the config
node scripts/27-verify-reserves.mjs     --chain <id>   # MUST run before any scan is trusted
node scripts/24-scan-routes.mjs         --chain <id> --block <n> --top <n>
node scripts/25-persistence.mjs         --chain <id> --scan data/scan-<id>-<block>-<tag>.json
node scripts/26-coverage-report.mjs     --chain <id>
```

`27-verify-reserves.mjs` is not optional. Without it the scan ranks spoofed
pools first and reports them as the best opportunities on the chain.

Discovery is incremental: cursors in `data/market/meta-<id>.json` mean a
re-run extends the registry and the sweep window instead of rebuilding them.

Everything is read-only. No private keys, no signing, no transactions.
