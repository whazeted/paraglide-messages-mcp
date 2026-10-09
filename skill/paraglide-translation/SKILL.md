---
name: paraglide-translation
description: Translate or inspect Paraglide JS / inlang message-format projects using durable OpenAI Batch jobs through the paraglide MCP server.
---

# Paraglide translations

Use the `paraglide` MCP server to inspect and translate messages.

1. Read `project_info` to determine the source locale, targets and missing counts.
2. Submit `start_translation_job` with a stable caller-generated `jobId`, selected `targetLocales`, optional `prefix` and `translationStyle`. Omitted targets mean all non-source locales. Use `mode: all` to refresh existing copy. OpenAI performs paid asynchronous translation; no translating subagents are needed.
3. Keep the job ID. Reuse it on retries; different options require a new ID. A tool call returns promptly and the remote job can take up to 24 hours.
4. Call `get_translation_job` periodically to reconcile and collect. After a disconnect/restart, find jobs with `list_translation_jobs`. Completion requires no `lastError`, acceptable `failed` counts and `cleanedUp: true`; remote status alone is insufficient.
5. Inspect item failures and conflicts. Fix selected existing messages with `save_translations` or submit new scoped work. Preserve flat keys, placeholders and variants. Do not overwrite concurrent user edits or bypass validation by hand-editing locale files.

Use `cancel_translation_job` to stop outstanding work, then keep collecting until terminal and cleaned up; cancellation can take ten minutes and successful partial results are retained. An uncertain create response stays pending for reconciliation: never submit a replacement paid batch merely because a tool call failed.

For unattended collection, the user can schedule `paraglide-messages-mcp --project <path> --resume`; it makes one reconciliation pass and exits. Do not create a schedule unless the user requests one.

If the server is unavailable, explain that this skill requires the `paraglide` MCP connection. The server defaults to `gpt-6-luna` with low reasoning; the API key and optional model override belong in server configuration.
