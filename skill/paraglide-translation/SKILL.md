---
name: paraglide-translation
description: Translate Paraglide JS / inlang messages via the paraglide MCP server in small, validated batches. Use when the user asks to translate app messages, fill in missing translations, add a new locale's content, or review/update i18n message files in a project using Paraglide JS or inlang.
---

# Translating Paraglide / inlang messages

You are the translator. The `paraglide` MCP server gives you the messages and
validates + writes your translations. Work locale by locale in batches — the
server validates every item individually, so a bad translation in a batch is
rejected on its own instead of sinking the call.

## Workflow (single locale)

1. **`project_info`** — learn the base locale, target locales, and how many
   messages are missing per locale. Confirm with the user which locale(s) and
   (optionally) which key prefix to work on if not already specified, along
   with any style preferences (tone, formality, terminology).
2. Loop until `done` is true:
   a. **`get_translation_batch`** with `targetLocale` (and `prefix` if
      scoping). Omit `batchSize` to use the default (defined in
      `src/core/constants.ts`); raise it for short UI strings — fewer
      round-trips — or lower it for long, nuanced prose so each item gets
      full attention.
   b. Translate each item's `source` into the target locale.
   c. **`save_translations`** with the same keys. The server validates each
      item; check `results` for per-item errors, fix only the failed items,
      and re-save them before moving on.
3. When `remaining` is 0, report a short summary (how many messages, which
   locales). Suggest the user runs their Paraglide compile step (usually part
   of `dev`/`build`) if they want to see the result in the app.

## Translating many locales: one subagent per locale

Each locale lives in its own message file, and `get_translation_batch` /
`save_translations` only read and write the source and target locale — so
per-locale agents cannot interfere with each other. When more than one locale
needs translation, fan out instead of going locale after locale:

1. **Settle the style brief first** (main agent, before delegating). Sample
   representative messages with `get_messages`, then write a short brief:
   tone and voice; formality/address per target language where the language
   forces a choice (German *Sie*/*du*, Dutch *u*/*je*, formal vs. plain
   Japanese, …); a glossary of recurring product terms (and which stay
   untranslated, e.g. brand names); and the non-negotiables (preserve
   `{placeholder}` names and markup exactly, adapt plural match cases per
   language). Ask the user when unclear, otherwise decide and state the brief
   in your summary.
2. **Spawn one subagent per target locale, in parallel.** Each subagent gets
   the style brief verbatim, its single locale, and the single-locale
   workflow above. A subagent translates only its own locale — never others.
3. **Verify and report** (main agent, after all subagents finish): call
   `project_info` and confirm `missing` is 0 for every target; re-dispatch a
   subagent for any locale with leftovers. Summarize the brief, per-locale
   counts, and anything subagents flagged as ambiguous.

## Retranslating existing messages

When the user wants to *redo* translations that already exist — the source
copy changed, terminology was updated, or entries have gone stale — the
normal loop won't surface them (`get_translation_batch` only returns
*missing* messages). Use **`get_retranslation_batch`** instead: it covers
every key with a non-empty source, including already-translated ones, and
`save_translations` overwrites the old values.

Two things differ from the normal loop:

- **Scope it deliberately.** Prefer a key `prefix` (e.g. the feature whose
  copy changed); an unscoped retranslate redoes the entire project. Default
  to **all target locales** — retranslating only one locale leaves the
  others stale, which defeats the point. Fan out one subagent per locale
  exactly as above, sharing one style brief.
- **Loop by cursor, not by `done`.** Saving doesn't shrink the scope (a
  retranslated key stays in it), so page instead: call
  `get_retranslation_batch`, translate, save, then call again with
  `after: nextCursor` until `hasMore` is false. Each item's
  `existingTarget` shows the current value — when it already fits the
  brief you may keep it by simply skipping the item; the cursor moves on
  regardless.

State why the retranslation is happening (new terminology, reworded
source, …) in the style brief so every locale applies the same change.

The server also exposes read-only resources mirroring the read tools —
`paraglide://project/info`, `paraglide://locales/{locale}/missing`, and
`paraglide://messages/{locale}/{key}` — handy when the user has pinned one as
context or when you only need to inspect state, not change it.

## Translation rules

- Preserve every `{placeholder}` exactly as written — same name, same braces.
  Never translate, rename, or drop placeholder names.
- Preserve markup tags like `{#bold}`/`{/bold}` and their nesting.
- Simple messages are plain strings: `"Hello {name}!"` → `"Hallo {name}!"`.
- Variant messages are a single-element array:

  ```json
  [{
    "declarations": ["input count", "local countPlural = count: plural"],
    "selectors": ["countPlural"],
    "match": {
      "countPlural=one": "You have {count} message",
      "countPlural=other": "You have {count} messages"
    }
  }]
  ```

  Translate only the pattern strings in `match`. Keep `declarations` and
  `selectors` as-is, but **add or remove match cases to fit the target
  language's plural rules** (e.g. add `countPlural=few`/`countPlural=many`
  for Slavic languages, collapse to one case where the language doesn't
  inflect).
- If a target language needs variants where the source is a simple string
  (or vice versa), you may change the shape — declare any selector you
  introduce in `declarations`.
- Legacy or hand-written files may contain variant arrays with *multiple*
  elements. The Paraglide toolchain only reads the first element, so when
  fixing such a message, consolidate it: merge every element's `match`
  entries (and `declarations`/`selectors`) into one single-element array.
  The server rejects multi-element saves with a hint saying exactly this.
- Settle on a style before translating — tone, formality level (e.g. formal
  vs. informal address), and key terminology. Ask the user for preferences
  when unclear, otherwise define one yourself and state it in your summary.
- For UI strings, prefer the conventional terms of the platform/language
  over literal translations, and keep them roughly as short as the source.
- When a source string is ambiguous (e.g. "Open" — verb or adjective?), use
  the message key and sibling keys (`get_messages` with a `prefix`) for
  context. If still ambiguous, make the safest choice and mention it in your
  summary instead of stalling.
- When the user refers to a message by its UI text rather than its key
  ("the string that says 'Add to cart'"), find it with `search_messages` —
  it matches message text and key substrings, case-insensitively.
- To remove or rename messages, use `delete_messages` / `rename_message` —
  they update every locale at once. After a rename, remind the user to
  update code references to the old key.
- To add or drop a whole locale, use `add_locale` / `remove_locale`. Match
  the tag convention the project already uses (check `project_info` —
  e.g. `es` vs `es-ES`). `remove_locale` permanently discards that locale's
  translations, so confirm with the user first.
- When a translation must deliberately diverge from the source — e.g. the
  target language doesn't need a placeholder — pass `skipValidation: true`
  to `save_translations` for that call. Use it sparingly: it turns off the
  placeholder/markup/variant checks that normally catch typos.
- Never edit `messages/*.json` or `project.inlang/` files directly while the
  MCP server is in use — always go through the tools so validation applies.
