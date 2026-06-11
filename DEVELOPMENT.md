# Development

Everything you need to work on paraglide-messages-mcp: architecture, message
format details, validation rules, and the build/test/release workflow.

## Setup and scripts

```sh
pnpm install
pnpm test             # unit + integration tests (no build needed)
pnpm test:e2e         # builds, then drives the real CLI over stdio MCP
pnpm test:all         # everything
pnpm bench            # standard benchmark (small/large project)
pnpm bench:subagents  # XL benchmark: parallel per-locale agents, full runs
pnpm typecheck
pnpm build
```

Integration and e2e tests run against real inlang project fixtures on disk —
no mocks. Benchmarks are excluded from `pnpm test`; their results are
documented in [PERFORMANCE.md](PERFORMANCE.md).

## Architecture

```
src/
  cli.ts               stdio entry point (project discovery, --project flag)
  server.ts            McpServer wiring
  index.ts             public API exports
  primitives/          the MCP surface
    tools.ts           10 tools (schemas + handlers)
    prompts.ts         4 workflow prompts (incl. translate_project fan-out)
    resources.ts       read-only resources with completion
  core/                translation domain logic
    service.ts         TranslationService — the operations behind the tools
    storage.ts         snapshot reads + key mutations over direct.ts
    direct.ts          message file I/O + stat-validated file cache
    queries.ts         pure read computations (info, keys, batches, search)
    save.ts            per-item save validation and summaries
    mutate.ts          delete/rename planning
    locales.ts         settings.json locale management
    format.ts          pattern parsing, placeholder/markup validation
    constants.ts       batch limits and pagination defaults
    types.ts           message value and result types
```

Principles, in dependency order:

1. **Message-format JSON only** ([direct.ts](src/core/direct.ts)). The
   server reads and writes `messages/{locale}.json` files directly;
   `parseDirectProject` rejects anything else with a clear error. Output is
   byte-compatible with the message-format plugin's export (`$schema` first,
   tab indentation, optional key sort).
2. **Scoped I/O for the translate loop.** `get_translation_batch` and
   `save_translations` load only the source and target locale; saves write
   only the target file. That is what makes one-agent-per-locale parallelism
   conflict-free.
3. **Stat-validated, write-through file cache** (direct.ts). Every read
   stats the file (mtime + size) and re-parses only on change; saves update
   the cache in place. Concurrent agents share one parsed copy of the base
   locale, and external edits are still always picked up. Cached message
   maps are shared across calls — treat them as immutable.
4. **Synchronous service** ([service.ts](src/core/service.ts)). All I/O is
   sync, so every tool call runs atomically on the event loop — concurrent
   per-locale agents can never observe or produce a half-applied operation.
5. **No state between calls.** Nothing except the stat-guarded cache is held
   across calls; the server can be killed and restarted at any point.

## Message values

Values use the inlang message format — exactly what's in
`messages/{locale}.json`:

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

Variant arrays with more than one element (found in some legacy or
hand-written files) are read in full — placeholders from every element
count — but can't be saved back as-is, because the message-format plugin and
the Paraglide compiler silently ignore everything after the first element.
The save error explains the fix: consolidate all variants into one element's
`match`.

## Validation

`save_translations` rejects, per item:

- placeholders that don't exist in the source message (typo guard — a
  `{nmae}` would otherwise silently become a new input variable),
- markup tags (`{#bold}`…) not present in the source,
- match conditions using undeclared selectors,
- structurally invalid values,
- unknown message keys (unless `allowNewKeys: true` is passed deliberately;
  with scoped reads, "known" means present in the base or target locale).

Dropped source placeholders produce warnings, not errors, since languages
legitimately drop variables in some variants.

The source-comparison checks can be bypassed per call with
`skipValidation: true` — for translations that deliberately diverge from the
source, e.g. when the target doesn't need a placeholder. Structural
validation and the unknown-key guard still apply.

## The translation loop

```
project_info  +  style brief (tone, formality, glossary)
└─ one (sub)agent per target locale, in parallel:
   ┌─> get_translation_batch { targetLocale: "de", batchSize: 50 }
   │   ... agent translates the items ...
   │   save_translations { targetLocale: "de", translations: [...] }
   └── repeat until done == true
```

Per-item validation is what makes large batches safe: a bad translation is
rejected individually while the rest of the batch is saved, and the agent
re-submits only the failures. Scope work to a catalog subsection with
`prefix` (e.g. `"checkout_"`). The `translate_project` prompt encodes the
full fan-out workflow including the style brief.

To *redo* existing translations (stale copy, changed terminology), the same
loop runs on `get_retranslation_batch`, which also returns keys that already
have a translation. Saving doesn't shrink that scope, so the loop pages by
cursor (`after: nextCursor` until `hasMore` is false) instead of checking
`done`; the `retranslate` prompt fans it out across every target locale by
default so no locale is left stale (see DECISIONS.md #14).

## Benchmarks

Two suites, both building real fixture projects in the OS temp directory:

- `pnpm bench` ([test/benchmark.test.ts](test/benchmark.test.ts)) — one-off
  reads and the single-locale translate loop at 250 and 2,000 messages.
- `pnpm bench:subagents`
  ([test/benchmark-subagents.test.ts](test/benchmark-subagents.test.ts)) —
  full, byte-verified translation runs of 10 locales over 5,000 messages,
  sequential vs. concurrent, at batch sizes 25 and 200, with and without
  simulated agent latency.

When changing storage or query code, run both and update
[PERFORMANCE.md](PERFORMANCE.md) if the numbers move.

## Releasing

Releases are automated: pushing a `v*` tag runs
[release.yml](.github/workflows/release.yml), which tests, publishes to npm
via [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC —
no token secrets), and syncs the version to the official
[MCP Registry](https://registry.modelcontextprotocol.io).

One-time setup before the first tagged release:

1. Publish the first version locally (`pnpm build && npm publish`) — npm only
   lets you configure a trusted publisher for a package that already exists.
2. On npmjs.com → package → Settings, add a GitHub Actions trusted publisher:
   org `WesHaze`, repository `paraglide-mcp`, workflow filename
   `release.yml`.
3. Set publishing access to "Require two-factor authentication and disallow
   tokens".

Then release with:

```sh
npm version patch   # bumps package.json, commits, tags
git push --follow-tags
```
