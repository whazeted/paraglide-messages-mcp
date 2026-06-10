# paraglide-mcp

An MCP (Model Context Protocol) server for translating [Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs) / [inlang](https://inlang.com) projects.

The agent calling the tools **is** the translator. The server's job is to make
that safe and efficient: it serves messages in small batches, validates every
translation against the source (placeholders, markup, variant structure)
before anything is written, and reports progress so the agent knows exactly
when a locale is done. Faulty items are rejected individually — one bad
translation never blocks or corrupts the rest of the batch.

## Quick start

No installation needed — run it via `npx` from your MCP client configuration.
Add this to your project's `.mcp.json` (Claude Code) or
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "paraglide": {
      "command": "npx",
      "args": ["-y", "paraglide-mcp", "--project", "./project.inlang"]
    }
  }
}
```

`--project` is optional: by default the server looks for `project.inlang` in
the working directory, then for a single `*.inlang` directory up to one level
deep.

The server is stateless — it loads your inlang project from disk per tool
call and writes changes straight back through your project's own inlang
plugin (e.g. `@inlang/plugin-message-format`), so `messages/{locale}.json`
files always stay in the exact format the rest of your toolchain expects.
External edits (your editor, the Paraglide compiler, git) are always picked
up. If the configured plugin can't be fetched (offline, no cache), a bundled
copy of the message-format plugin is used as a fallback.

## Tools

| Tool | Purpose |
| --- | --- |
| `project_info` | Locales, base locale, and per-locale translated/missing counts. |
| `list_message_keys` | Keys only (cheap), filterable by key prefix (`startsWith`) and per-locale status (`missing` / `translated`), with cursor pagination. |
| `get_messages` | Full message content by exact keys or prefix, optionally restricted to specific locales. |
| `get_translation_batch` | The next *N* untranslated messages for a target locale (default 5, max 25), with source text, required placeholders, and a `remaining` counter. |
| `save_translations` | Validate and persist translations for one locale (max 25 per call). Per-item results; valid items are saved even when others fail. |

## Prompts

The server also exposes the common workflows as MCP prompts, so clients that
support prompts (e.g. `/mcp__paraglide__translate_locale` in Claude Code) can
launch them directly without the bundled skill:

| Prompt | Arguments | Purpose |
| --- | --- | --- |
| `translate_locale` | `targetLocale`, `sourceLocale?` | Translate all missing messages into one locale via the batch loop. |
| `translate_prefix` | `prefix`, `targetLocale`, `sourceLocale?` | Same loop, scoped to keys starting with `prefix`. |
| `review_locale` | `locale`, `prefix?` | Review existing translations against the base locale and fix problems. |

Locale and prefix arguments support MCP completion: locales are suggested from
the project settings, prefixes from the actual message keys.

## Resources

Read-only project state is also exposed as MCP resources, so clients can pin
it as context (e.g. `@`-mention in Claude Code) without spending tool calls:

| Resource | Purpose |
| --- | --- |
| `paraglide://project/info` | Project overview — same payload as the `project_info` tool. |
| `paraglide://locales/{locale}/missing` | All keys missing or empty in `{locale}`. One resource per project locale appears in the resource list. |
| `paraglide://messages/{locale}/{key}` | The value of one message in one locale (`value` is `null` when untranslated). |

All resources return JSON. The `{locale}` and `{key}` template variables
support MCP completion, like the prompt arguments.

### The translation loop

Agents translate iteratively — small batches keep the error rate low while
the loop keeps throughput high (no re-reading of the full catalog between
steps, and `remaining` tells the agent exactly when to stop):

```
project_info
└─ for each target locale:
   ┌─> get_translation_batch { targetLocale: "de", batchSize: 5 }
   │   ... agent translates the 5 items ...
   │   save_translations { targetLocale: "de", translations: [...] }
   └── repeat until done == true
```

Scope work to a subsection of the catalog with `prefix`, e.g. only
`checkout_*` messages:

```json
{ "targetLocale": "de", "prefix": "checkout_", "batchSize": 5 }
```

### Message values

Values use the inlang message format — exactly what's in your
`messages/{locale}.json` files:

```jsonc
// simple message
"Hello {name}!"

// multi-variant message (plurals, gender, ...)
[{
  "declarations": ["input count", "local countPlural = count: plural"],
  "selectors": ["countPlural"],
  "match": {
    "countPlural=one": "You have {count} message",
    "countPlural=other": "You have {count} messages"
  }
}]
```

Translations may change shape when the target language requires it (e.g. a
string becomes a plural variant set for Czech) as long as introduced
selectors are declared.

### Validation

`save_translations` rejects, per item:

- placeholders that don't exist in the source message (typo guard — a
  `{nmae}` would otherwise silently become a new input variable),
- markup tags (`{#bold}`…) not present in the source,
- match conditions using undeclared selectors,
- structurally invalid values,
- unknown message keys (unless `allowNewKeys: true` is passed deliberately).

Dropped source placeholders produce warnings, not errors, since languages
legitimately drop variables in some variants.

## Agent skill

`skill/paraglide-translation/` contains an installable skill that teaches an
agent the batch workflow, plural-rule handling, and error recovery. For
Claude Code, copy it into your project or user skills directory:

```sh
cp -r node_modules/paraglide-mcp/skill/paraglide-translation .claude/skills/
# or globally: cp -r ... ~/.claude/skills/
```

## Development

```sh
pnpm install
pnpm test        # unit + integration tests (no build needed)
pnpm test:e2e    # builds, then drives the real CLI over stdio MCP
pnpm test:all    # everything
pnpm build
```

Integration and e2e tests run against a real inlang project fixture on disk
using the actual `@inlang/sdk` — no mocks.

## Requirements

- Node.js >= 20
- An inlang project (Paraglide JS default setup works out of the box)
