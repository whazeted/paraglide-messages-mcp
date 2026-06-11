import {
	type McpServer,
	ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { COMPLETION_SUGGESTION_LIMIT, DEFAULT_LIST_KEYS_PAGE_SIZE } from "../core/constants.js";
import type { TranslationService } from "../core/service.js";

/**
 * Registers the read-only resources. They mirror what the read tools return,
 * but as addressable URIs, so clients can pin them as context (e.g. `@`-mention
 * in Claude Code) without spending tool calls:
 *
 *   paraglide://project/info             — project overview
 *   paraglide://locales/{locale}/missing — keys still missing for a locale
 *   paraglide://messages/{locale}/{key}  — one message value
 */
export function registerResources(
	server: McpServer,
	service: TranslationService
): void {
	const completeLocale = async (value: string) => {
		try {
			const info = await service.projectInfo();
			return info.locales.filter((locale) => locale.startsWith(value));
		} catch {
			return [];
		}
	};

	const completeKey = async (value: string) => {
		try {
			const { keys } = await service.listKeys({
				prefix: value || undefined,
				limit: COMPLETION_SUGGESTION_LIMIT,
			});
			return keys;
		} catch {
			return [];
		}
	};

	server.registerResource(
		"project-info",
		"paraglide://project/info",
		{
			title: "Project info",
			description:
				"Project overview: locales, base locale, total message count, and " +
				"per-locale translated/missing counts.",
			mimeType: "application/json",
		},
		async (uri) => jsonContents(uri.href, await service.projectInfo())
	);

	server.registerResource(
		"missing-keys",
		new ResourceTemplate("paraglide://locales/{locale}/missing", {
			// one listed resource per project locale; degrades to an empty list
			// when the project isn't readable (same as argument completion)
			list: async () => {
				try {
					const info = await service.projectInfo();
					return {
						resources: info.locales.map((locale) => ({
							uri: `paraglide://locales/${locale}/missing`,
							name: `Missing keys: ${locale}`,
							mimeType: "application/json",
						})),
					};
				} catch {
					return { resources: [] };
				}
			},
			complete: { locale: completeLocale },
		}),
		{
			title: "Missing keys for a locale",
			description:
				"All message keys that are missing or empty in the given locale.",
			mimeType: "application/json",
		},
		async (uri, variables) => {
			const locale = String(variables.locale);
			const keys: string[] = [];
			let after: string | undefined;
			for (;;) {
				const page = await service.listKeys({
					locale,
					status: "missing",
					limit: DEFAULT_LIST_KEYS_PAGE_SIZE,
					after,
				});
				keys.push(...page.keys);
				if (!page.hasMore) break;
				after = page.nextCursor;
			}
			return jsonContents(uri.href, { locale, missing: keys.length, keys });
		}
	);

	server.registerResource(
		"message",
		new ResourceTemplate("paraglide://messages/{locale}/{key}", {
			// no list callback: one resource per locale×key would flood clients
			list: undefined,
			complete: { locale: completeLocale, key: completeKey },
		}),
		{
			title: "Message value",
			description:
				"The value of one message key in one locale, in the inlang message " +
				"format (string or variant array). `value` is null when untranslated.",
			mimeType: "application/json",
		},
		async (uri, variables) => {
			const locale = String(variables.locale);
			const key = String(variables.key);
			const { messages } = await service.getMessages({
				keys: [key],
				locales: [locale],
			});
			const translations = messages[0]?.translations ?? {};
			if (!(locale in translations)) {
				throw new Error(`unknown message key "${key}"`);
			}
			return jsonContents(uri.href, {
				key,
				locale,
				value: translations[locale],
			});
		}
	);
}

function jsonContents(uri: string, data: unknown) {
	return {
		contents: [
			{
				uri,
				mimeType: "application/json",
				text: JSON.stringify(data, null, 2),
			},
		],
	};
}
