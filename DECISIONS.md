# Decision log

Significant decisions, newest last. Each entry records the context at the
time, what was decided, and what it cost — so future changes can revisit the
reasoning instead of the archaeology.

---

## 1. The agent is the translator; the server validates

**2026-06-10 · active**

MCP servers for translation could call a machine-translation API, or let the
LLM agent translate. The agent is already a strong translator with project
context, so the server does not translate at all: it serves messages,
validates every submitted translation against the source (placeholders,
markup, variant structure), and writes the accepted ones. Per-item
validation means one bad translation never blocks or corrupts the rest of a
batch — this property ends up carrying most later decisions.

## 2. Stateless server, always-fresh reads

**2026-06-10 · active**

The server holds no translation state between tool calls: every call reads
the project from disk. External edits (editor, Paraglide compiler, git
operations) are always picked up, and killing the `npx` process never loses
anything. Later refined by the stat-validated cache (decision 9), which
keeps the observable behavior while removing the re-parsing cost.

## 3. Small validated batches

**2026-06-10 · superseded by 7**

Initial batch sizes were 5 (default) / 25 (max), on the theory that small
batches keep agent error rates low. Benchmarking the full pipeline showed
that per-item validation already contains errors at any batch size, and the
batch size directly multiplies per-call overhead and agent round-trips.

## 4. Direct JSON file access instead of the inlang SDK per call

**2026-06-10 · active (extended by 8)**

Originally every tool call ran the full inlang SDK lifecycle, importing
every message of every locale into sqlite-wasm and re-exporting every file
on save — per-call cost grew with project size (a 2,000-message full run
extrapolated to ~21 minutes). For message-format projects the files are
plain JSON at a known location, so the server reads/writes them directly,
byte-compatible with the plugin's export. Full translation run: ~21 min →
~1.7 s. See [PERFORMANCE.md](PERFORMANCE.md).

## 5. One agent per locale, in parallel; scoped per-locale I/O

**2026-06-11 · active**

Every locale lives in its own file and saves only touch the target locale's
file, so the client can fan out one subagent per locale. Benchmarked with
full byte-verified runs: server work doesn't parallelize in-process, but
agent translation time — the real bottleneck — does, approaching N× for N
locales. To make this first-class, `get_translation_batch` /
`save_translations` load only the source and target locale (scoped reads),
which both cut per-call cost and guarantee subagents never read or write
each other's files. Trade-off accepted: the unknown-key check on save sees
base + target keys only (`allowNewKeys` covers the exotic case).

## 6. The orchestrator owns the style brief

**2026-06-11 · active**

Parallel subagents must not each invent their own tone, formality, or
terminology. The `translate_project` prompt (and the bundled skill) has the
main agent sample messages and settle a style brief — tone, per-language
formality (Sie/du, u/je, …), glossary — *before* fanning out, passing it to
every subagent verbatim. Distributing message *content* through the
orchestrator was rejected: subagents get source text from
`get_translation_batch` directly, and prompt-distribution would cost more in
tokens than the reads cost in milliseconds (see decision 9 for the native
alternative).

## 7. Large batches: default 50, max 200

**2026-06-11 · superseded by 12 · supersedes 3**

With per-item validation (decision 1), a bad item in a 200-message batch is
rejected alone — large batches carry no correctness risk, and they cut both
server cycles and agent round-trips ~8×. Combined with scoped reads, a full
10-locale run over 5,000 messages dropped from ~96 s to under 5 s of server
time. Guidance stays: drop to 5–10 manually for long, nuanced prose.

## 8. Drop the inlang SDK entirely; message-format projects only

**2026-06-11 · active**

The SDK fallback (i18next, next-intl, ICU plugins, multi-file
`pathPattern`) was incompatible with the parallel design: it rewrote every
locale file on each save, so concurrent per-locale agents would clobber each
other. Keeping it meant parallel-safety was a property of the common path,
not a guarantee. Dropped it: direct file access is the only backend,
unsupported projects fail fast with a clear error, and `@inlang/sdk` +
sqlite-wasm left the dependency tree (~23 MB / 92 packages for an npx user,
0.1 s cold start, fully offline). Cost: non-message-format projects are no
longer supported at all — recorded in [COMPATIBILITY.md](COMPATIBILITY.md).

## 9. Stat-validated, write-through file cache

**2026-06-11 · active · refines 2**

With 10 subagents each parsing the same base locale file twice per cycle,
reads dominated server time. Instead of distributing the source through the
orchestrator (wrong layer — see decision 6), the server shares one parsed
copy of each locale file across all agents: every read stats the file
(mtime + size) and re-parses only on change; saves update the cache
write-through. External edits still invalidate per call, so "always fresh"
(decision 2) holds observably. Steady-state translate cycle: two stats and
one file write. Full XL run: ~4.8 s → ~3.0 s, now bounded by write
serialization and agent speed.

## 10. Synchronous TranslationService

**2026-06-11 · active**

The async method signatures were an SDK vestige — every operation is
synchronous fs work. Making the service sync encodes the concurrency
guarantee in the type system: a tool call runs atomically on the event loop
and *cannot* interleave with another, so concurrent per-locale agents never
observe a half-applied operation.

## 11. MIT license, rename to `paraglide-messages-mcp`

**2026-06-11 · active**

The package name `paraglide-mcp` over-promised after decision 8 — the server
supports exactly the `messages/{locale}.json` (inlang message format) setup,
not every Paraglide-adjacent project. Renamed to `paraglide-messages-mcp`
to make the scope part of the name, added the MIT license file, and split
the README into a minimal public-facing page with developer detail in
[DEVELOPMENT.md](DEVELOPMENT.md) and this log.

## 12. No batch size caps, default only

**2026-06-11 · active · supersedes 7**

The 200-item caps on `get_translation_batch`, `save_translations`, and
`delete_messages` were dropped; only the default batch size of 50 remains.
The caps were a holdover from the small-batch era (decision 3): per-item
validation means a bad item never sinks a call regardless of size, and the
caps only forced agents to split large runs into artificial chunks. Agents
still steer the size themselves — raise it for short UI strings, drop to
5–10 for long, nuanced prose.

## 13. Defaults only everywhere; guidance by direction, not numbers

**2026-06-11 · active · extends 12**

The remaining caps (`MAX_KEYS_LIMIT`, `MAX_MESSAGES_LIMIT`,
`MAX_SEARCH_LIMIT`) were dropped for the same reason as the batch caps:
they only forced artificial chunking. `src/core/constants.ts` now holds
defaults only; any positive value is accepted. Prompt, skill, and tool
texts stopped quoting concrete numbers (e.g. "drop to 5–10") — hard-coded
numbers drift from the constants and read as rules. They now state the
direction and its effect instead: raising the batch size means fewer
round-trips (short UI strings); lowering it gives each item more of the
agent's attention (long, nuanced prose).

## 14. Predicted-output-token batch budget, self-calibrating

**2026-06-11 · active · extends 12, 13**

Thesis revisited: "smaller batches mean more attention per item." The real
mechanism is that quality degrades with how much a model must *generate* in
one response — output, not input. Long-context agent models don't change
this: reading is cheap, but deep into a long emission translations drift
formulaic, and a `max_tokens` truncation mid-JSON fails the whole save. The
server's batch is the unit an agent translates in one generation, so batch
sizing is the lever that shapes per-generation output.

Decided: a batch ends at `batchSize` items **or** a predicted-output-token
budget, whichever comes first — default-on, overridable, `0` disables
(escapable, per decision 13's philosophy). Count-only ordering is kept
(alphabetical = prefix locality, so related keys still travel together);
a length *sort* was rejected for destroying exactly that locality.

Prediction: source chars × a coefficient (output tokens per source char).
Exact tokens are impossible in principle — the server can't know the client
model's tokenizer — but BPE tokenizers agree on per-script densities, so a
character-class estimate is within ~15%. The coefficient is measured from
the locale's own translations (median per-key ratio, ≥ 100 translated keys)
instead of parsing locale tags, which are arbitrary strings (`english.json`
is valid). Below the threshold the prediction falls back to the source
text's own estimated tokens — a conservative floor measured from data in
hand (translations are rarely shorter than their source in token terms),
not a guess about the target language. A flat per-language coefficient
table was considered and rejected; so was count-only batching before
calibration, which left exactly the cold-start prose batch — the case the
feature exists for — unprotected, and made `maxOutputBudget` a silent no-op
until calibration. The calibration feedback loop is self-correcting
(verbose translations → higher coefficient → smaller batches), confined to
batch sizing, never to content.

Effect: short-UI-string projects still fill the full batch size; prose-heavy
projects get small batches from the very first call, with the prediction
tightening to the measured ratio once the locale crosses the threshold.

Supporting research for "quality degrades with output length, not input
length":

- [LongProc (Ye et al., 2025)](https://arxiv.org/abs/2501.05414) — models
  with 32k+ context windows degrade sharply on *procedural generation*
  (structured long-form output, the closest shape to a translation batch):
  open-weight models falter at ~2k output tokens, frontier models by 8k.
- [LongWriter (Bai et al., ICLR 2025)](https://arxiv.org/abs/2408.07055) —
  effective generation length is bounded by the output lengths seen in
  alignment training (mostly < 2k words), independent of how much the model
  can read; long-output training lifts the bound.
- [HelloBench (Que et al., 2024)](https://arxiv.org/abs/2409.16191) —
  open-ended long-form generation shows repetition and quality decay well
  before hard output limits.
- Document-level MT specifically:
  [Translation Mixed-Instructions (Li et al., 2024)](https://arxiv.org/abs/2401.08088)
  finds translation quality collapses past ~512–2048 input-output tokens per
  call (models drift to summarizing instead of translating), and
  [book-length MT evaluation (2025)](https://arxiv.org/html/2509.17249v1)
  observes sharp degradation at 4k–8k.

## 15. Empirical calibration method for the output-token budget

**2026-06-11 · active · extends 14**

`DEFAULT_OUTPUT_TOKEN_BUDGET = 1500` is anchored to external research on
long-output degradation (LongProc, LongWriter, document-level MT), not to
measurements of this system translating this kind of content. Like every
number in this log, it is policy — and policy anchored to someone else's
experiments on someone else's models goes stale silently with each model
generation. Rather than treat 1500 as permanent, the repo now carries a
reproducible way to re-derive it: a vendored 10-category corpus
(recency-filtered, partly original works), an instrumented budget sweep
that logs one JSONL row per translated item, tiered metrics (mechanical
checks, an MQM judge scoring over-verbosity/over-compression, blind
head-vs-tail pairwise), and an analysis layer that detects the decay onset
per budget — the first position/token bucket whose scores leave the head
buckets' noise floor (see [test/quality/](test/quality/) and the
calibration section of [PERFORMANCE.md](PERFORMANCE.md)).

The cost is carried weight: corpus files, a judge whose own reliability has
to be gated (anchor recall, self-consistency, cross-judge kappa, position
bias), and a paid run per model generation. The measurement is deliberately
relative — decay across output positions — because memorized corpus text
does not vary by position, so contamination cancels out of the comparison
even though it can never be ruled out. No measured numbers exist yet; the
default stays 1500 until the first paid sweep says otherwise.

## 16. Budget predicts full emission, not just translated text

**2026-06-11 · active · refines 14**

The budget's prediction counted only translatable pattern text, but quality
decays with TOTAL generated tokens — and a translating agent emits more
than text per item: the JSON wrapper, the echoed message key, and for
variant messages the declarations/selectors/match scaffolding. For long
prose the envelope is a rounding error; for a batch of 50 short UI strings
it can approach half the real emission, so text-only prediction
systematically under-budgeted exactly those batches. It also meant the
benchmark (which measures exact billed tokens, envelope included) and the
server (which budgeted text tokens) used different units — a calibrated
default would have carried a hidden ~10–30% margin.

`predictOutputTokens` now adds `emissionOverheadTokens`: a constant for the
JSON wrapper, the key's estimated tokens, and the serialized-minus-text
chars of variant structures. The calibrated coefficient stays text-vs-text
(stored translations contain no envelope), so the overhead term never
double-counts. The benchmark driver uses the same estimator for dry-run
totals and for apportioning exact call totals across items, so both sides
of the system now account in the same unit: real emitted tokens.
