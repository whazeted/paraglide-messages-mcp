# Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test             # unit and integration tests
pnpm test:all         # build plus tests, including the real stdio CLI
pnpm bench            # legacy library query/save performance
```

Tests use disposable Paraglide projects. Batch tests exercise the real OpenAI SDK against an injected fetch implementation; they need no API key and create no paid requests. They cover restart recovery, ambiguous upload/create responses, conflict preservation, partial failures, refusals, cancellation, cleanup retries and replay. HTTP integration tests pin `2026-07-28`, assert that no initialize/session exchange occurs, and collect through a fresh handler/client. CLI tests cover modern and legacy stdio openings.

For an explicitly authorized paid smoke test, build first, then run `node scripts/live-batch.mjs` with `OPENAI_API_KEY` in the environment, or add `--env-file /path/to/.env`. It submits three synthetic Dutch translations once, keeps the job ID in ignored `.paraglide-live-test/`, and resumes that same job on subsequent runs. Add `--wait` to poll once per minute until collection and cleanup finish. After completion it checks saved values, preserved placeholders/variants and source text, and verifies remote files return 404. Environment file values are read only into the process; key values are redacted from printed errors. The test does not edit a real project's catalog.

## Architecture

| Module | Responsibility |
| --- | --- |
| `cli.ts` | Project discovery, stdio serving, one-pass `--resume` collector |
| `server.ts` | SDK v2 server factory and stateless HTTP handler |
| `primitives/tools.ts` | Nine tools with compact Zod v4 schemas |
| `core/batch.ts` | OpenAI request planning, durable reconciliation, collection, cleanup |
| `core/durable.ts` | Flushed atomic writes and recoverable process locks |
| `core/service.ts` | Local inspection and validated edits; existing library API |
| `core/storage.ts` | Scoped snapshots and locked catalog mutations |
| `core/direct.ts` | Direct message-format JSON I/O with stat-validated cache |
| `core/format.ts`, `save.ts` | Message structure, placeholder, markup and selector validation |
| `core/queries.ts`, `mutate.ts`, `locales.ts` | Existing local library helpers |

The runtime imports the server-only MCP package. The client package is a development dependency. There are no agent fan-out prompts, duplicate resources, embedded polling loops, framework servers or task/session state.

## Job lifecycle

`prepared → uploading → uploaded → submitting → submitted → applied → cleanedUp`

Each transition is persisted before or after its remote side effect as appropriate. IDs, snapshot values, request `custom_id`s, model and style are immutable for that job. Unique upload filenames recover lost upload responses without mixing different projects. After a lost batch-create response, list batches and match both job metadata and input file ID; do not retry creation on an ambiguous failure. Definitive API rejections permit a later retry.

One request contains up to 50 messages for one locale and at most 24 KB of serialized message context. Each request has an exact JSON Schema for its keys and variant structure. Existing target style examples are capped at five and 6 KB per locale. Jobs above OpenAI's 50,000-request or 200 MB input limit are rejected before upload; use a narrower prefix/locales. The Responses API uses `store: false`, Luna low by default, strict Structured Outputs and a 32,768-token output cap. A refused, incomplete, invalid or missing response becomes an item failure.

Terminal output/error JSONL is archived locally before catalog writes. Map results by `custom_id`, never line order. Before applying each item, compare the current source and target with the submitted snapshot. A target equal to the generated result is allowed so interrupted application can be replayed. Validate with the same save core as manual edits, then atomically replace each affected locale file. Source/target changes and removed locales become item failures. The final outcome checkpoint precedes remote file deletion; persist each deletion so cleanup itself is replayable.

Successful partial results from failed/expired/cancelled batches are collected. Cancellation is durable and may remain `cancelling` for ten minutes. No completed-batch close/delete API exists: clean up its files, retain the job manifest and local archives for audit/recovery. File expiration is set to 30 days; a result that expires before collection cannot be recovered by this service.

## Storage boundaries

Job and catalog locks identify process PID, host and a unique ownership token. Publish complete lock metadata atomically using an exclusive hard link. Recover only locks whose process is demonstrably gone; serialize reclamation under a recoverable lock. A live competing operation fails with a retryable busy error. Writes flush data before renaming a sibling temporary file. The cache checks mtime, ctime, inode and size so file replacements and external edits invalidate it.

These locks support multiple processes on one host. They are not distributed locks: don't deploy multi-host writers on the same project without replacing the job/catalog store. External editors do not honor these locks; snapshot comparisons prevent stale job overwrites, but an editor racing the final synchronous file read/write is outside the transaction boundary. Per-locale writes are atomic; a multi-locale job is replayable rather than one global filesystem transaction.

## Message format and validation

Simple messages are strings with `{placeholder}` expressions. Complex messages are single-element arrays with `declarations`, `selectors` and `match`. Batch output preserves the source shape, declarations, selectors and match keys. Manual library saves can introduce a valid target-specific variant shape.

Save validation rejects unknown placeholders/markup, undeclared selectors, invalid structures and unknown keys. Dropped placeholders generate warnings under the existing validator. Legacy multi-element variant arrays are readable but must be consolidated before batch translation/saving, because the compiler honors only the first element. Outputs preserve `$schema`, tab indentation, nesting and configured key sorting.

## Releasing

The existing `v*` tag workflow tests, publishes npm with trusted publishing and syncs the MCP Registry. Before the next release, select the new version and update `package.json`, `SERVER_VERSION`, `server.json` and the plugin manifest together. This migration changes the tool surface and Node requirement; do not publish it as an unnoticed patch.
