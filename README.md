# paraglide-messages-mcp

Stateless MCP service for translating [Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs) / inlang message files through the [OpenAI Batch API](https://developers.openai.com/api/docs/guides/batch).

OpenAI does the translation asynchronously. The MCP client submits a job and later collects it; the client and server can disconnect or restart while OpenAI works. Each request includes flat message keys as usage context, source text, existing target text, placeholders, a style brief, and a small sample of existing target copy. The default is `gpt-6-luna` with `reasoning.effort: "low"` (“Luna light”).

Requires Node.js 22.12+ and an OpenAI API key with access to the configured Batch model. Inspecting projects and saving manual corrections work without a key.

## Connect

```json
{
  "mcpServers": {
    "paraglide": {
      "command": "npx",
      "args": [
        "-y", "paraglide-messages-mcp",
        "--project", "./project.inlang",
        "--translation-style", "Concise product UI; informal address; preserve brand terms."
      ],
      "env": { "OPENAI_API_KEY": "<your API key>" }
    }
  }
}
```

Use your client's secret/environment configuration to supply the key; don't commit credentials. `--project` is optional when there is a discoverable `.inlang` directory. `--model <id>` overrides the default. `--jobs-dir <path>` overrides the local job directory.

## Translate

1. Call `project_info` to inspect locales and missing counts.
2. Call `start_translation_job` with a stable `jobId`, for example:

   ```json
   { "jobId": "checkout-fr-2026-10-07", "targetLocales": ["fr"], "prefix": "checkout_" }
   ```

   Omit `targetLocales` for every locale except the source. The source defaults to the project base locale. Omit `prefix` for the whole catalog. Use `mode: "all"` to refresh existing translations. A per-job `translationStyle` overrides the startup brief.

3. Keep the returned ID and periodically call `get_translation_job`. Batch jobs have a 24-hour completion window; a tool call checks once instead of holding a connection open. Reuse the same ID after errors. `list_translation_jobs` discovers jobs after a restart without calling OpenAI.
4. On a terminal batch, collection archives output/error files, validates individual translations, and merges accepted values into the locale files. Check `saved`, `failed`, `lastError`, and `cleanedUp`; a remote `completed` status alone does not mean everything was saved. Failure details are capped at 50 in tool responses; the job record contains every outcome. Failed or conflicted messages can be corrected with `save_translations` or translated in a new scoped job.

An empty scope finishes locally without an API request. A reused ID with different options is rejected. Use a new ID for new work; retrying an existing ID resumes its original snapshot.

## Durability and cleanup

Job snapshots and IDs are atomically persisted in `project.inlang/.paraglide-batches/`. Keep this directory on persistent storage and exclude it from source control: it contains message text and archived model outputs. API keys are never stored in job records. Locks serialize job reconciliation and catalog writes across processes on the same host. Source or target edits made during the batch are preserved and reported as conflicts. Per-locale merges can be replayed after an interrupted collection.

Lost batch creation responses are reconciled through OpenAI batch metadata and the input file ID. An uncertain submission is never automatically repeated, which avoids duplicate paid batches. If reconciliation finds no matching batch, the job stays pending and reports `lastError`; inspect it in OpenAI before deciding to submit replacement work. OpenAI validates model availability asynchronously; unsupported models are reported through batch errors.

There is no “close completed batch” operation. Once results are safely archived and applied, the service deletes the remote input, output, and error files. Cleanup failures remain resumable. Both uploaded and generated files have a 30-day expiration as a fallback; collect before they expire. `cancel_translation_job` records cancellation before sending it to OpenAI. Cancellation can take up to 10 minutes; keep collecting until terminal and `cleanedUp: true`. Successful partial results from cancelled or expired batches are validated and applied too.

For unattended collection, run this command periodically through your own scheduler:

```sh
npx paraglide-messages-mcp --project ./project.inlang --resume
```

It reconciles every unfinished local job once, prints JSON summaries, and exits. No timers or workers remain attached to MCP sessions. It returns a nonzero exit code for collection errors or rejected translations.

## Tools

| Tool | Purpose |
| --- | --- |
| `project_info` | Locales, source, counts and startup style brief |
| `list_message_keys` | Flat keys filtered by prefix/status; cursor pagination |
| `get_messages` | Message values by key or prefix |
| `search_messages` | Search text and key substrings |
| `save_translations` | Validated corrections to existing keys |
| `start_translation_job` | Submit a durable OpenAI Batch job |
| `get_translation_job` | Reconcile, collect and clean up a job |
| `list_translation_jobs` | Local job summaries, cursor pagination |
| `cancel_translation_job` | Request cancellation, retaining partial results |

The old agent translation loops, workflow prompts, duplicate resources and destructive catalog/locale management tools have been removed from the MCP surface. Existing `TranslationService` library helpers remain available for callers that need them. MCP saves no longer expose validation bypasses or arbitrary new-key creation.

## Stateless HTTP

The CLI uses SDK v2 `serveStdio`; the library also exports a web-standard HTTP handler:

```ts
import { createHandler } from "paraglide-messages-mcp";
const handler = createHandler("/workspace/project.inlang", { translationStyle: "Concise UI" });
// Mount handler.fetch(Request) on your HTTP runtime; call handler.close() at shutdown.
```

The handler creates a fresh MCP server for each request and supports the `2026-07-28` protocol without initialization or session IDs. Legacy clients are served statelessly through SDK compatibility. Deployments must mount authentication and Host/Origin checks ahead of `fetch` as described in the [SDK HTTP guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/http). The filesystem store supports one host, or a persistent single-writer deployment; multi-host replicas need a shared transactional job/catalog store and distributed locking.

See [COMPATIBILITY.md](COMPATIBILITY.md) for supported message formats and [DEVELOPMENT.md](DEVELOPMENT.md) for architecture and tests. The optional [agent skill](skill/paraglide-translation/SKILL.md) teaches the batch workflow.

## License

[MIT](LICENSE)
