# Performance

How fast the server's tool calls are, how that was measured, and what was
done to make them fast.

## Methodology

Benchmark: [test/benchmark.test.ts](test/benchmark.test.ts), run with
`pnpm bench`. It measures the service layer (`TranslationService`), where all
project I/O happens — MCP transport overhead is constant and negligible in
comparison.

The workload mirrors what an MCP agent actually does (the workflows from the
bundled prompts/skill):

- one-off reads: `project_info`, `list_message_keys`, `get_messages`
  (median of 3 runs each)
- the translate loop: `get_translation_batch` (batch size 5, the default the
  prompts recommend) followed by `save_translations`, repeated until the
  locale is fully translated

Two generated fixture projects, both with 11 locales (`en` base + 10 targets)
and realistic message shapes (single words, placeholder sentences,
multi-sentence paragraphs, plural variant arrays — see
[test/generate-messages.ts](test/generate-messages.ts)):

- **small**: 250 messages — an early-stage app; the full translation run is
  measured end to end
- **large**: 2,000 messages — a mature app; the run is measured for 20 cycles
  and extrapolated to the full 400

Numbers below were taken on an Apple M1 Max (macOS 26.5, Node 24), writing to
the local SSD. Treat them as relative, not absolute.

## Baseline (v0.1.0, before the fast path)

Originally, every tool call went through the full inlang SDK lifecycle:
`loadProjectFromDirectory` (which imports **all** messages of **all** locales
into the SDK's internal SQLite database), the operation itself, and — for
saves — `saveProjectToDirectory`, which re-exports and rewrites **every**
locale file even when a single locale changed.

### Small project (250 messages, 11 locales)

| operation | time |
| --- | --- |
| `project_info` | 156 ms |
| `list_message_keys` (missing in de, limit 100) | 150 ms |
| `get_messages` (prefix `checkout_`, en+de) | 145 ms |
| translate cycle (batch 5: get batch + save) | 380 ms |
| full `de` run, measured (50 cycles) | **19.3 s** |

### Large project (2,000 messages, 11 locales)

| operation | time |
| --- | --- |
| `project_info` | 1,066 ms |
| `list_message_keys` (missing in de, limit 100) | 1,079 ms |
| `get_messages` (prefix `checkout_`, en+de) | 1,038 ms |
| translate cycle (batch 5: get batch + save) | 3,168 ms |
| full `de` run, extrapolated (400 cycles) | **~21 min** |

Two properties made this scale badly:

1. **Per-call cost grows with total project size**, not with the size of the
   request — fetching 5 messages costs the same as loading everything,
   because it *is* loading everything.
2. **The batch loop multiplies it.** A full run is `messages / batchSize`
   cycles, each paying the full load twice (get + save). Total work grows
   roughly quadratically with project size. On top of the latency, every
   save rewrote all 11 locale files, retriggering any file watcher
   (e.g. the Paraglide compiler in dev mode) 11× harder than necessary.

## After the direct file access fast path

### What changed

For projects using the message-format plugin — the standard Paraglide setup —
the message files are plain JSON at a known location
(`pathPattern: "./messages/{locale}.json"`). Nothing about reading or
writing them requires the SDK, so the server now accesses them directly
([src/core/direct.ts](src/core/direct.ts)):

1. **Reads** parse and flatten the locale JSON files straight from disk
   instead of importing everything into the SDK's SQLite database first.
2. **Writes** merge the accepted translations into the target locale's file
   and write *only that file*, instead of `saveProjectToDirectory` rewriting
   every locale. Output stays byte-compatible with the plugin's export
   (`$schema` first, tab indentation, the plugin's optional `sort` setting
   is honored). This also stops file watchers (e.g. `paraglide dev`) from
   being triggered for 10 unchanged locales on every save.
3. **`remainingForLocale`** after a save is computed by merging the accepted
   values into the already-loaded snapshot in memory, instead of re-exporting
   the whole project a second time. (This applies to the SDK path too.)

At this stage the fast path applied only when it was provably equivalent to
what the SDK would do: `plugin.inlang.messageFormat` settings with a single
string `pathPattern`, and no other import/export plugin module configured.
Other projects transparently fell back to the SDK path, and a
`PARAGLIDE_MCP_FORCE_SDK` escape hatch plus an equivalence test guarded the
two implementations. (The SDK path has since been removed entirely — see
"Dropping the SDK" below.) The server remains fully stateless — every call
still reads fresh from disk, so external edits (compiler, editor, git) are
always picked up.

### Small project (250 messages, 11 locales)

| operation | before | after |
| --- | --- | --- |
| `project_info` | 156 ms | 1 ms |
| `list_message_keys` (missing in de, limit 100) | 150 ms | <1 ms |
| `get_messages` (prefix `checkout_`, en+de) | 145 ms | <1 ms |
| translate cycle (batch 5: get batch + save) | 380 ms | 1 ms |
| full `de` run, measured (50 cycles) | **19.3 s** | **76 ms** |

### Large project (2,000 messages, 11 locales)

| operation | before | after |
| --- | --- | --- |
| `project_info` | 1,066 ms | 3 ms |
| `list_message_keys` (missing in de, limit 100) | 1,079 ms | 2 ms |
| `get_messages` (prefix `checkout_`, en+de) | 1,038 ms | 2 ms |
| translate cycle (batch 5: get batch + save) | 3,168 ms | 4 ms |
| full `de` run, extrapolated (400 cycles) | **~21 min** | **~1.7 s** |

### Why it's this much faster

The baseline cost was never the JSON files — 2,000 messages × 11 locales is
about 2 MB of JSON, which Node parses in a few milliseconds. The cost was
the SDK's general-purpose project lifecycle: instantiating a sqlite-wasm
database, importing every message of every locale into it, querying it back
out, and serializing everything to disk again — per tool call, because the
server is deliberately stateless. The fast path doesn't make that machinery
faster; it removes it for the case where the files themselves are already
the storage format. Server overhead per tool call is now effectively flat
(single-digit milliseconds) instead of growing with project size, so total
translation-run overhead grows linearly with message count instead of
quadratically.

## Concurrent per-locale subagents

Every locale lives in its own JSON file and `save_translations` writes only
the target locale's file, so a client agent can fan out one subagent per
locale and translate all locales concurrently instead of one after another.

Benchmark: [test/benchmark-subagents.test.ts](test/benchmark-subagents.test.ts),
run with `pnpm bench:subagents`. It does *full, real* translation runs (no
extrapolation, every read and write hits disk) of all 10 target locales on an
XL fixture — **5,000 messages × 11 locales** — in two orchestrations:

- **sequential** (before): one agent, locale after locale
- **subagents** (after): 10 concurrent per-locale translate loops against the
  same server process — the topology subagents actually have, since they
  share the parent session's MCP server connection

Each orchestration is measured twice: with zero agent latency (pure server
I/O cost) and with 25 ms simulated agent latency per cycle, a scaled-down
stand-in for the time the model itself spends producing a batch of
translations (in reality seconds, not milliseconds). After every run, each
target file is verified to contain every key with exactly the expected value
for *that* locale, and the base file to be byte-identical — so lost writes or
cross-locale contamination would fail the benchmark.

### Baseline (full-snapshot reads, batch 25)

Before the scoped-read architecture below, every tool call re-read **all 11
locale files**, and batches were capped at 25:

| scenario | wall time | vs sequential |
| --- | --- | --- |
| sequential, no agent latency | 92.1 s | — |
| subagents, no agent latency | 96.5 s | 1.05× slower |
| sequential + 25 ms agent latency/cycle | 146.5 s | — |
| subagents + 25 ms agent latency/cycle | **96.1 s** | **1.52× faster** |

Two findings from this baseline:

1. **It is safe.** All runs produced byte-correct results. Within one server
   process the direct path's file I/O is synchronous, so every tool call
   reads and writes atomically with respect to the others — concurrent
   per-locale loops cannot tear each other's files, and since each save
   touches only its own locale's file there are no write conflicts to begin
   with.
2. **Agent time is what parallelizes, server work is not** (same total work
   on one thread, ~5% scheduling overhead). But the full-snapshot reads put
   the server floor at ~46 ms per cycle (~92 s per full run) — parsing 9
   locale files the call never used.

## Scoped reads + large per-locale batches

### What changed

The translate loop is a *per-locale* operation, so it no longer touches the
rest of the project:

1. **`get_translation_batch` reads only the source and target locale files**
   (plus the base locale when it differs); **`save_translations` reads base +
   target and writes only the target file** (see `ReadOptions` in
   [src/core/storage.ts](src/core/storage.ts)). A per-locale subagent's calls
   never read or write a sibling locale's file — verified by a test that
   corrupts an unrelated locale file and translates another locale anyway.
   Full-project operations (`project_info`, `list_message_keys`,
   `get_messages`, `search_messages`, delete/rename) still load every locale.
2. **Batch limits were raised for per-locale throughput**
   ([src/core/constants.ts](src/core/constants.ts)): default batch size 5 →
   50, and the upper caps were later removed entirely. Large batches are safe
   because validation is per item — a bad translation is rejected
   individually, never the whole call.
3. **Orchestration is now first-class**: the `translate_project` prompt (and
   the bundled skill) has the main agent settle a style brief — tone,
   per-language formality, glossary — *before* fanning out one subagent per
   locale, so all locales translate in parallel with a shared style.

One deliberate semantic consequence: `save_translations`' unknown-key check
now sees the keys of base + target only, so a key existing *only* in some
third locale needs `allowNewKeys: true`.

### Results (same XL fixture and machine, after the change)

| scenario | wall time | vs baseline |
| --- | --- | --- |
| batch 25, sequential, no agent latency | 37.5 s | 2.5× faster |
| batch 25, subagents, no agent latency | 37.1 s | 2.6× faster |
| batch 25, sequential + 25 ms agent latency/cycle | 94.2 s | 1.6× faster |
| batch 25, subagents + 25 ms agent latency/cycle | 36.3 s | 2.6× faster |
| batch 200, sequential, no agent latency | 4.9 s | 19× faster |
| batch 200, subagents, no agent latency | 4.8 s | 20× faster |
| batch 200, subagents + 25 ms agent latency/cycle | **4.9 s** | **20–30× faster** |

All runs byte-verified, as before. Scoped reads cut the pure server cost
2.5× (a cycle reads 2 files instead of 11); batch 200 cuts the number of
cycles 8× on top of that, taking a full 10-locale run of a 5,000-message
project from ~96 s of server time to **under 5 s**. With agent latency in the
picture the combined effect is larger (146.5 s → 4.9 s in the simulated run),
and in reality — where producing a batch takes the model seconds, not 25 ms —
the dominant win remains fanning out: ten locales' worth of model time runs
in parallel while the server's ~5 s of I/O disappears into it.

## Dropping the SDK

With the scoped-read architecture in place, the inlang SDK fallback was
removed entirely: direct message-format file access is the only storage
backend, and unsupported projects (other plugins, multi-file `pathPattern`
arrays) fail fast with a clear error instead of degrading to the slow path
(see [COMPATIBILITY.md](COMPATIBILITY.md)). Beyond deleting code, this
matters for the parallel-agent design:

- The SDK path rewrote **every** locale file on each save, so concurrent
  per-locale agents on that path would have clobbered each other. Now
  parallel-safety is a guarantee of the only path, not a property of the
  common one.
- All project I/O is synchronous, so every tool call is atomic with respect
  to concurrent calls in the same process by construction.
- `@inlang/sdk` and the bundled `@inlang/plugin-message-format` left the
  dependency tree (runtime deps are now just the MCP SDK, `flat`, and `zod`)
  — no sqlite-wasm instantiation at startup, faster `npx` cold start, and
  fully offline operation.

## Native to the concurrent model: shared parsed files, synchronous service

With one storage backend, two more changes made the architecture native to
the per-locale-subagent topology:

1. **A stat-validated, write-through file cache**
   ([src/core/direct.ts](src/core/direct.ts)). All subagents share one
   parsed copy of each locale file: the first reader parses, every later
   call — any subagent, any service instance — pays a `statSync` (mtime +
   size check) instead of a parse. Saves update the cache write-through, so
   a subagent's own steady-state translate cycle reads via two stats and
   pays only for its one file write. This is the server-side version of
   "the main agent distributes the source locale to the subagents":
   distributing message content through agent prompts would cost far more
   in tokens than the reads cost in milliseconds and would still leave save
   validation needing the base file — sharing the parsed base in-process
   gives the same reduction with validation intact. External edits
   (compiler, editor, git) still invalidate via the stat check, so observed
   behavior stays "always fresh".
2. **`TranslationService` is synchronous** — the async façade was an SDK
   vestige. Sync signatures encode the atomicity guarantee in the type
   system: a tool call cannot interleave with another, by construction.
   (`pluginKey` threading, another SDK-era leftover, was removed the same
   way — it is a constant now.)

### Results (same XL fixture and machine, cache vs. scoped reads alone)

| scenario | scoped reads | + file cache |
| --- | --- | --- |
| batch 25, sequential, no agent latency | 37.5 s | 23.5 s |
| batch 25, subagents, no agent latency | 37.1 s | 22.8 s |
| batch 25, subagents + 25 ms agent latency/cycle | 36.3 s | 23.2 s |
| batch 200, sequential, no agent latency | 4.9 s | 3.1 s |
| batch 200, subagents, no agent latency | 4.8 s | **3.0 s** |
| batch 200, subagents + 25 ms agent latency/cycle | 4.9 s | **3.1 s** |

All runs byte-verified, as always. The standard benchmark improved the same
way (large-project full `de` run: 1.5 s → 0.9 s; one-off reads at 2,000
messages: 1–2 ms). What remains of the ~3 s is dominated by the 2,500
target-file writes themselves (unflatten + serialize + write of files
growing to ~600 KB) — reads are effectively free now, so the full
translation pipeline is bounded by the agent's own translation speed plus
the cost of physically writing the results.

## Output-token budget calibration (method)

Everything above measures the *server*; this section is about the *agent*.
`DEFAULT_OUTPUT_TOKEN_BUDGET` in
[src/core/constants.ts](src/core/constants.ts) (currently 1500) caps how
many output tokens a translation batch should target before quality is
assumed to degrade. That number is anchored to external research on
long-output LLM degradation — LongProc ([arXiv:2501.05414](https://arxiv.org/abs/2501.05414)),
LongWriter ([arXiv:2408.07055](https://arxiv.org/abs/2408.07055)), and
document-level MT studies ([arXiv:2401.08088](https://arxiv.org/abs/2401.08088)) —
not to measurements on this system. The benchmark under
[test/quality/](test/quality/) exists to replace that borrowed anchor with
a measured one.

### How to run

```
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... pnpm bench:quality
```

Without API keys the harness performs a dry run (corpus loading, batch
construction, JSONL plumbing, analysis) with no model calls. Models are
addressed as `<provider>:<model>` specs — `anthropic:` and `openai:` are
supported, and a bare model id means Anthropic — each gated on its own key
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). Configuration, all pre-run via
env:

- `BENCH_TRANSLATOR_MODEL` (default `claude-sonnet-4-6`) — does the
  translating; an OpenAI translator is just
  `BENCH_TRANSLATOR_MODEL=openai:<model>`.
- `BENCH_JUDGE_MODELS` — comma-separated judge specs (default
  `claude-opus-4-8`). Judges may be any mix of providers and are
  deliberately allowed to differ from the translator: a cross-provider
  panel (e.g. `anthropic:claude-opus-4-8,openai:<model>`) removes not just
  self-preference but family-preference bias, and with two or more judges
  the run reports cross-judge agreement (raw % and Cohen's kappa). A judge
  whose provider key is missing is skipped and recorded as skipped — never
  silently stubbed.
- `BENCH_JUDGE_SAMPLE` (default 20) — rows MQM-judged per budget × locale
  group, sampled evenly along the cumulative-output-token axis so head and
  tail of every generation are represented; every judge scores the same
  sample.

Every run documents itself: the markdown report opens with a run-metadata
block (mode, translator, judges incl. skipped ones, sample size, budgets,
locales, cross-judge agreement) and a machine-readable
`bench-results/<stamp>-config.json` records the same alongside the JSONL.

### The corpus

[test/quality/corpus/](test/quality/corpus/) holds 10 categories × 10
paragraphs of source prose, all open-licensed or authored for this repo,
under a recency rule: fetched text must postdate 2025-06 so it falls after
plausible training cutoffs. Categories span the message shapes the server
actually sees, from terse UI strings to long narrative paragraphs.

### Metric tiers

- **Tier 1 — mechanical** ([test/quality/metrics.ts](test/quality/metrics.ts)):
  deterministic per-item checks (length ratios, placeholder/markup survival,
  copy-through and repetition detection). Free, runs on every row.
- **Tier 2 — MQM judge**: an LLM judge produces MQM-style error counts per
  item, including over-verbosity and over-compression — the two failure
  modes length pressure produces that mechanical checks see only as a
  length ratio.
- **Tier 3 — blind pairwise**: head items vs. tail items from the same run,
  source order shuffled and labels hidden, judged head-to-head.

### Judge reliability gates

Tier 2 and 3 scores only count when the judge passes its gates: recall on
planted anchor errors, self-consistency across repeated judgments of the
same item, cross-judge agreement (kappa), and A/B position bias ≈ 50% in
the pairwise tier. A judge that fails its gates invalidates the run rather
than quietly skewing it.

### Analysis

[test/quality/report.ts](test/quality/report.ts) parses the runner's JSONL
(one row per translated item; malformed lines are collected, never fatal),
groups rows by budget × locale, and buckets them by position-in-batch and
by cumulative-output-token band. For each budget it detects the **decay
onset**: the first bucket whose metric mean leaves the head buckets' noise
floor (head mean + 2× head stddev). The calibrated default is then the
largest budget whose sweep shows no onset — measured, not borrowed.

### Caveats

The honest limits of this method: corpus text fetched from the web is
recency-filtered and four categories are original works written for this
repo, but crawled text can never be *guaranteed* uncontaminated — a model
may have memorized some source passage anyway. That is why the measurement
is **relative** decay across output positions, not absolute quality:
memorization does not vary by where in the batch an item lands, so it
cancels out of the head-vs-tail comparison. Results are also
model-specific; a budget calibrated for one model generation should be
re-measured for the next. No measured numbers exist yet — this section
documents the method, and results will be appended here after the first
paid run.
