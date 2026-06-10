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
agent the batch workflow, plural-rule handling, and error recovery. It uses
the open [Agent Skills](https://agentskills.io) format, so it works with any
agent that supports `SKILL.md` (Claude Code, Codex, Cursor, Copilot, Gemini
CLI, ...).

**Claude Code** — install the plugin, which bundles both the MCP server and
the skill (no `.mcp.json` needed):

```
/plugin marketplace add WesHaze/paraglide-mcp
/plugin install paraglide-translation@paraglide-mcp
```

**Any other agent** — install the skill with the [skills CLI](https://github.com/vercel-labs/skills)
(it picks the right directory for your agent), then configure the MCP server
as shown in Quick start:

```sh
npx skills add WesHaze/paraglide-mcp
```

Or copy it manually:

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

### Releasing

Releases are automated: pushing a `v*` tag runs
[release.yml](.github/workflows/release.yml), which tests, publishes to npm
via [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC —
no token secrets), and syncs the version to the official
[MCP Registry](https://registry.modelcontextprotocol.io).

One-time setup before the first tagged release:

1. Publish the first version locally (`pnpm build && npm publish`) — npm only
   lets you configure a trusted publisher for a package that already exists.
2. On npmjs.com → package → Settings, add a GitHub Actions trusted publisher:
   org `WesHaze`, repository `paraglide-mcp`, workflow filename `release.yml`.
3. Set publishing access to "Require two-factor authentication and disallow
   tokens".

Then release with:

```sh
npm version patch   # bumps package.json, commits, tags
git push --follow-tags
```

## Requirements

- Node.js >= 20
- An inlang project (Paraglide JS default setup works out of the box)
