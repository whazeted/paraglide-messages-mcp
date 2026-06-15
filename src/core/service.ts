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
	nextRetranslationBatch,
	nextTranslationBatch,
	queryKeys,
	queryMessages,
	searchMessages,
	type SearchResult,
} from "./queries.js";
import {
	planDeleteMessages,
	planRenameMessage,
	planRemoveOrphanMessages,
	type DeleteSummary,
	type RemoveOrphansSummary,
	type RenameSummary,
} from "./mutate.js";
import {
	runSave,
	withAccepted,
	type SaveArgs,
	type SaveFields,
	type SaveSummary,
} from "./save.js";
import { mutateKeys, readSnapshot, type ProjectSnapshot } from "./storage.js";
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
	public readonly translationStyle?: string;

	constructor(
		public readonly projectPath: string,
		options: { translationStyle?: string } = {}
	) {
		this.translationStyle = options.translationStyle?.trim() || undefined;
	}

	projectInfo(): ProjectInfo {
		return {
			...computeProjectInfo(this.projectPath, readSnapshot(this.projectPath)),
			...(this.translationStyle && { translationStyle: this.translationStyle }),
		};
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
		translations?: TranslationInput[];
		allowNewKeys?: boolean;
		skipValidation?: boolean;
	}): {
		targetLocale: string;
		sourceLocale: string;
		items: TranslationItem[];
		remaining: number;
		done: boolean;
		nextStep?: string;
	} & Partial<SaveFields> {
		const advance = (context: ProjectSnapshot) =>
			nextTranslationBatch(context, {
				targetLocale: args.targetLocale,
				sourceLocale: args.sourceLocale,
				prefix: args.prefix,
				batchSize: args.batchSize,
			});

		// Autosave path: persist the submitted batch, then page the next one
		// from the post-save state, so the final batch is saved by the same
		// call that reports `done`.
		if (args.translations && args.translations.length > 0) {
			return this.saveAndAdvance(toSaveArgs(args, args.translations), advance);
		}

		// per-locale operation: only the source and target files are loaded,
		// so concurrent per-locale agents never read each other's locales
		return advance(this.readScoped(args.targetLocale, args.sourceLocale));
	}

	getRetranslationBatch(args: {
		targetLocale: string;
		sourceLocale?: string;
		prefix?: string;
		batchSize?: number;
		after?: string;
		translations?: TranslationInput[];
		allowNewKeys?: boolean;
		skipValidation?: boolean;
	}): {
		targetLocale: string;
		sourceLocale: string;
		items: TranslationItem[];
		total: number;
		hasMore: boolean;
		nextCursor?: string;
		nextStep?: string;
	} & Partial<SaveFields> {
		// per-locale operation, like getTranslationBatch — scope includes keys
		// that already have a translation, paged by cursor (saving does not
		// shrink the scope, so remaining/done cannot signal progress here)
		const advance = (context: ProjectSnapshot) =>
			nextRetranslationBatch(context, {
				targetLocale: args.targetLocale,
				sourceLocale: args.sourceLocale,
				prefix: args.prefix,
				batchSize: args.batchSize,
				after: args.after,
			});

		if (args.translations && args.translations.length > 0) {
			return this.saveAndAdvance(toSaveArgs(args, args.translations), advance);
		}

		return advance(this.readScoped(args.targetLocale, args.sourceLocale));
	}

	saveTranslations(args: SaveArgs): SaveSummary {
		if (args.translations.length === 0) {
			throw new Error("translations must not be empty");
		}
		// per-locale operation: scopes reads to the target plus explicit source,
		// and writes only the target file.
		return mutateKeys(
			this.projectPath,
			(context) => {
				const { accepted, summary } = runSave(context, args);
				return {
					deletions: [],
					additions: { [args.targetLocale]: accepted },
					result: summary,
				};
			},
			this.localeScope(args.targetLocale, args.sourceLocale)
		);
	}

	/** Loads a snapshot scoped to a per-locale (target + optional source) read. */
	private readScoped(
		targetLocale: string,
		sourceLocale?: string
	): ProjectSnapshot {
		return readSnapshot(this.projectPath, this.localeScope(targetLocale, sourceLocale));
	}

	private localeScope(targetLocale: string, sourceLocale?: string) {
		return {
			onlyLocales: [targetLocale, ...(sourceLocale ? [sourceLocale] : [])],
		};
	}

	/**
	 * Saves a submitted batch and pages the next one in a single atomic
	 * mutation: `advance` runs against the post-save snapshot, and the save
	 * outcome is merged into its result. Shared by the translate and
	 * retranslate batch tools.
	 */
	private saveAndAdvance<T extends Record<string, unknown>>(
		args: SaveArgs,
		advance: (postSaveContext: ProjectSnapshot) => T
	): T & SaveFields {
		return mutateKeys(
			this.projectPath,
			(context) => {
				const { results, accepted, summary } = runSave(context, args);
				const batch = advance(
					withAccepted(context, args.targetLocale, accepted)
				);
				return {
					deletions: [],
					additions: { [args.targetLocale]: accepted },
					result: {
						...batch,
						saved: summary.saved,
						failed: summary.failed,
						saveResults: results,
						allSaved: summary.failed === 0,
					},
				};
			},
			this.localeScope(args.targetLocale, args.sourceLocale)
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

	removeOrphanMessages(args: {
		sourceLocale?: string;
		targetLocales?: string[];
		prefix?: string;
	}): RemoveOrphansSummary {
		const readOptions = args.targetLocales
			? {
					onlyLocales: [
						...(args.sourceLocale ? [args.sourceLocale] : []),
						...args.targetLocales,
					],
				}
			: undefined;
		return mutateKeys(
			this.projectPath,
			(context) => {
				const { localeDeletions, summary } = planRemoveOrphanMessages(
					context,
					args
				);
				return {
					deletions: [],
					localeDeletions,
					additions: {},
					result: summary,
				};
			},
			readOptions
		);
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

/** Builds the save core's args from a batch call's autosave inputs. */
function toSaveArgs(
	args: {
		targetLocale: string;
		sourceLocale?: string;
		allowNewKeys?: boolean;
		skipValidation?: boolean;
	},
	translations: TranslationInput[]
): SaveArgs {
	return {
		targetLocale: args.targetLocale,
		sourceLocale: args.sourceLocale,
		translations,
		allowNewKeys: args.allowNewKeys,
		skipValidation: args.skipValidation,
	};
}
