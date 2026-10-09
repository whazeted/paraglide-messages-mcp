import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { TranslationService } from "../core/service.js";
import type { BatchTranslationService } from "../core/batch.js";

const locale = z.string().min(1);
const limit = z.number().int().min(1).max(100).optional();
const value = z.union([z.string(), z.array(z.object({
	declarations: z.array(z.string()).optional(),
	selectors: z.array(z.string()).optional(),
	match: z.record(z.string(), z.string()),
})).min(1)]);
const readOnly = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false };
const externalWrite = { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true };

/** Keep schemas and guidance small: translation happens in OpenAI, not the MCP agent. */
export function registerTools(server: McpServer, service: TranslationService, batches: BatchTranslationService): void {
	server.registerTool("project_info", {
		description: "Project locales, source locale, message counts, and configured translation style.",
		inputSchema: z.object({}), annotations: readOnly,
	}, () => result(() => service.projectInfo()));

	server.registerTool("list_message_keys", {
		description: "List flat message keys by prefix and translation status; paginate with after.",
		inputSchema: z.object({ prefix: z.string().optional(), locale: locale.optional(), status: z.enum(["all", "missing", "translated"]).optional(), limit, after: z.string().optional() }),
		annotations: readOnly,
	}, args => result(() => service.listKeys(args)));

	server.registerTool("get_messages", {
		description: "Read message values by exact keys or prefix, optionally for selected locales.",
		inputSchema: z.object({ keys: z.array(z.string()).min(1).optional(), prefix: z.string().optional(), locales: z.array(locale).min(1).optional(), limit }),
		annotations: readOnly,
	}, args => result(() => service.getMessages(args)));

	server.registerTool("search_messages", {
		description: "Search message text or key substrings, case insensitive.",
		inputSchema: z.object({ query: z.string().min(1), locales: z.array(locale).min(1).optional(), limit }), annotations: readOnly,
	}, args => result(() => service.searchMessages(args)));

	server.registerTool("save_translations", {
		description: "Validate and save corrections for existing message keys in one locale. Preserves placeholders, markup and variant structure.",
		inputSchema: z.object({ targetLocale: locale, sourceLocale: locale.optional(), translations: z.array(z.object({ key: z.string().min(1), value })).min(1).max(100) }),
		annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
	}, args => result(() => service.saveTranslations(args)));

	server.registerTool("start_translation_job", {
		description: "Submit translations to OpenAI Batch API (paid, asynchronous, up to 24h). Defaults to missing messages in all target locales; mode all refreshes existing copy. Includes flat keys and current style. Supply a stable jobId and reuse it on retries. Returns a durable job ID; use get_translation_job to collect validated results.",
		inputSchema: z.object({
			jobId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
			targetLocales: z.array(locale).min(1).optional(), sourceLocale: locale.optional(),
			prefix: z.string().optional(), mode: z.enum(["missing", "all"]).optional(),
			translationStyle: z.string().trim().min(1).optional(),
		}), annotations: externalWrite,
	}, args => result(() => batches.start(args)));

	server.registerTool("get_translation_job", {
		description: "Resume a durable job: check OpenAI once, archive terminal results, validate and merge unchanged messages, then delete remote input/output/error files. Safe after restarts; no waiting loop. Inspect lastError and failed as well as status and cleanedUp.",
		inputSchema: z.object({ jobId: z.string() }),
		annotations: { ...externalWrite, idempotentHint: true },
	}, ({ jobId }) => result(() => batches.get(jobId)));

	server.registerTool("list_translation_jobs", {
		description: "List locally persisted job summaries without contacting OpenAI. Paginate with after; use get_translation_job to resume work.",
		inputSchema: z.object({ after: z.string().optional(), limit }), annotations: readOnly,
	}, args => result(() => batches.list(args)));

	server.registerTool("cancel_translation_job", {
		description: "Durably request cancellation. OpenAI may take up to 10 minutes; continue get_translation_job until terminal and cleanedUp. Completed partial results are collected and validated.",
		inputSchema: z.object({ jobId: z.string() }),
		annotations: { ...externalWrite, destructiveHint: true, idempotentHint: true },
	}, ({ jobId }) => result(() => batches.cancel(jobId)));
}

async function result(run: () => object | Promise<object>) {
	try {
		const data = await run() as Record<string, unknown>;
		return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data,
			...(Boolean(data.lastError) && { isError: true }),
		};
	} catch (error) {
		return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
	}
}
