import { parseDirectProject, readDirectLocale } from "./direct.js";
import { isEmptyValue } from "./format.js";
import {
	addLocale,
	removeLocale,
	type AddLocaleResult,
	type RemoveLocaleResult,
} from "./locales.js";
import {
	computeProjectInfo,
	nextTranslationBatch,
	queryKeys,
	queryMessages,
	searchMessages,
	type SearchResult,
} from "./queries.js";
import {
	planDeleteMessages,
	planRenameMessage,
	type DeleteSummary,
	type RenameSummary,
} from "./mutate.js";
import { validateBatch, summarizeSave, type SaveSummary } from "./save.js";
import { mutateKeys, readSnapshot } from "./storage.js";
import type {
	MessageValue,
	ProjectInfo,
	TranslationInput,
	TranslationItem,
} from "./types.js";

/**
 * The operations behind the MCP tools, as a thin facade: each call loads a
 * fresh snapshot straight from the project's message files (see storage.ts /
 * direct.ts) and delegates to the pure logic in queries.ts and save.ts.
 * Every method is synchronous on purpose: a call runs atomically on the
 * event loop, so concurrent per-locale agents can never observe or produce
 * a half-applied operation. No translation state is held between calls —
 * file reads are served through a stat-validated cache (direct.ts), so
 * external edits are always picked up.
 */
export class TranslationService {
	constructor(public readonly projectPath: string) {}

	projectInfo(): ProjectInfo {
		return computeProjectInfo(this.projectPath, readSnapshot(this.projectPath));
	}

	listKeys(args: {
		prefix?: string;
		locale?: string;
		status?: "all" | "missing" | "translated";
		limit?: number;
		after?: string;
	}): {
		keys: string[];
		total: number;
		hasMore: boolean;
		nextCursor?: string;
	} {
		return queryKeys(readSnapshot(this.projectPath), args);
	}

	getMessages(args: {
		keys?: string[];
		prefix?: string;
		locales?: string[];
		limit?: number;
	}): {
		messages: Array<{
			key: string;
			translations: Record<string, MessageValue | null>;
		}>;
		truncated: boolean;
	} {
		if (!args.keys?.length && args.prefix === undefined) {
			throw new Error("provide either keys or a prefix");
		}
		return queryMessages(readSnapshot(this.projectPath), args);
	}

	searchMessages(args: {
		query: string;
		locales?: string[];
		limit?: number;
	}): {
		results: SearchResult[];
		total: number;
		truncated: boolean;
	} {
		return searchMessages(readSnapshot(this.projectPath), args);
	}

	getTranslationBatch(args: {
		targetLocale: string;
		sourceLocale?: string;
		prefix?: string;
		batchSize?: number;
		maxOutputBudget?: number;
	}): {
		targetLocale: string;
		sourceLocale: string;
		items: TranslationItem[];
		remaining: number;
		done: boolean;
	} {
		// per-locale operation: only the source and target files are loaded,
		// so concurrent per-locale agents never read each other's locales
		const context = readSnapshot(this.projectPath, {
			onlyLocales: [
				args.targetLocale,
				...(args.sourceLocale ? [args.sourceLocale] : []),
			],
		});
		return nextTranslationBatch(context, args);
	}

	saveTranslations(args: {
		targetLocale: string;
		translations: TranslationInput[];
		allowNewKeys?: boolean;
		skipValidation?: boolean;
	}): SaveSummary {
		if (args.translations.length === 0) {
			throw new Error("translations must not be empty");
		}
		// per-locale operation: reads base + target only, writes the target file
		return mutateKeys(
			this.projectPath,
			(context) => {
				const { results, accepted } = validateBatch(context, args);
				return {
					deletions: [],
					additions: { [args.targetLocale]: accepted },
					result: summarizeSave(context, args.targetLocale, results, accepted),
				};
			},
			{ onlyLocales: [args.targetLocale] }
		);
	}

	deleteMessages(args: { keys: string[] }): DeleteSummary {
		if (args.keys.length === 0) {
			throw new Error("keys must not be empty");
		}
		return mutateKeys(this.projectPath, (context) => {
			const { deletions, summary } = planDeleteMessages(context, args.keys);
			return { deletions, additions: {}, result: summary };
		});
	}

	renameMessage(args: {
		key: string;
		newKey: string;
	}): RenameSummary {
		return mutateKeys(this.projectPath, (context) => {
			const { additions, summary } = planRenameMessage(context, args);
			return { deletions: [args.key], additions, result: summary };
		});
	}

	addLocale(args: { locale: string }): AddLocaleResult {
		return addLocale(this.projectPath, args.locale);
	}

	removeLocale(args: { locale: string }): RemoveLocaleResult {
		// count what is being discarded while the locale is still readable
		const tag = args.locale.trim();
		const messages = readDirectLocale(parseDirectProject(this.projectPath), tag);
		const discardedTranslations = Object.values(messages).filter(
			(value) => !isEmptyValue(value)
		).length;
		return { ...removeLocale(this.projectPath, args.locale), discardedTranslations };
	}
}
