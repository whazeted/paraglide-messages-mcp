---
name: paraglide-translation
description: Translate Paraglide JS / inlang messages via the paraglide MCP server in small, validated batches. Use when the user asks to translate app messages, fill in missing translations, add a new locale's content, or review/update i18n message files in a project using Paraglide JS or inlang.
---

# Translating Paraglide / inlang messages

You are the translator. The `paraglide` MCP server gives you the messages and
validates + writes your translations. Work in small batches — never try to
translate everything in one call.

## Workflow

1. **`project_info`** — learn the base locale, target locales, and how many
   messages are missing per locale. Confirm with the user which locale(s) and
   (optionally) which key prefix to work on if not already specified.
2. Loop until `done` is true:
   a. **`get_translation_batch`** with `targetLocale` (and `prefix` if
      scoping). Keep the default `batchSize` of 5; use up to 10 only for very
      short UI strings (buttons, labels).
   b. Translate each item's `source` into the target locale.
   c. **`save_translations`** with the same keys. The server validates each
      item; check `results` for per-item errors, fix only the failed items,
      and re-save them before moving on.
3. When `remaining` is 0, report a short summary (how many messages, which
   locales). Suggest the user runs their Paraglide compile step (usually part
   of `dev`/`build`) if they want to see the result in the app.

## Translation rules

- Preserve every `{placeholder}` exactly as written — same name, same braces.
  Never translate, rename, or drop placeholder names. The server rejects
  invented placeholders and warns about dropped ones.
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
- Match the source's tone and formality. For UI strings, prefer the
  conventional terms of the platform/language over literal translations, and
  keep them roughly as short as the source.
- When a source string is ambiguous (e.g. "Open" — verb or adjective?), use
  the message key and sibling keys (`get_messages` with a `prefix`) for
  context. If still ambiguous, make the safest choice and mention it in your
  summary instead of stalling.

## Error handling

- A failed item in `save_translations` never blocks the others — valid items
  are saved. Re-save only the failed keys after fixing them.
- "unknown message key" means you mistyped the key; copy keys verbatim from
  `get_translation_batch`. Do not set `allowNewKeys` unless the user
  explicitly asked to create new messages.
- Never edit `messages/*.json` or `project.inlang/` files directly while the
  MCP server is in use — always go through the tools so validation applies.
