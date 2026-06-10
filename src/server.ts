import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TranslationService } from "./service.js";
import type { TranslationInput } from "./types.js";

export const SERVER_VERSION = "0.1.0";

const messageValueSchema = z.union([
	z.string(),
	z
		.array(
			z.object({
				declarations: z.array(z.string()).optional(),
				selectors: z.array(z.string()).optional(),
				match: z.record(z.string(), z.string()),
			})
		)
		.length(1),
]);

/**
 * Creates the MCP server. All tools operate on the inlang project at
 * `projectPath` and are designed for *small-batch* translation: agents pull a
 * handful of messages, translate them, save them, and repeat until
 * `remaining` is 0. Validation happens server-side on every save so mistakes
 * surface immediately instead of corrupting message files.
 */
export function createServer(projectPath: string): McpServer {
	const service = new TranslationService(projectPath);

	const server = new McpServer({
		name: "paraglide-mcp",
		version: SERVER_VERSION,
	});

	server.registerTool(
		"project_info",
		{
			title: "Project info",
			description:
				"Get the inlang/Paraglide project overview: locales, base locale, total message count, " +
				"and per-locale translated/missing counts. Call this first to plan translation work.",
			inputSchema: {},
		},
		async () => jsonResult(await service.projectInfo())
	);

	server.registerTool(
		"list_message_keys",
		{
			title: "List message keys",
			description:
				"List message keys, optionally filtered by key prefix (startsWith) and by translation " +
				"status in a specific locale. Returns keys only (no content) to keep responses small. " +
				"Paginate with `after` (cursor = last key of the previous page).",
			inputSchema: {
				prefix: z
					.string()
					.optional()
					.describe("only keys starting with this prefix, e.g. 'checkout_'"),
				locale: z
					.string()
					.optional()
					.describe("locale to evaluate `status` against"),
				status: z
					.enum(["all", "missing", "translated"])
					.optional()
					.describe("filter by translation status in `locale` (default: all)"),
				limit: z.number().int().min(1).max(500).optional(),
				after: z
					.string()
					.optional()
					.describe("pagination cursor: return keys after this key"),
			},
		},
		async (args) => jsonResult(await service.listKeys(args))
	);

	server.registerTool(
		"get_messages",
		{
			title: "Get messages",
			description:
				"Retrieve message content by exact keys or by key prefix, optionally restricted to " +
				"specific locales. Values use the inlang message format: plain strings with " +
				"{placeholder} expressions, or a single-element array with declarations/selectors/match " +
				"for multi-variant messages (plurals etc.).",
			inputSchema: {
				keys: z
					.array(z.string())
					.optional()
					.describe("exact message keys to fetch"),
				prefix: z
					.string()
					.optional()
					.describe("alternatively, fetch all keys starting with this prefix"),
				locales: z
					.array(z.string())
					.optional()
					.describe("restrict to these locales (default: all project locales)"),
				limit: z.number().int().min(1).max(200).optional(),
			},
		},
		async (args) => jsonResult(await service.getMessages(args))
	);

	server.registerTool(
		"get_translation_batch",
		{
			title: "Get translation batch",
			description:
				"Get the next small batch of untranslated messages for a target locale (optionally " +
				"limited to a key prefix). Returns the source text, required placeholders, and the " +
				"number of remaining untranslated messages. Workflow: call this, translate the items, " +
				"save them with save_translations, then call this again until `done` is true. Keep " +
				"batches small (default 5) — accuracy beats batch size.",
			inputSchema: {
				targetLocale: z.string().describe("locale to translate into"),
				sourceLocale: z
					.string()
					.optional()
					.describe("locale to translate from (default: project base locale)"),
				prefix: z
					.string()
					.optional()
					.describe("only consider keys starting with this prefix"),
				batchSize: z
					.number()
					.int()
					.min(1)
					.max(25)
					.optional()
					.describe("messages per batch (default 5)"),
			},
		},
		async (args) => jsonResult(await service.getTranslationBatch(args))
	);

	server.registerTool(
		"save_translations",
		{
			title: "Save translations",
			description:
				"Save translated messages for one target locale and write them to the project's " +
				"message files. Each value must be a string (simple message) or a single-element " +
				"variant array (complex message) in the inlang message format. Placeholders are " +
				"validated against the source message; items with errors are rejected individually " +
				"while valid items are still saved. Returns per-item results plus the number of " +
				"messages still missing for the locale.",
			inputSchema: {
				targetLocale: z.string().describe("locale the translations are for"),
				translations: z
					.array(
						z.object({
							key: z.string().describe("message key"),
							value: messageValueSchema.describe(
								"translated value: string like 'Hallo {name}' or " +
									'[{"declarations": [...], "selectors": [...], "match": {"count=one": "...", "count=other": "..."}}]'
							),
						})
					)
					.min(1)
					.max(25)
					.describe("translations to save (max 25 per call — keep batches small)"),
				allowNewKeys: z
					.boolean()
					.optional()
					.describe(
						"allow creating keys that don't exist yet (default false; protects against typos)"
					),
			},
		},
		async (args) =>
			jsonResult(
				await service.saveTranslations({
					targetLocale: args.targetLocale,
					// zod validates the single-element variant array shape at runtime
					translations: args.translations as TranslationInput[],
					allowNewKeys: args.allowNewKeys,
				})
			)
	);

	return server;
}

function jsonResult(data: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(data, null, 2),
			},
		],
	};
}
