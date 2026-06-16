---
name: paraglide-translation
description: Use when the user wants to manage Paraglide JS / inlang messages or translations: translate missing or existing messages, add or remove locales, inspect/search message keys, rename/delete messages, remove orphan messages, or review i18n state.
---

# Paraglide messages

Use the `paraglide` MCP server for Paraglide JS / inlang message and translation work.

- Prefer the server's prompts when the user asks for translation, multi-locale translation, retranslation, review, or cleanup workflows.
- Use the server's tools and resources to inspect, validate, and write message changes.
- Do not edit `messages/*.json` or `project.inlang/` files directly when the MCP server is available; let the server validate and persist changes.
- If the server is not available, tell the user that this skill expects the `paraglide` MCP server and ask them to connect it.

## Fanning out one subagent per locale

Translating many locales in parallel is the server's intended use, but spawn the subagents carefully — a botched fan-out wastes far more than it saves.

- **Restrict each subagent's tools to ToolSearch + the `paraglide` tools.** With no `Bash`/`Write`/`Edit` available, a subagent that hits a problem can only retry or stop — it cannot silently fall back to hand-editing message files (which skips validation and corrupts them).
- **Make each subagent confirm its tools loaded before translating.** A freshly spawned subagent may race the MCP server's registration: an exact-name `select:` ToolSearch can return empty if it fires before the server is registered in that subagent's context. Instruct the subagent: if ToolSearch returns nothing, retry it (or use a keyword query, which waits for connecting servers); if the `paraglide` tools still don't resolve, STOP and report — never improvise with shell or file edits.
- **Verify with `project_info`, don't trust subagent self-reports.** A subagent can report success while having saved nothing. After the fan-out, call `project_info` and re-dispatch a subagent for any locale whose `missing` count is non-zero. Loop until every locale is actually at zero.
- Prefer the `translate_project` prompt, which already encodes this fan-out-and-verify loop.
