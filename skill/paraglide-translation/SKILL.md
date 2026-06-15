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
