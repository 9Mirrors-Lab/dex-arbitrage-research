# Stage 3 — Can we capture same-block arbitrage on Base?

**Date:** 2026-10-29 · **Chain:** Base (8453)
**Scope:** research only. No contract was written or deployed, no transaction was built, signed or sent, no funds moved. Every measurement here is read-only.

---

## The question

Stage 2 established that Base arbitrage is created and consumed inside a single 2-second block: of 68 real arbitrages re-priced against exact state at the previous block boundary, **zero** were profitable at that moment and **65** were created by an earlier transaction in the same block.

So: **can we realistically build a system that detects and captures those opportunities, or does it require infrastructure that makes the strategy impractical?**

## The answer

**Detection is reachable. Capture is unproven, and the economics are the real obstacle — not the infrastructure.**

Three findings, in order of how much they matter:

1. **The infrastructure objection does not hold.** Pre-confirmation data is free and fast enough. Base's Flashblocks stream is publicly reachable from an ordinary workstation, delivering sub-blocks every ~169ms (measured p50). Round-trip latency to Base from this machine is **43ms**. The deciding computation takes **55ms** with pool state in memory. The end-to-end budget comes to **246ms against a measured median of 800ms of remaining block** — roughly 3× margin. Nothing here needs a co-located server or a paid feed.

2. **But "detect" is not "capture", and capture is the part we have not tested at all.** Everything above is arithmetic from measured components. We never built, signed or sent a transaction, so we have demonstrated nothing about whether the sequencer would place our transaction in a later Flashblock of the same block, or whether we would win that slot against 131 competing operators. That single link is untested, and it is the whole question.

3. **The economics are a stronger argument against proceeding than the latency is.** The median arbitrage nets **$0.0172**. Extrapolated over 24 hours, the *entire* chain's arbitrage pays about **$40,456 across all 131 operators**. The best single operator we observed would make about **$2,935/day**; most make tens of dollars; the operator with the *most* transactions (174) netted **$1.10**. A new entrant would be competing for a share of that.

A fourth point shapes any design: the 246ms budget only holds for pools whose tick state we already hold in memory. Cold, the same computation takes **717–935ms** and blows the budget. That forces narrow specialisation — which is exactly what the most profitable operator we found actually does.

---

## What is technically possible — measured, not assumed

### Data access

| Question | Measured answer |
|---|---|
| Is pre-confirmation state reachable without a paid provider? | **Yes.** All three public Base endpoints serve the `pending` tag, one block ahead of `latest`, with partial transaction counts (54 / 137 / 95 at the moment of probing) |
| Does `pending` advance within a block, or only per block? | **Within.** 27 distinct pending states across 29 polls over 6 seconds spanning 4 blocks — roughly 7 observable states per block, consistent with 200ms sub-blocks |
| Is the raw Flashblocks stream reachable? | **Yes.** `wss://mainnet.flashblocks.base.org/ws` connects from this workstation and streams brotli-compressed JSON — one 14,693-byte frame decoded to 178,003 bytes of block diff |
| What does the stream contain? | `payload_id`, `index` (sub-block number), `metadata.block_number`, and `diff.transactions` as **raw signed transaction hex** |
| What does it *not* contain? | **No receipts and no logs** |

That last row is the most consequential technical finding, and it is worth being explicit about.

The course's design is `contract.on("Swap")` — react to a log. **The pre-confirmation feed carries no logs.** To know that a pending transaction moves a pool, and by how much, you must decode its raw calldata, resolve the route, and simulate the swap yourself against your own copy of pool state. That is strictly more engineering than the course describes, and it is not optional: logs only exist once the block is sealed, which is exactly too late.

Base's documentation describes this websocket as a node-infrastructure endpoint rather than an application API. It is reachable and parseable today; that is an observation, not a guarantee, and a production design should not assume it stays open or unmetered.

### Timing

Measured over 120 seconds: 645 Flashblocks across 61 blocks, 59 of them complete (seen from index 0).

| Measurement | Value |
|---|---|
| Flashblock arrival interval (as received) | p10 **97ms** · p50 **169ms** · p90 **351ms** · max **789ms** |
| Flashblocks per block | min 8 · median **11** · max 11 |
| Transactions per Flashblock | p50 21 · p90 52 · max 158 |
| Round-trip latency, best endpoint (`base.drpc.org`) | min 38.8ms · **p50 43.3ms** · p90 47.9ms |
| Round-trip latency, `mainnet.base.org` | p50 53.3ms |

Transaction volume is front-loaded: Flashblock index 1 carries a median of 58 transactions, while indices 2–10 carry 20–23 each.

### Reaction room

For each Flashblock carrying a transaction addressed directly to a known DEX contract, how much of that block remained afterwards:

| | Remaining Flashblocks | Remaining time |
|---|---|---|
| p10 | **0** | **0ms** |
| p50 | 4 | **800ms** |
| p90 | 9 | 1,800ms |

Half the time there is 800ms of block left after a DEX trade appears. **But a tenth of the time there is none at all** — the trade lands in the final sub-block and no reaction is possible regardless of speed.

This is a floor, from 28 observations: it counts only transactions sent directly to a configured factory, router or singleton, and most real swaps route through aggregators we did not enumerate.

### Decision latency

Benchmarked on real two-pool V3 cycles taken from the Stage 2 forensics data, using the same quote engine the Stage 2 gate used:

| Regime | Time per cycle | Network reads | What it represents |
|---|---|---|---|
| **Cold** | **717–935ms** | 14–16 round trips | No cached state. This is what the Stage 2 validator did per candidate |
| **Warm** | **0.04–0.12ms** | 0 | Tick maps in memory; a single re-quote at a new size. Pure arithmetic |
| **Full optimal-size search** | **55ms** | 0–15 | 42 probes, both legs each, state in memory |

The spread between cold and warm is four orders of magnitude, and it is the whole engineering problem. A bot that queries pool state on demand cannot react inside a block. A bot holding warm tick maps decides in 55ms.

### The end-to-end budget

| Step | Measured | Source |
|---|---|---|
| Trigger appears in a Flashblock and reaches us | 169ms | feed arrival interval p50 |
| Decide: optimal-size search, state in memory | 55ms | benchmarked above |
| Sign and submit (one network leg) | 22ms | half of measured p50 RTT |
| **Total** | **246ms** | |
| **Measured median reaction room** | **800ms** | Flashblock observation |

It fits, with about 3× margin, on the median case.

---

## What we have actually demonstrated, and what we have not

The distinction the question asks for, drawn strictly.

### Demonstrated by measurement

- Pre-confirmation data is accessible from an ordinary machine, free, at ~169ms granularity.
- The Flashblocks feed carries raw transactions and no logs.
- Round-trip latency to Base is 43ms from here.
- An optimal-size search over a two-pool cycle takes 55ms with warm state, and 717–935ms cold.
- Median 800ms of block remains after a DEX-addressed transaction appears; 10% of the time, none does.
- The arithmetic of those measured components sums to 246ms.
- The economics of the existing operator population (below).

### Not demonstrated — and material

| Gap | Why it matters |
|---|---|
| **No transaction was ever sent** | The entire capture half is untested. Whether the sequencer places our transaction in a later Flashblock of the *same* block is the decisive unknown, and it cannot be answered without sending transactions |
| **No competition test** | 131 operators are already doing this. The 246ms budget is a solo time trial; the real event is a race, and we have measured nobody's reaction time but our own |
| **Warm state was assumed, not built** | The 55ms figure applies only to pools already in memory. Maintaining warm tick maps across 377 actively-traded V3 pools and 36,403 V4 pools is an unsolved bandwidth and memory problem here |
| **Raw-calldata simulation was not built** | We decoded transaction *destinations* from the feed, not routes or amounts. Turning raw calldata into "this pool moved by X" is real work we have not done |
| **Reaction room rests on 28 observations** | Direct-to-factory transactions only; a floor, not a distribution |
| **Flashblock boundaries of the Stage 2 backruns were not recovered** | We know 65 of 68 arbitrages followed a same-block trigger, but not whether trigger and arbitrage sat in the same Flashblock. If they did, no observer could have reacted — it would imply a bundle or private orderflow, not speed. Sealed blocks do not retain sub-block boundaries, so this needs forward recording |
| **120 seconds of Flashblock observation** | One short window, one time of day |

That sixth row is the sharpest open question. The whole feasibility case assumes the arbitrageurs we observed were *reacting* to a trigger they saw. If instead they submitted trigger and arbitrage together, or received the trigger privately, then the 800ms of "reaction room" is room nobody is actually using to react, and our 246ms budget is solving the wrong problem. Answering it requires recording Flashblock membership live and matching it against arbitrages as they happen — which this framework can now do, but has not yet done.

---

## Is it worth it even if it works?

Extrapolated from 33.2 minutes of measured chain time (a scaling of 43×, and an extrapolation rather than a measurement):

| | Value |
|---|---|
| Chain-wide arbitrage net, all 131 operators | **~$40,456/day** |
| Best single operator observed | **~$2,935/day** |
| Mean per operator | ~$309/day |
| Operator with the most transactions (174) | **$1.10** over 33 minutes |

The best operator's pattern is instructive: `0x7f0d70ac…49da` ran **164 arbitrages on exactly one cycle** (USDC/AXIS) through exactly one venue combination (Uniswap V3 + V4), median net $0.49. The busiest operator by count ran 174 arbitrages across 63 cycles and 50 venue combinations for **$1.10 total** — near-perfect break-even.

Read together with the cold-versus-warm measurement, those two rows say the same thing: **breadth loses, narrowness wins.** You cannot hold warm state for the whole chain, and the operator who tried to cover everything earned nothing. The viable shape is one or two cycles, pre-warmed, run relentlessly.

That is a real business, and it is also a roughly $1,800–2,900/day ceiling for the best operator currently doing it — before infrastructure, development and the cost of losing races.

---

## So: practical or impractical?

**Not impractical for infrastructure reasons.** We looked for the wall and did not find it: the data is free, the latency is ample, the computation is 55ms. The course's specific architecture (react to a `Swap` log after the block seals) is dead on Base, but a pre-confirmation architecture is within reach of ordinary hardware.

**Impractical to commit to on current evidence**, for three reasons that are about evidence rather than engineering:

1. The capture half is entirely untested, and testing it means sending transactions.
2. We may be solving the wrong problem — if the observed arbitrageurs were not reacting to a public trigger, speed is not the binding constraint, and we have not yet checked.
3. The reward for winning is thin and already contested by 131 operators, with the best of them at ~$2,900/day.

---

## Recommended next step

**One cheap experiment, before any Solidity: record Flashblock membership live and check whether the arbitrages are reactions at all.**

Run the Flashblock observer continuously, store which sub-block every transaction arrived in, and run the Stage 2 detector over the same blocks as they seal. Then for every detected arbitrage, answer: did its trigger arrive in an *earlier* Flashblock than the arbitrage itself?

- **If yes, often** — the opportunities are genuinely reactable, our 246ms budget is the right target, and the next step is a latency prototype that detects and *simulates* submissions without sending them.
- **If no** — trigger and arbitrage share a Flashblock, meaning they are bundled or privately routed. Speed is then not the constraint, public pre-confirmation data cannot help, and this strategy family should be set aside on Base.

This uses only code that now exists, needs no funds, no contract and no transactions, and it decides the question that everything else depends on. It is the highest-value thing we can do next, and it costs a long observation run.

Two cheaper things worth doing alongside it:

- **Re-run Ethereum through this toolchain.** Stage 1's negative result came from one window with weaker methods. Ethereum's 12-second blocks give 6× the reaction room, and the same-block constraint may simply not bind there. Cost: a config and a run.
- **Widen the Base observation window.** 33 minutes of forensics and 120 seconds of Flashblock data are both thin. The tooling runs unattended.

---

## Evidence

| File | Contents |
|---|---|
| `../data/latency-base.json` | RTT per endpoint, `pending`-tag behaviour, sub-block advance probe, Flashblocks reachability |
| `../data/flashblocks-base.json` | 645 Flashblocks over 59 complete blocks: arrival intervals, per-index transaction volume, reaction room |
| `../data/decision-latency-base.json` | Cold / warm / search benchmarks per real cycle, and the end-to-end budget |
| `../data/ranking-base.json` | Operator economics and concentration |
| `../data/validation-base-*.json` | The Stage 2 capture gate this report follows from |
| `scripts/08-latency-probe.mjs`, `09-flashblock-observer.mjs`, `10-decision-latency.mjs` | The measurements above, re-runnable |

A note on the toolchain: a fork-compatibility bug was found and fixed while benchmarking — `ticks()` returns a different tuple on some V3 forks, which previously threw and surfaced as an unpriceable candidate in Stage 2. It now decodes only `liquidityNet` from the raw word, as `slot0` already did. The quoter cross-check was re-run after the fix: **32 of 32 exact**.
