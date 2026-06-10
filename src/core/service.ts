import {
	computeProjectInfo,
	nextTranslationBatch,
	queryKeys,
	queryMessages,
} from "./queries.js";
import { validateBatch, summarizeSave, type SaveSummary } from "./save.js";
import { createStorage } from "./storage.js";
import type {
	MessageValue,
	ProjectInfo,
	TranslationInput,
	TranslationItem,
} from "./types.js";

/**
 * The operations behind the MCP tools, as a thin facade: each call resolves
 * the project storage (direct JSON files or the inlang SDK — see storage.ts),
 * loads a fresh snapshot, and delegates to the pure logic in queries.ts and
 * save.ts. Nothing is held between calls, so the server stays stateless and
 * external edits are always picked up.
 */
export class TranslationService {
	constructor(public readonly projectPath: string) {}

	async projectInfo(): Promise<ProjectInfo> {
		const context = await createStorage(this.projectPath).read();
		return computeProjectInfo(this.projectPath, context);
	}

	async listKeys(args: {
		prefix?: string;
		locale?: string;
		status?: "all" | "missing" | "translated";
		limit?: number;
		after?: string;
	}): Promise<{
		keys: string[];
		total: number;
		hasMore: boolean;
		nextCursor?: string;
	}> {
		const context = await createStorage(this.projectPath).read();
		return queryKeys(context, args);
	}

	async getMessages(args: {
		keys?: string[];
		prefix?: string;
		locales?: string[];
		limit?: number;
	}): Promise<{
		messages: Array<{
			key: string;
			translations: Record<string, MessageValue | null>;
		}>;
		truncated: boolean;
	}> {
		if (!args.keys?.length && args.prefix === undefined) {
			throw new Error("provide either keys or a prefix");
		}
		const context = await createStorage(this.projectPath).read();
		return queryMessages(context, args);
	}

	async getTranslationBatch(args: {
		targetLocale: string;
		sourceLocale?: string;
		prefix?: string;
		batchSize?: number;
	}): Promise<{
		targetLocale: string;
		sourceLocale: string;
		items: TranslationItem[];
		remaining: number;
		done: boolean;
	}> {
		const context = await createStorage(this.projectPath).read();
		return nextTranslationBatch(context, args);
	}

	async saveTranslations(args: {
		targetLocale: string;
		translations: TranslationInput[];
		allowNewKeys?: boolean;
	}): Promise<SaveSummary> {
		if (args.translations.length === 0) {
			throw new Error("translations must not be empty");
		}
		if (args.translations.length > 25) {
			throw new Error(
				"max 25 translations per call — translate in small batches to keep error rates low"
			);
		}
		return await createStorage(this.projectPath).update(
			args.targetLocale,
			(context) => {
				const { results, accepted } = validateBatch(context, args);
				return {
					values: accepted,
					result: summarizeSave(context, args.targetLocale, results, accepted),
				};
			}
		);
	}
}
