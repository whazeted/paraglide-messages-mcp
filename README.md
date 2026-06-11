# paraglide-messages-mcp

[![npm](https://img.shields.io/npm/v/paraglide-messages-mcp)](https://www.npmjs.com/package/paraglide-messages-mcp)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

An MCP server that turns AI agents into a parallel translation team for
[Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs) /
[inlang](https://inlang.com) `messages/{locale}.json` files.

The agent calling the tools **is** the translator. The server makes that
safe and fast:

- **Validated writes** — every translation is checked against the source
  (placeholders, markup, plural variants) before anything lands on disk;
  bad items are rejected individually, never the whole batch.
- **One agent per locale, in parallel** — the translate loop reads and
  writes only the source and target locale's files, so subagents can
  translate all locales concurrently without conflicts.
- **Fast and offline** — direct JSON file access with a stat-validated
  cache; tool calls cost milliseconds regardless of project size, and no
  network is ever needed.
- **Toolchain-invisible** — written files are byte-compatible with the
  message-format plugin's own output, and external edits (editor, compiler,
  git) are always picked up.

## Quick start

No installation — add this to your `.mcp.json` (Claude Code) or
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "paraglide": {
      "command": "npx",
      "args": ["-y", "paraglide-messages-mcp", "--project", "./project.inlang"]
    }
  }
}
```

`--project` is optional: the server finds `project.inlang` in the working
directory (or a single `*.inlang` directory up to one level deep) by itself.

Then ask your agent to translate — or use the `translate_project` prompt to
translate every locale at once with one subagent per locale.

## Tools

| Tool | Purpose |
| --- | --- |
| `project_info` | Locales, base locale, per-locale translated/missing counts. |
| `get_translation_batch` | Next batch of untranslated messages for a locale, with source text and required placeholders. Batches self-size: long prose yields fewer items per batch so each keeps the agent's full attention. |
| `save_translations` | Validate and persist translations for one locale; per-item results. |
| `list_message_keys` | Keys only, filterable by prefix and status, paginated. |
| `get_messages` | Full message content by keys or prefix. |
| `search_messages` | Find messages by text or key substring. |
| `delete_messages` / `rename_message` | Key management across all locales. |
| `add_locale` / `remove_locale` | Locale management in `settings.json`. |

## Prompts

| Prompt | Purpose |
| --- | --- |
| `translate_project` | Translate every locale: the main agent settles a style brief (tone, formality, glossary), then fans out one subagent per locale in parallel. |
| `translate_locale` | Translate one locale via the batch loop. |
| `translate_prefix` | Same, scoped to keys starting with a prefix. |
| `review_locale` | Review existing translations against the base locale and fix problems. |

Read-only state is also exposed as MCP resources
(`paraglide://project/info`, `paraglide://locales/{locale}/missing`,
`paraglide://messages/{locale}/{key}`), so clients can pin it as context
without spending tool calls.

## Agent skill

`skill/paraglide-translation/` is an installable skill in the open
[Agent Skills](https://agentskills.io) format that teaches any agent the
workflow, plural-rule handling, and error recovery.

```sh
# Claude Code (plugin bundles the MCP server + skill, no .mcp.json needed)
/plugin marketplace add WesHaze/paraglide-mcp
/plugin install paraglide-translation@paraglide-mcp

# any other agent, via the skills CLI
npx skills add WesHaze/paraglide-mcp
```

## Compatibility

Requires the standard Paraglide JS setup: the inlang **message format**
plugin with a single message file per locale (any `pathPattern` location).
Other inlang plugins (i18next, next-intl, ICU) and multi-file namespaces are
deliberately not supported — see [COMPATIBILITY.md](COMPATIBILITY.md) for
the exact criteria and reasoning.

## Performance

A full 10-locale translation run over a 5,000-message project costs ~3 s of
server time — the pipeline is bounded by the agent's translation speed, not
the server. Measurements and history in [PERFORMANCE.md](PERFORMANCE.md).

## Documentation

- [DEVELOPMENT.md](DEVELOPMENT.md) — architecture, message format details,
  validation rules, building, testing, benchmarking, releasing
- [DECISIONS.md](DECISIONS.md) — decision log: what was chosen and why
- [COMPATIBILITY.md](COMPATIBILITY.md) — supported project setups
- [PERFORMANCE.md](PERFORMANCE.md) — benchmarks and optimization history

## License

[MIT](LICENSE)

Not affiliated with or endorsed by [Opral](https://opral.com) / inlang —
[Paraglide JS](https://github.com/opral/paraglide-js) is their project. The
name refers to the message format this server supports.
