import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TranslationService } from "../core/service.js";
import type { TranslationInput } from "../core/types.js";

const variantSchema = z.object({
	declarations: z.array(z.string()).optional(),
	selectors: z.array(z.string()).optional(),
	match: z.record(z.string(), z.string()),
});

const messageValueSchema = z.union([
	z.string(),
	z.array(variantSchema).length(1),
]);

// Output values come from message files on disk, which may contain
// multi-variant arrays — don't enforce the single-element rule on the way out.
const messageValueOutputSchema = z.union([z.string(), z.array(variantSchema)]);

/**
 * Registers the translation tools. They are designed for *small-batch*
 * translation: agents pull a handful of messages, translate them, save them,
 * and repeat until `remaining` is 0. Validation happens server-side on every
 * save so mistakes surface immediately instead of corrupting message files.
 */
export function registerTools(
	server: McpServer,
	service: TranslationService
): void {
	server.registerTool(
		"project_info",
		{
			title: "Project info",
			description:
				"Get the inlang/Paraglide project overview: locales, base locale, total message count, " +
				"and per-locale translated/missing counts. Call this first to plan translation work.",
			inputSchema: {},
			outputSchema: {
				projectPath: z.string(),
				baseLocale: z.string(),
				locales: z.array(z.string()),
				pluginKey: z.string(),
				totalKeys: z.number().int(),
				translated: z
					.record(z.string(), z.number().int())
					.describe("per locale: keys with a non-empty message"),
				missing: z
					.record(z.string(), z.number().int())
					.describe("per locale: keys missing or empty"),
			},
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
			outputSchema: {
				keys: z.array(z.string()),
				total: z
					.number()
					.int()
					.describe("total matching keys before pagination"),
				hasMore: z.boolean(),
				nextCursor: z
					.string()
					.optional()
					.describe("pass as `after` to fetch the next page"),
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
			outputSchema: {
				messages: z.array(
					z.object({
						key: z.string(),
						translations: z
							.record(z.string(), messageValueOutputSchema.nullable())
							.describe("locale -> value; null when the locale has no value"),
					})
				),
				truncated: z
					.boolean()
					.describe("true when more keys matched than `limit` allowed"),
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
			outputSchema: {
				targetLocale: z.string(),
				sourceLocale: z.string(),
				items: z.array(
					z.object({
						key: z.string(),
						source: messageValueOutputSchema.describe(
							"value in the source locale"
						),
						existingTarget: messageValueOutputSchema
							.optional()
							.describe("existing value in the target locale, if any"),
						placeholders: z
							.array(z.string())
							.describe("placeholders that must be preserved"),
					})
				),
				remaining: z
					.number()
					.int()
					.describe("untranslated messages left for this locale/prefix"),
				done: z.boolean().describe("true when nothing is left to translate"),
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
			outputSchema: {
				results: z.array(
					z.object({
						key: z.string(),
						status: z.enum(["saved", "error"]),
						error: z.string().optional(),
						warnings: z.array(z.string()).optional(),
					})
				),
				saved: z.number().int(),
				failed: z.number().int(),
				remainingForLocale: z
					.number()
					.int()
					.describe("messages still missing for the target locale"),
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
}

/**
 * Every tool declares an outputSchema, so results carry `structuredContent`
 * (validated by the SDK against the schema). The text block mirrors it as
 * JSON, as the MCP spec recommends for clients that only render text.
 */
function jsonResult(data: Record<string, unknown>) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(data, null, 2),
			},
		],
		structuredContent: data,
	};
}
