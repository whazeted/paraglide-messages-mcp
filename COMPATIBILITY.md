# Compatibility

Which project setups paraglide-messages-mcp works with, and what to expect.

## TL;DR

| Your setup | Works? | Notes |
| --- | --- | --- |
| Paraglide JS default (`messages/{locale}.json`, message format plugin) | ✅ | Direct file access; local inspection/saves work offline. Translation jobs use OpenAI. |
| inlang message format with a custom `pathPattern` (single file per locale) | ✅ | Same path, any location, e.g. `./src/i18n/{locale}.json`. |
| Message format plus `@inlang/plugin-m-function-matcher` | ✅ | Supported as a companion matcher; it does not change message file storage. |
| inlang message format with multiple files per locale (`pathPattern` array) | ❌ | Requires the inlang SDK, which this server no longer ships. |
| i18next / next-intl / ICU MessageFormat plugins | ❌ | Same — these go through the inlang SDK. |
| gettext / `.po` files, XLIFF | ❌ | No inlang plugin exists for these formats either. |

## What the server requires

paraglide-messages-mcp reads and writes the inlang **message format** JSON files
directly. The project's `project.inlang/settings.json` must declare:

- `baseLocale` (string) and `locales` (array of strings)
- `plugin.inlang.messageFormat` with a **single string** `pathPattern`
  containing `{locale}` (e.g. `"./messages/{locale}.json"`)
- no unsupported import/export plugin module in `modules`
  (`@inlang/plugin-m-function-matcher` and lint-rule modules are fine)

Any other configuration is rejected at the first tool call with a clear
error. This is the standard Paraglide JS setup, so most projects qualify
as-is.

## Why direct file access only

Earlier versions fell back to the inlang SDK for other plugins (i18next,
next-intl, ICU) and multi-file `pathPattern` arrays. That fallback was
dropped deliberately:

- **Scoped writes.** Direct access reads only the locales a call needs and
  writes only the target locale's file. Batch collection validates against
  the current snapshot and preserves concurrent edits. The SDK path rewrote
  every locale file on each save.
- **Speed.** Tool calls take single-digit milliseconds regardless of project
  size; the SDK's load/save cycle grew into seconds on large projects.
- **Footprint.** Dropping `@inlang/sdk` removes the sqlite-wasm runtime and
  the bulk of the dependency tree, which makes `npx paraglide-messages-mcp` start
  fast. Inspection and manual saves work offline; translation uses OpenAI.

What you keep either way:

- **Minimal writes.** Saving translations rewrites only the target locale's
  file. Other locale files are untouched byte for byte, so file watchers
  (like `paraglide dev`) don't re-trigger for locales that didn't change.
- **Identical output.** The written files match the message-format plugin's
  own export exactly — `$schema` header, tab indentation, and the plugin's
  optional `sort` setting are all honored. Your diffs look the same as if
  the inlang toolchain had written them.

If you need i18next/next-intl/ICU or multi-file namespaces, use the last
release that still shipped the SDK fallback, or file an issue.

## Other requirements

- Node.js >= 22.12
- `OPENAI_API_KEY` and access to the configured model for translation jobs
- The base locale's messages are the translation source, so it should be
  reasonably complete — messages with an empty base value are skipped by
  `start_translation_job`.
