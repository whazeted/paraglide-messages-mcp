# Compatibility

Which project setups and translation file formats paraglide-mcp works with,
and what to expect from each.

## TL;DR

| Your setup | Works? | Notes |
| --- | --- | --- |
| Paraglide JS default (`messages/{locale}.json`, message format plugin) | ✅ | The primary target — fastest path, works offline. |
| inlang message format with a custom `pathPattern` (single file per locale) | ✅ | Same fast path, any location, e.g. `./src/i18n/{locale}.json`. |
| inlang message format with multiple files per locale (`pathPattern` array) | ✅ | Handled through the inlang SDK; slower on large projects. |
| i18next plugin | ✅ | Through the inlang SDK; requires network on first load. |
| next-intl plugin | ✅ | Through the inlang SDK; requires network on first load. |
| ICU MessageFormat v1 plugin | ✅ | Through the inlang SDK; requires network on first load. |
| gettext / `.po` files | ❌ | No inlang plugin exists for the current SDK. |
| XLIFF | ❌ | No inlang plugin exists for the current SDK. |

## How format support works

paraglide-mcp does not parse translation formats itself — and neither does
Paraglide JS. Both operate on an [inlang project](https://inlang.com)
(`project.inlang/settings.json`), and the project's configured
**import/export plugin** determines which file format your translations live
in. If an inlang plugin can read and write your format, paraglide-mcp can
translate it.

The currently available import/export plugins (see the
[inlang plugin catalog](https://inlang.com/c/plugins)) are all JSON-based:

- [inlang message format](https://inlang.com/m/reootnfj/plugin-inlang-messageFormat)
  — the Paraglide JS default
- i18next
- next-intl
- ICU MessageFormat v1
- Xcode String Catalogs

## The message format fast path

Projects using the **inlang message format plugin** with a single file per
locale — the standard Paraglide JS setup — get a fast path: the server reads
and writes your `messages/{locale}.json` files directly instead of going
through the inlang SDK's load/save cycle. What that means for you:

- **Speed.** Tool calls take single-digit milliseconds regardless of project
  size, instead of growing into seconds on large projects. A full
  translation run over 2,000 messages takes under 2 seconds of server
  overhead instead of ~21 minutes. Details and measurements in
  [PERFORMANCE.md](PERFORMANCE.md).
- **Minimal writes.** Saving translations rewrites only the target locale's
  file. Other locale files are untouched byte for byte, so file watchers
  (like `paraglide dev`) don't re-trigger for locales that didn't change.
- **Identical output.** The written files match the plugin's own export
  format exactly — `$schema` header, tab indentation, and the plugin's
  optional `sort` setting are all honored. Your diffs look the same as if
  the inlang SDK had written them.
- **Offline.** No plugin needs to be fetched from the CDN.

The fast path engages automatically when the project's
`plugin.inlang.messageFormat` settings declare a single string
`pathPattern`. Everything else — `pathPattern` arrays (one file per
namespace), i18next, next-intl, ICU — transparently uses the inlang SDK with
your project's own plugin, with identical behavior and validation, just
slower on large projects.

To force the SDK path (e.g. to rule out the fast path while debugging), set
the environment variable `PARAGLIDE_MCP_FORCE_SDK=1` in your MCP server
configuration.

## PO and XLIFF

Not supported, because no import/export plugin for these formats exists for
the current inlang SDK:

- **gettext / PO**: a community plugin
  ([jannesblobel/inlang-plugin-po](https://github.com/jannesblobel/inlang-plugin-po))
  exists but targets the legacy v1 plugin API and does not work with
  `@inlang/sdk` 2.x.
- **XLIFF**: mentioned in inlang's documentation as a goal of the plugin
  system, but no plugin has shipped.

If such a plugin ships in the future, paraglide-mcp's SDK path is the place
it would plug in — file an issue if you hit this.

## Other requirements

- Node.js >= 20
- The base locale's messages are the translation source, so it should be
  reasonably complete — messages with an empty base value are skipped by
  `get_translation_batch`.
- Plugins other than the message format plugin are fetched from inlang's CDN
  on first load and cached by the SDK afterwards. For message-format
  projects this never matters: a copy of the plugin is bundled with
  paraglide-mcp.
