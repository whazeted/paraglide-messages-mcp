import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	DEFAULT_LIST_KEYS_PAGE_SIZE,
	DEFAULT_GET_MESSAGES_LIMIT,
	DEFAULT_SEARCH_MESSAGES_LIMIT,
} from "../core/constants.js";
import type { TranslationService } from "../core/service.js";
import type { TranslationInput } from "../core/types.js";

// One terse factual note appended to the write tools' descriptions, so the
// contract is visible even to agents that discover tools schema-only (via tool
// search) and never load the workflow prompts. Kept short on purpose: it sits
// in always-on context. The *behavioral* half — what to do when a call fails —
// is emitted only on the error path (see WRITE_FAILURE_GUIDANCE), where it
// costs nothing until something actually goes wrong.
const CATALOG_WRITE_CONTRACT =
	"These message files are written only through the paraglide tools — never hand-edit " +
	"the locale JSON (it skips validation and can corrupt the file).";

// Appended to thrown (operational) errors from the write tools — unknown
// locale, unreadable file, transient I/O — i.e. the moment an agent is most
// tempted to abandon the tools and edit files by hand. Per-item validation
// failures are NOT errors: they come back in results/saveResults with a fix.
const WRITE_FAILURE_GUIDANCE =
	" Retry this call; if it keeps failing, stop and report how many messages remain — " +
	"do not hand-edit the message files as a fallback.";

const variantSchema = z.object({
	declarations: z.array(z.string()).optional(),
	selectors: z.array(z.string()).optional(),
	match: z.record(z.string(), z.string()),
});

// .min(1) instead of .length(1): a multi-element array passes the transport
// schema so the service can reject it per-item with an actionable
// consolidation hint (see messageValueError) instead of an opaque zod error.
const messageValueSchema = z.union([
	z.string(),
	z.array(variantSchema).min(1),
]);

// Output values come from message files on disk, which may contain
// multi-variant arrays — don't enforce the single-element rule on the way out.
const messageValueOutputSchema = z.union([z.string(), z.array(variantSchema)]);

const localesAfterChangeSchema = z
	.array(z.string())
	.describe("the project's locales after the change");

// One translation to save. Shared by save_translations and the batch tools'
// optional autosave input.
const translationItemSchema = z.object({
	key: z.string().describe("message key"),
	value: messageValueSchema.describe(
		"translated value: string like 'Hallo {name}' or " +
			'[{"declarations": [...], "selectors": [...], "match": {"count=one": "...", "count=other": "..."}}]'
	),
});

// One per-item save outcome. Shared by save_translations.results and the
// batch tools' saveResults.
const saveResultItemSchema = z.object({
	key: z.string(),
	status: z.enum(["saved", "error"]),
	error: z.string().optional(),
	warnings: z.array(z.string()).optional(),
});

// Optional save inputs the batch tools accept to autosave the previous batch
// before paging the next one (same semantics as save_translations).
const autosaveInputSchema = {
	translations: z
		.array(translationItemSchema)
		.optional()
		.describe(
			"the PREVIOUS batch's translations to save before returning the next batch — " +
				"validated and persisted exactly like save_translations. Omit on the first (priming) call."
		),
	allowNewKeys: z
		.boolean()
		.optional()
		.describe("for the autosave: allow creating keys that don't exist yet (default false)"),
	skipValidation: z
		.boolean()
		.optional()
		.describe(
			"for the autosave: skip placeholder/markup/variant validation against the source (default false)"
		),
};

// Save-outcome fields the batch tools report when translations were submitted
// for autosaving. All optional: absent on a priming call with no translations.
const autosaveOutputSchema = {
	saved: z
		.number()
		.int()
		.optional()
		.describe("autosaved translations (present only when translations were submitted)"),
	failed: z
		.number()
		.int()
		.optional()
		.describe("submitted translations rejected (present only when translations were submitted)"),
	saveResults: z
		.array(saveResultItemSchema)
		.optional()
		.describe("per-item outcome of the autosave; fix and re-save any with status 'error'"),
	allSaved: z
		.boolean()
		.optional()
		.describe(
			"true when every submitted translation was saved (failed === 0); absent when no " +
				"translations were submitted. Combine with `done`/`hasMore` to confirm the run is complete and persisted."
		),
};

const readOnlyAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const saveAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const nonIdempotentWriteAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
} as const;

const destructiveWriteAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: false,
} as const;

const idempotentDestructiveWriteAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false,
} as const;

/**
 * Registers the translation tools. They are designed for *per-locale batch*
 * translation: an agent (or one subagent per locale, running in parallel)
 * pulls a batch of messages for its locale, translates them, saves them, and
 * repeats until `remaining` is 0. Validation happens server-side per item on
 * every save so mistakes are rejected individually instead of corrupting
 * message files, which is what makes large batches safe.
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
				"translation-scope count, and per-locale translated/missing counts. Call this first to plan translation work.",
			inputSchema: {},
			outputSchema: {
				projectPath: z.string(),
				baseLocale: z.string(),
				locales: z.array(z.string()),
				pluginKey: z.string(),
				totalKeys: z
					.number()
					.int()
					.describe("all keys present in any locale, including non-source/orphan keys"),
				translatableKeys: z
					.number()
					.int()
					.describe("non-empty base-locale keys eligible for get_translation_batch"),
				translationStyle: z
					.string()
					.optional()
					.describe("linguistic style brief configured at server startup"),
				translated: z
					.record(z.string(), z.number().int())
					.describe("per locale: keys with a non-empty message"),
				missing: z
					.record(z.string(), z.number().int())
					.describe(
						"per locale: translatable base-locale keys missing or empty in this locale"
					),
				extraKeys: z
					.record(z.string(), z.number().int())
					.describe(
						"per locale: non-empty keys ignored by the translate loop because the base value is empty/missing"
					),
			},
			annotations: readOnlyAnnotations,
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
				limit: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe(`keys per page (default ${DEFAULT_LIST_KEYS_PAGE_SIZE})`),
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
			annotations: readOnlyAnnotations,
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
				limit: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe(`max messages to return (default ${DEFAULT_GET_MESSAGES_LIMIT})`),
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
			annotations: readOnlyAnnotations,
		},
		async (args) => jsonResult(await service.getMessages(args))
	);

	server.registerTool(
		"search_messages",
		{
			title: "Search messages",
			description:
				"Find messages by text content or key substring (case-insensitive). Use this when " +
				"you know the UI text but not the key — e.g. searching 'Add to cart' returns the " +
				"message key plus the locale(s) and value(s) where the text appears. Searches all " +
				"locales by default.",
			inputSchema: {
				query: z
					.string()
					.min(1)
					.describe("text to search for in message values and keys"),
				locales: z
					.array(z.string())
					.optional()
					.describe(
						"restrict the content search to these locales (default: all project locales)"
					),
				limit: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe(`max results to return (default ${DEFAULT_SEARCH_MESSAGES_LIMIT})`),
			},
			outputSchema: {
				results: z.array(
					z.object({
						key: z.string(),
						keyMatched: z
							.boolean()
							.describe("true when the key itself contains the query"),
						matches: z
							.array(
								z.object({
									locale: z.string(),
									value: messageValueOutputSchema,
								})
							)
							.describe("locales whose message text contains the query"),
					})
				),
				total: z.number().int().describe("total matching keys before `limit`"),
				truncated: z
					.boolean()
					.describe("true when more keys matched than `limit` allowed"),
			},
			annotations: readOnlyAnnotations,
		},
		async (args) => jsonResult(await service.searchMessages(args))
	);

	server.registerTool(
		"get_translation_batch",
		{
			title: "Get translation batch",
			description:
				"Get the next batch of untranslated messages for a target locale (optionally " +
				"limited to a key prefix). Returns the source text, required placeholders, and the " +
				"number of remaining untranslated messages. " +
				"Fused loop (fewer round-trips): pass the PREVIOUS batch's `translations` to this " +
				"call — they are saved first (same validation as save_translations), then the next " +
				"batch is computed from the post-save state. So the loop is: call once to prime, then " +
				"repeatedly translate + call again with `translations` set, until `done` is true — the " +
				"final batch is autosaved by the same call that reports done, with no trailing save. " +
				"Check `allSaved`/`saveResults`: a failed item is not saved (it reappears in a later " +
				"batch), so fix it and re-save (here or via save_translations). " +
				"Raise batchSize for short UI strings (fewer round-trips); lower it for long, " +
				"nuanced prose so each item gets full attention. Reads only the source and target locale " +
				"files, so per-locale agents can run in parallel without touching each other's locales. " +
				CATALOG_WRITE_CONTRACT,
			inputSchema: {
				targetLocale: z.string().describe("locale to translate into"),
				sourceLocale: z
					.string()
					.optional()
					.describe(
						"locale to translate from (default: project base locale). When autosaving, " +
							"the same sourceLocale is used to validate the submitted translations."
					),
				prefix: z
					.string()
					.optional()
					.describe("only consider keys starting with this prefix"),
				batchSize: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe(
						"messages per batch; omit for a sensible default — raise for " +
							"short strings, lower for long, nuanced prose"
					),
				...autosaveInputSchema,
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
					.describe("untranslated messages left for this locale/prefix (after the autosave, if any)"),
				done: z.boolean().describe("true when nothing is left to translate"),
				nextStep: z
					.string()
					.optional()
					.describe(
						"present only while messages remain: a reminder to call get_translation_batch " +
							"again to continue the loop. Absent when `done` is true."
					),
				...autosaveOutputSchema,
			},
			// not readOnly: when `translations` is supplied the call autosaves.
			annotations: saveAnnotations,
		},
		async (args) =>
			writeResult(() =>
				service.getTranslationBatch({
					...args,
					// zod validates the single-element variant array shape at runtime
					translations: args.translations as TranslationInput[] | undefined,
				})
			)
	);

	server.registerTool(
		"get_retranslation_batch",
		{
			title: "Get retranslation batch",
			description:
				"Get a batch of messages to RETRANSLATE for a target locale — unlike " +
				"get_translation_batch this includes keys that already have a translation, so a " +
				"full pass refreshes stale entries (and fills gaps) for everything in scope, " +
				"optionally limited to a key prefix. Saving does not shrink the scope, so the " +
				"loop pages by cursor instead of remaining/done. " +
				"Fused loop (fewer round-trips): pass the PREVIOUS batch's `translations` to this " +
				"call (it overwrites existing values), then page on with `after` set to the previous " +
				"`nextCursor`. So the loop is: call once to prime, then repeatedly translate + call " +
				"again with `translations` set and `after: nextCursor`, until `hasMore` is false — the " +
				"last batch is autosaved by the same call. Each item shows its current value as " +
				"`existingTarget`; an item already correct may be skipped (omit it from `translations`) " +
				"without stalling the loop, since the cursor moves regardless. " +
				"Check `allSaved`/`saveResults` and re-save any failed item (it is past the cursor, so " +
				"re-save it here or via save_translations). Reads only the source and target locale " +
				"files, so per-locale agents can run in parallel without touching each other's locales. " +
				CATALOG_WRITE_CONTRACT,
			inputSchema: {
				targetLocale: z.string().describe("locale to retranslate"),
				sourceLocale: z
					.string()
					.optional()
					.describe(
						"locale to translate from (default: project base locale). When autosaving, " +
							"the same sourceLocale is used to validate the submitted translations."
					),
				prefix: z
					.string()
					.optional()
					.describe("only consider keys starting with this prefix"),
				batchSize: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe(
						"messages per batch; omit for a sensible default — raise for " +
							"short strings, lower for long, nuanced prose"
					),
				after: z
					.string()
					.optional()
					.describe(
						"pagination cursor: return keys after this key (use the previous call's `nextCursor`)"
					),
				...autosaveInputSchema,
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
							.describe(
								"current value in the target locale — the value a save would replace"
							),
						placeholders: z
							.array(z.string())
							.describe("placeholders that must be preserved"),
					})
				),
				total: z
					.number()
					.int()
					.describe(
						"keys in scope for this locale/prefix (stable across pages)"
					),
				hasMore: z
					.boolean()
					.describe("true when more pages follow — continue with `after: nextCursor`"),
				nextCursor: z
					.string()
					.optional()
					.describe("pass as `after` in the next call; absent on the last page"),
				nextStep: z
					.string()
					.optional()
					.describe(
						"present only while more pages remain: a reminder to call get_retranslation_batch " +
							"again with `after: nextCursor` to continue the loop. Absent on the last page."
					),
				...autosaveOutputSchema,
			},
			// not readOnly: when `translations` is supplied the call autosaves.
			annotations: saveAnnotations,
		},
		async (args) =>
			writeResult(() =>
				service.getRetranslationBatch({
					...args,
					// zod validates the single-element variant array shape at runtime
					translations: args.translations as TranslationInput[] | undefined,
				})
			)
	);

	server.registerTool(
		"save_translations",
		{
			title: "Save translations",
			description:
				"Save translated messages for one target locale and write them to the project's " +
				"message files. Each value must be a string (simple message) or a single-element " +
				"variant array (complex message) in the inlang message format. Placeholders are " +
				"validated against the sourceLocale message (default: project base locale); " +
				"items with errors are rejected individually " +
				"while valid items are still saved. Returns per-item results plus the number of " +
				"messages still missing for the locale. " +
				CATALOG_WRITE_CONTRACT,
			inputSchema: {
				targetLocale: z.string().describe("locale the translations are for"),
				sourceLocale: z
					.string()
					.optional()
					.describe(
						"locale the translations came from (default: project base locale). " +
							"When saving a batch fetched with sourceLocale, pass the same sourceLocale here."
					),
				translations: z
					.array(translationItemSchema)
					.min(1)
					.describe("translations to save"),
				allowNewKeys: z
					.boolean()
					.optional()
					.describe(
						"allow creating keys that don't exist yet (default false; protects against typos)"
					),
				skipValidation: z
					.boolean()
					.optional()
					.describe(
						"skip placeholder/markup/variant validation against the source (default false). " +
							"Use only when a translation deliberately diverges, e.g. it doesn't need a " +
							"source placeholder. Structural and key checks still apply."
					),
			},
			outputSchema: {
				results: z.array(saveResultItemSchema),
				saved: z.number().int(),
				failed: z.number().int(),
				remainingForLocale: z
					.number()
					.int()
					.describe("messages still missing for the target locale"),
			},
			annotations: saveAnnotations,
		},
		async (args) =>
			writeResult(() =>
				service.saveTranslations({
					targetLocale: args.targetLocale,
					sourceLocale: args.sourceLocale,
					// zod validates the single-element variant array shape at runtime
					translations: args.translations as TranslationInput[],
					allowNewKeys: args.allowNewKeys,
					skipValidation: args.skipValidation,
				})
			)
	);

	server.registerTool(
		"delete_messages",
		{
			title: "Delete messages",
			description:
				"Delete messages by key from every locale's message file. Unknown keys are " +
				"rejected individually while the rest are still deleted. Deletion is permanent — " +
				"verify keys with list_message_keys/get_messages first.",
			inputSchema: {
				keys: z
					.array(z.string())
					.min(1)
					.describe("message keys to delete from all locales"),
			},
			outputSchema: {
				results: z.array(
					z.object({
						key: z.string(),
						status: z.enum(["deleted", "error"]),
						error: z.string().optional(),
					})
				),
				deleted: z.number().int(),
				failed: z.number().int(),
			},
			annotations: destructiveWriteAnnotations,
		},
		async (args) => jsonResult(await service.deleteMessages(args))
	);

	server.registerTool(
		"remove_orphan_messages",
		{
			title: "Remove orphan messages",
			description:
				"Remove target-locale messages whose keys do not exist in the source locale. " +
				"An orphan is a key present in a target locale file and absent from sourceLocale " +
				"(default: project base locale). Empty source values still count as existing. " +
				"By default this checks every locale except the source locale; narrow with " +
				"targetLocales and/or prefix when you only want to clean part of the catalog.",
			inputSchema: {
				sourceLocale: z
					.string()
					.optional()
					.describe("source locale to compare against (default: project base locale)"),
				targetLocales: z
					.array(z.string())
					.min(1)
					.optional()
					.describe(
						"target locales to clean (default: every project locale except sourceLocale)"
					),
				prefix: z
					.string()
					.optional()
					.describe("only remove orphan keys starting with this prefix"),
			},
			outputSchema: {
				sourceLocale: z.string(),
				targetLocales: z.array(z.string()),
				results: z.array(
					z.object({
						locale: z.string(),
						deleted: z.number().int(),
						keys: z.array(z.string()),
					})
				),
				deleted: z
					.number()
					.int()
					.describe("total orphan key occurrences removed across target locales"),
			},
			annotations: idempotentDestructiveWriteAnnotations,
		},
		async (args) => jsonResult(await service.removeOrphanMessages(args))
	);

	server.registerTool(
		"rename_message",
		{
			title: "Rename message",
			description:
				"Rename a message key across every locale, keeping all translated values. " +
				"Fails without changing anything when the old key doesn't exist or the new " +
				"key is already taken. Remember to update code references to the old key.",
			inputSchema: {
				key: z.string().describe("current message key"),
				newKey: z.string().describe("new message key (must not exist yet)"),
			},
			outputSchema: {
				key: z.string(),
				newKey: z.string(),
				updatedLocales: z
					.array(z.string())
					.describe("locales that had a value under the old key"),
			},
			annotations: destructiveWriteAnnotations,
		},
		async (args) => jsonResult(await service.renameMessage(args))
	);

	server.registerTool(
		"add_locale",
		{
			title: "Add locale",
			description:
				"Add a locale to the project settings so it can be translated into. For " +
				"message-format projects an empty message file is also created. The locale " +
				"tag is stored as-is (no format validation) — follow the convention the " +
				"project already uses (see project_info).",
			inputSchema: {
				locale: z
					.string()
					.describe(
						"locale tag to add, in the project's existing convention (e.g. 'es' or 'pt-BR')"
					),
			},
			outputSchema: {
				locale: z.string(),
				locales: localesAfterChangeSchema,
				messageFileCreated: z
					.boolean()
					.describe("true when an empty message file was seeded"),
			},
			annotations: nonIdempotentWriteAnnotations,
		},
		async (args) => jsonResult(await service.addLocale(args))
	);

	server.registerTool(
		"remove_locale",
		{
			title: "Remove locale",
			description:
				"Remove a locale from the project settings and delete its message file. " +
				"Permanently discards every translation in that locale — check `translated` " +
				"in project_info first and confirm with the user. The base locale cannot " +
				"be removed.",
			inputSchema: {
				locale: z.string().describe("locale tag to remove"),
			},
			outputSchema: {
				locale: z.string(),
				locales: localesAfterChangeSchema,
				discardedTranslations: z
					.number()
					.int()
					.describe("non-empty translations that existed in the locale"),
				messageFileDeleted: z.boolean(),
			},
			annotations: destructiveWriteAnnotations,
		},
		async (args) => jsonResult(await service.removeLocale(args))
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

/**
 * Runs a write tool, and on a thrown (operational) error returns an error
 * result whose message carries WRITE_FAILURE_GUIDANCE — so the "retry, else
 * stop; never hand-edit" instruction reaches the agent exactly when a call
 * fails, instead of riding along in every tool description. Per-item
 * validation failures don't throw, so they keep their normal saveResults path.
 */
async function writeResult(run: () => Record<string, unknown> | Promise<Record<string, unknown>>) {
	try {
		return jsonResult(await run());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: message + WRITE_FAILURE_GUIDANCE }],
			isError: true as const,
		};
	}
}
