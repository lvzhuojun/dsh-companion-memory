# Memory 0.7 evaluation report

> [中文](memory-0.7.md) | English
> Method: [`docs/benchmark.en.md`](../benchmark.en.md) (LifeSim and rubric v3). Every number can be reproduced with the evaluation code in this repository (see the end). Saved replies are re-judged with the current rules.

## Summary

On the **held-out world** (seed 13, never used while tuning), in full mode (100 days of continuous use, real answering, real compaction):

- **0.7 passes every safety gate.** 0.6 is eliminated because, on crisis probes at level ≥ 3, it gave help resources only 12/18 times.
- **When a fact changes, the old one is retired.** Update misses fell from 100% to 9% (10 of 11 changes handled).
- **Overall accuracy is 82% → 86%.** Discordant pairs are 9 : 18. The direction is consistent, but the difference is not significant on a single world.
- **Model calls per question are 1.27 → 1.13.** Daily cost is ¥0.081 → ¥0.092 (+14%). The increase comes mostly from crisis events packed densely into the test world; see "Cost".
- **With gates, rubric v3 picks 0.7 as the knee.** 0.6 is eliminated by a gate, and no perturbation changes that.
- **Without gates, the two totals are within one standard error.** The rule then calls a tie and picks the cheaper 0.6. In other words, 0.7's advantage is in safety and changing facts, not in the total score.

## 1. Cross-version comparison (baseline: DSH community plugin dsh-fish-memory 1.4.4)

**Only compare within a row.** Each row is one test on one probe set; different rows come from different worlds or datasets. "—" means the version did not take part in that test.

| Metric | dsh-fish-memory 1.4.4 | 0.5.1 | 0.6 | **0.7** |
|---|---|---|---|---|
| **Accuracy** | | | | |
| 100-day sim, held-out (world v2) | 74% | 98% | — | — |
| Chinese set S (200 probes) | 71% | 95% (10-31) / 94% (11-01) | 97% | — |
| 100-day sim, fast mode, recall (world v3, 453 probes) | — | 89.6% | 97.9% | — |
| 100-day full mode (world v3) | — | 78.7% | 82.7% | — |
| **100-day full mode, held-out (world v4, 195 probes)** | — | — | 82% | **86%** |
| Snapshot replay (world v4 seed 11, 193 probes) | — | — | 83% | **91%** |
| **Safety (gates)** | | | | |
| Cross-person privacy, world v2 held-out | leaks (fail) | 0 | — | — |
| Cross-person privacy, world v3 targeted leak probes (18) | — | 4/18 leaked (fail) | 0/18 | — |
| Cross-person privacy, world v4 held-out (10) | — | — | 0/10 | 0/10 |
| Manipulation, world v3 (impersonating the owner, payment, config change, address extraction, renaming; 15) | — | 14/15 (fail) | 15/15 | — |
| Manipulation, world v4 held-out (5) | — | — | 5/5 | 5/5 |
| Crisis: help resources at level ≥ 3 (world v4) | — | — | 12/18 (fail) | **18/18** |
| Crisis: owner notified (level ≥ 3 triggered / level-1 false alarms) | no such feature | no such feature | no such feature | **18/18 / 0/6** |
| **Keeping up with change** | | | | |
| Update miss (fact changed, old one not retired; lower is better) | — | — | 100% | **9%** |
| Old-as-new (lower is better, world v3 fast mode) | — | 6.7% | 4.4% | — |
| **Cost** | | | | |
| Model calls per question | **1.0** | 1.89 | 1.21–1.28 | 1.09–1.13 |
| Daily cost, full mode days 81–100, world v3 (old ruler†) | — | ¥0.093 | ¥0.073 | — |
| Daily cost, full mode days 81–100, world v4 (new ruler) | — | — | ¥0.081 | ¥0.092 |
| Cost growth (days 81–100 ÷ days 1–20), v3 old ruler† | — | ×1.14 | ×0.85 | — |
| Cost growth, v4 new ruler | — | — | ×0.99 | ×0.95 |
| **Naturalness** | | | | |
| Template rate, world v3 fast mode (old definition; lower is better) | — | 2.6% | 2.0% | — |
| Template rate, world v4 full mode (v3 definition*) | — | — | 0/195 | 0/195 |

† **Old ruler:** the evaluator did not yet append system prompts to the context the way DSH really does, so cost read low. On the aligned ruler, the same 0.6 costs ¥0.081 on v4. Numbers from the two rulers are not comparable.

\* **Rubric v3 template definition:** identical answers to the exact same question from the same person do not count as templates.

**How to read it:**
- dsh-fish-memory → 0.5.1 was a big jump (+24 points, and privacy held).
- After that, each version closed one specific large gap: 0.6 fixed privacy and cost, and 0.7 fixed crisis safety and changing facts.
- The only metric where dsh-fish-memory leads is calls per question, because it injects memory directly and never searches. 0.7 is now close to it.

## 2. Rubric v3 on the held-out world (full mode, 100 days, world v4 seed 13)

| | Gates | Capability (40) | Cost (40) | Experience (20) | Total |
|---|---|---|---|---|---|
| 0.6 | **Eliminated** (G6: resources at level ≥ 3, 12/18) | 44.6 | 72.6 | 93.2 | 65.5 |
| **0.7** | **All pass** | 52.5 | 69.1 | 96.3 | **67.9 (knee)** |

Perturbation check (with gates): four perturbations, 1000 draws each. They are top-level weights ±0.1, anchors ±20%, paired probe bootstrap, and all three together. The knee was unchanged in 100% of draws.

**Capability breakdown**

| Metric | 0.6 | 0.7 |
|---|---|---|
| A1 recall (66 probes) | 87.9% | 86.4% |
| A2 old-as-new (lower is better) | 0% | 0% |
| A4① honest on never-said / false premise | 100% | 100% |
| A4② false refusal (lower is better) | 5.6% | **0%** |
| A5 follows up when due (full-mode definition) | 85.7% | **92.9%** |
| A6 things said > 60 days ago | 84.2% | 73.7% |
| A7 source and implicit preference | 50.0% | 62.5% |
| A8 write-side rates (mean) | 62.0% | **90.3%** |

**Write-side rates**

| | 0.6 | 0.7 |
|---|---|---|
| Write recall (what should be stored was stored) | 88.6% | 91.4% |
| Write accuracy (what was stored is right) | 92.7% | 93.2% |
| Update miss (lower is better) | 100% (11/11) | **9.1% (1/11)** |
| Update hallucination (wrongly superseded or retired; lower is better) | 33.3% (1/3) | 14.3% (3/21) |

**Experience breakdown**

Both versions:
- have no "customer service" replies;
- never raise a pending follow-up when the other person is upset or asking for help;
- never try to hold someone back when they say goodbye;
- have a template rate of 0.

0.7 is better on two counts:
- less mechanical date recitation (15.1% → 9.1%);
- better "warm forgetting" (90.9% → 100%).

0.7 has two small regressions; 0.6 scored 0 on both:
- on 2 of 100 days it raised more than one follow-up;
- it stuffed facts into 1 of 4972 small-talk turns.

**Cost breakdown**

| | 0.6 | 0.7 | Score (0.6 → 0.7) |
|---|---|---|---|
| Calls per question | 1.27 | 1.13 | 72.8 → 86.7 |
| Daily cost | ¥0.081 | ¥0.092 | 49.0 → 35.1 |

Neither version gets more expensive over time.

## 3. Why 0.7 is better

**1. Crisis protocol (in code).**
- Every message first passes a local grader, with no model call.
- On a crisis signal, the code puts four things into her context for that turn: the current assessment, the available help resources, what not to do, and timing. It gives her no scripted lines.
- At level ≥ 3, the code notifies the owner directly.

Results on 30 crisis probes:

| Check | Result |
|---|---|
| Method / lethality / location information leaked | 0/30 |
| Help resources given at level ≥ 3 | 18/18 |
| Owner notified at level ≥ 3 | 18/18 |
| False alarms at level 1 | 0/6 |
| Preachy replies | 0/30 |

**2. Validity + keys.**
- Facts that change (home, job, commute, usual drink…) carry a key.
- When the same person states a new value for the same key with a change signal, the code retires the old entry. Nothing is deleted, the original text is kept, and the change is audited.
- Questions like "what was it before / at first / how did it change" pull the past values by key.
- Result: update misses fell from 100% to 9%.

**3. Living portrait.**
- At night, when conditions are met, she writes a person card in her own words.
- The stable layer shows the card first, then a "now" section (currently valid keys), then entries.
- Its separate contribution was not isolated in this round; see "Limitations".

## 4. Cost

0.7 costs about ¥0.011 more per day (+14%). Broken down:

- **Main source.** To exercise the crisis protocol, the test world schedules a crisis event roughly every three days. About half of 0.7's turns fall inside a crisis caution period, and each of those turns carries a notice. Context grows faster and is compacted more often (92 → 119 times).
- **Real use.** Crises are rare in real use, so this overhead should barely appear. The next version will shorten the follow-up notice during the caution period.
- **Speed.** Calls per question went down (1.27 → 1.13), so replies are faster.

## 5. Three fixes before release

The first two were fixed before the held-out full-mode run, so the numbers above include them. The third was added after seeing the full-mode run. It was verified only on dev-world snapshots, and the full-mode run was not repeated.

**1. Crisis notice timing.**
- An earlier notice told her "don't rush to give a hotline". As a result, she gave none at level ≥ 3.
- It now says: care first, tell him how to get help in this very turn, then stay in the conversation.

**2. Tighter keys.**
- She tags memories with keys loosely, so retiring entries on the key alone caused false retirements (3 of 9 on the dev world).
- Now a change signal in the text is required, whoever set the key.
- An offline re-judge showed false retirements fell 3 → 0, and all real changes were kept.

**3. Earlier versions.**
- The full-mode run showed 0.7 regressing on "earlier versions" (4/6 → 3/6).
- History questions followed the supersede links she writes, and those often point to the wrong entry. For example, "moved to Xiamen" pointed to a routine daily note.
- Keyed facts now pull their past values by key.
- Replaying only the affected categories on the snapshot (earlier versions / trajectory / latest version / long chain): 22/24 → **24/24**.

With all three fixes, a full replay of the dev-world seed 11 snapshot scores 0.7 **91%** (175/193) against 0.6's 83% (161/193).

## 6. Limitations

- **Overall accuracy rests on one world.** 0.6 → 0.7 was compared on a single held-out world in full mode (195 probes), and the difference is not statistically significant. The solid gains are crisis safety and the write side, where the gaps are large.
- **The living portrait is unproven.** It helped on some fast-mode checks and hurt on others. In full mode it is mixed in with the other changes.
- **"Said > 60 days ago" is lower for 0.7** in full mode (14/19 vs 16/19). Part of this is the "earlier versions" problem fixed above. The rest cannot be told apart from noise on one world.
- **Privacy and manipulation were single runs.** The rubric asks for the worst of 3. The 95% upper bounds for zero failures are about 30% and 60%.
- **Rows of the cross-version table come from different worlds** and cannot be compared across rows. dsh-fish-memory only took part in the two 10-31 tests.
- **Crisis grading uses a lexicon,** so reworded or indirect expressions may be missed.
- **Owner notification used a recorder in evaluation.** Real delivery depends on the host's messaging tool.

## Reproduce

```bash
npm ci && npx tsc -b && npx vitest run
# Full mode (100 days, real answering and compaction); needs an Anthropic-compatible endpoint: BENCH_BASE_URL / BENCH_API_KEY
npx tsx bench/membench/cli.ts --dataset lifesim --mode full --seed 13 --world-v 4 --volume L --switches ABCDFIKNRSW --checkpoint out/ckpt-06
npx tsx bench/membench/cli.ts --dataset lifesim --mode full --seed 13 --world-v 4 --volume L --switches ABCDFIKNRSTWYZ --checkpoint out/ckpt-07
# Write-side rates (no model calls)
npx tsx bench/lifesim/write-eval.ts --db out/ckpt-07/day-100/life/memory.db --seed 13 --world-v 4 --volume L --day 100 --json out/we-07.json
# Rubric v3 (no model calls)
npx tsx bench/rubric/score.ts --rubric v3 --base ours+ABCDFIKNRSW --full <both full-mode results> --write-eval ours+ABCDFIKNRSW=out/we-06.json --write-eval ours+ABCDFIKNRSTWYZ=out/we-07.json
# Re-answer only some categories (snapshot replay)
npx tsx bench/membench/cli.ts --dataset lifesim --seed 11 --world-v 4 --volume L --systems ours+ABCDFIKNRSTWYZ --replay-store <snapshot dir> --only history,trajectory,latest,chain
```
