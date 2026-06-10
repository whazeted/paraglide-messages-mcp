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

The fast path applies only when it is provably equivalent to what the SDK
would do: `plugin.inlang.messageFormat` settings with a single string
`pathPattern`, and no other import/export plugin module configured. Projects
with a `pathPattern` array (multi-file namespaces) or other plugins
(i18next, etc.) transparently fall back to the SDK path, which is unchanged.
Setting the `PARAGLIDE_MCP_NO_FAST_PATH` environment variable forces the SDK
path as an escape hatch. An equivalence test
([test/direct.test.ts](test/direct.test.ts)) verifies both paths produce
identical results, and the server remains fully stateless — every call still
reads fresh from disk, so external edits (compiler, editor, git) are always
picked up.

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
