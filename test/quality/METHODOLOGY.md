# Translation Quality Calibration Methodology

This benchmark calibrates a safe output-token budget for translation batches.
The value is model-specific: each translator model can keep quality stable for a
different amount of generated text, so the suite sweeps budgets and recommends
the largest nonzero budget whose quality does not decay across locales and
metrics.

## Workflow

Run the sweep with:

```sh
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... pnpm bench:quality
```

The runner writes JSONL rows, markdown reports, and config JSON into
`test/quality/reports/`. Without provider keys, the suite performs a dry run
that validates corpus loading, batch construction, report writing, and JSONL
plumbing. Dry runs are always non-admissible and never emit a recommended
default.

Each live run records:

- the translator model, judge models, skipped judges, budgets, and locales
- one row per translated item, including cumulative output-token position
- Tier 1 mechanical metrics on every row
- Tier 2 MQM scores only when judge reliability gates pass
- Tier 3 blind pairwise head-vs-tail results
- gate statuses, metric onsets, admissibility, and the recommended default

## Metric Tiers

Tier 1 uses deterministic signals: validation failure, copy-through, terseness,
repetition, and summarization outliers. These are cheap and run on every row.

Tier 2 uses MQM-style LLM judging. The judge receives only source text,
translation text, and target locale. It never sees batch position, budget, token
counts, or the decay hypothesis.

Tier 3 compares head-of-generation and tail-of-generation items blindly. A/B
presentation order is randomized and later unshuffled so pairwise results can
detect both quality decay and judge position bias.

## Admissibility Gates

A run can recommend a default only when all gates pass:

- at least one active live judge
- planted-anchor MQM recall at least `0.80`
- planted-good false alarm rate at most `0.20`
- repeat-judgment self-consistency at least `0.85`
- cross-judge Cohen's kappa at least `0.40` when two or more judges are active
- pairwise A-slot decisive win rate in `0.40..0.60`
- at least 20 decisive pairwise verdicts per active judge

If a gate fails or is inconclusive, the report is still useful for debugging,
but the run is not admissible and `recommendedDefaultByModel.recommendedDefault`
is `null`.

## Recommendation Rule

For an admissible run, the suite computes metric onsets by budget and locale on
the cumulative-output-token axis. An onset is the first bucket whose metric mean
exceeds the head buckets' noise floor. The recommendation is the largest nonzero
swept budget with no detected onset for every reported metric and target locale.
Budget `0` is an unbounded control arm and is never recommended.

## Source Rationale

| Source | Rationale |
| --- | --- |
| [GEMBA-MQM](https://aclanthology.org/2023.wmt-1.64/) | Establishes reference-free MQM-style LLM judging for machine translation, matching this suite's need to judge translations without human references. |
| [MT-Bench / Chatbot Arena LLM-as-judge](https://arxiv.org/html/2306.05685v4) | Identifies LLM judge risks including position, verbosity, and self-enhancement bias, motivating off-family judges, blind prompts, and explicit gates. |
| [G-Eval](https://aclanthology.org/2023.emnlp-main.153/) | Supports rubric-driven structured output for LLM evaluation, which this suite applies through constrained JSON MQM responses. |
| [A Systematic Study of Position Bias](https://arxiv.org/html/2406.07791v9) | Shows that position bias can distort pairwise/listwise judging, motivating randomized A/B order and the A-slot win-rate gate. |
| [WMT24 Metrics Shared Task](https://aclanthology.org/2024.wmt-1.2/) | Shows that LLM-generated MT stresses automatic metrics, motivating a multi-signal approach rather than relying on one judge score. |
| [RUBRIC-MQM](https://aclanthology.org/2025.acl-industry.12/) | Highlights label bias and near-perfect-translation limits in LLM-as-judge MT evaluation, motivating planted anchors and judge meta-evaluation. |

