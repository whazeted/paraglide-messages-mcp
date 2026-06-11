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

**2026-06-11 · active · supersedes 3**

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
