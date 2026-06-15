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
      "args": [
        "-y",
        "paraglide-messages-mcp",
        "--project",
        "./project.inlang",
        "--translation-style",
        "Concise product UI; informal address; keep brand terms untranslated."
      ]
    }
  }
}
```

`--project` is optional: the server finds `project.inlang` in the working
directory (or a single `*.inlang` directory up to one level deep) by itself.
`--translation-style` is optional but recommended: it gives agents the
linguistic brief to use for tone, formality, and terminology instead of
deriving style from existing translations.

Then ask your agent to translate — or use the `translate_project` prompt to
translate every locale at once with one subagent per locale.

## Tools

| Tool | Purpose |
| --- | --- |
| `project_info` | Locales, base locale, `totalKeys` across all locales, `translatableKeys` from non-empty base messages, per-locale translated/missing counts, extra non-source keys, and the startup translation style brief when configured. |
| `get_translation_batch` | Next batch of untranslated messages for a locale (default 50), with source text and required placeholders. Optionally autosaves the previous batch in the same call (pass `translations`), so the loop is one round-trip per batch and the final batch is saved by the call that reports `done`. |
| `get_retranslation_batch` | Cursor-paged batch over *already-translated* messages too — refresh stale entries after source/terminology changes. Same optional autosave as `get_translation_batch`. |
| `save_translations` | Validate and persist translations for one locale; per-item results — overwrites existing values. (The batch tools share this save core for their autosave.) |
| `list_message_keys` | Keys only, filterable by prefix and status, paginated. |
| `get_messages` | Full message content by keys or prefix. |
| `search_messages` | Find messages by text or key substring. |
| `delete_messages` / `rename_message` | Key management across all locales. |
| `remove_orphan_messages` | Delete target-locale keys that are absent from the source locale (base locale by default), optionally scoped by locale or prefix. |
| `add_locale` / `remove_locale` | Locale management in `settings.json`. |

## Prompts

| Prompt | Purpose |
| --- | --- |
| `translate_project` | Translate every locale: the main agent uses the startup translation style brief (or asks the user for one), then fans out one subagent per locale in parallel. |
| `translate_locale` | Translate one locale via the batch loop. |
| `translate_prefix` | Same, scoped to keys starting with a prefix. |
| `retranslate` | Redo existing translations (stale copy, changed terminology) — by key prefix, every target locale by default, one subagent per locale. |
| `review_locale` | Review existing translations against the base locale and fix problems. |

Read-only state is also exposed as MCP resources
(`paraglide://project/info`, `paraglide://locales/{locale}/missing`,
`paraglide://messages/{locale}/{key}`), so clients can pin it as context
without spending tool calls.

## Agent skill

`skill/paraglide-translation/` is an optional installable skill in the open
[Agent Skills](https://agentskills.io) format. The skill simply points the agent to the MCP server.

```sh
# Codex, via the skills CLI
npx skills add whazeted/paraglide-messages-mcp --skill paraglide-translation -a codex

# Or install from the skill folder URL directly
npx skills add https://github.com/whazeted/paraglide-messages-mcp/tree/main/skill/paraglide-translation -a codex
```

For other skills-compatible agents, replace `codex` with that agent's
`skills` CLI target name. You can list the skill before installing:

```sh
npx skills add whazeted/paraglide-messages-mcp --list
```

## Compatibility

Requires the standard Paraglide JS setup: the inlang **message format**
plugin with a single message file per locale (any `pathPattern` location).
Other inlang plugins (i18next, next-intl, ICU) and multi-file namespaces are
deliberately not supported — see [COMPATIBILITY.md](COMPATIBILITY.md) for
the exact criteria and reasoning.

## Performance

A full 10-locale translation run over a 5,000-message project costs ~3 s of
server time (M1 Max Mac Studio)— the pipeline is bounded by the agent's translation speed, not
the server.

## Documentation
- [DEVELOPMENT.md](DEVELOPMENT.md) — architecture, message format details,
  validation rules, building, testing, benchmarking, releasing
- [COMPATIBILITY.md](COMPATIBILITY.md) — supported project setups

## License

[MIT](LICENSE)
