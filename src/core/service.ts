import { flatten, unflatten } from "flat";
import type { InlangProject } from "@inlang/sdk";
import {
	isEmptyValue,
	isValidMessageValue,
	placeholdersOf,
	validateTranslation,
} from "./format.js";
import { pickPluginKey, saveProject, withProject } from "./project.js";
import type {
	LocaleMessages,
	MessagesSnapshot,
	MessageValue,
	ProjectInfo,
	SaveResultItem,
	TranslationInput,
	TranslationItem,
} from "./types.js";

/**
 * All operations load the project from disk, act, and close it again, so the
 * server holds no state between tool calls (see `withProject`).
 */
export class TranslationService {
	constructor(public readonly projectPath: string) {}

	async projectInfo(): Promise<ProjectInfo> {
		return await withProject(this.projectPath, async (project) => {
			const settings = await project.settings.get();
			const pluginKey = await pickPluginKey(project);
			const snapshot = await exportSnapshot(project, pluginKey);
			const allKeys = collectKeys(snapshot);

			const translated: Record<string, number> = {};
			const missing: Record<string, number> = {};
			for (const locale of settings.locales) {
				let count = 0;
				for (const key of allKeys) {
					if (!isEmptyValue(snapshot[locale]?.[key])) count++;
				}
				translated[locale] = count;
				missing[locale] = allKeys.size - count;
			}

			return {
				projectPath: this.projectPath,
				baseLocale: settings.baseLocale,
				locales: settings.locales,
				pluginKey,
				totalKeys: allKeys.size,
				translated,
				missing,
			};
		});
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
		return await withProject(this.projectPath, async (project) => {
			const settings = await project.settings.get();
			const pluginKey = await pickPluginKey(project);
			const snapshot = await exportSnapshot(project, pluginKey);

			const locale = args.locale;
			if (locale && !settings.locales.includes(locale)) {
				throw unknownLocaleError(locale, settings.locales);
			}
			const status = args.status ?? "all";
			if (status !== "all" && !locale) {
				throw new Error(`status "${status}" requires a locale`);
			}

			let keys = [...collectKeys(snapshot)].sort();
			if (args.prefix) {
				keys = keys.filter((key) => key.startsWith(args.prefix!));
			}
			if (locale && status !== "all") {
				keys = keys.filter((key) => {
					const empty = isEmptyValue(snapshot[locale]?.[key]);
					return status === "missing" ? empty : !empty;
				});
			}

			const total = keys.length;
			if (args.after) {
				keys = keys.filter((key) => key > args.after!);
			}
			const limit = clamp(args.limit ?? 100, 1, 500);
			const page = keys.slice(0, limit);
			const hasMore = keys.length > limit;

			return {
				keys: page,
				total,
				hasMore,
				nextCursor: hasMore ? page[page.length - 1] : undefined,
			};
		});
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
		return await withProject(this.projectPath, async (project) => {
			const settings = await project.settings.get();
			const pluginKey = await pickPluginKey(project);
			const snapshot = await exportSnapshot(project, pluginKey);

			const locales = args.locales ?? settings.locales;
			for (const locale of locales) {
				if (!settings.locales.includes(locale)) {
					throw unknownLocaleError(locale, settings.locales);
				}
			}

			let keys: string[];
			if (args.keys?.length) {
				keys = args.keys;
			} else {
				keys = [...collectKeys(snapshot)]
					.filter((key) => key.startsWith(args.prefix!))
					.sort();
			}

			const limit = clamp(args.limit ?? 50, 1, 200);
			const truncated = keys.length > limit;
			keys = keys.slice(0, limit);

			const allKeys = collectKeys(snapshot);
			const messages = keys.map((key) => {
				if (!allKeys.has(key)) {
					return { key, translations: {} as Record<string, MessageValue | null> };
				}
				const translations: Record<string, MessageValue | null> = {};
				for (const locale of locales) {
					translations[locale] = snapshot[locale]?.[key] ?? null;
				}
				return { key, translations };
			});

			return { messages, truncated };
		});
	}

	async getTranslationBatch(args: {
		targetLocale: string;
		sourceLocale?: string;
		prefix?: string;
		batchSize?: number;
		includeStale?: boolean;
	}): Promise<{
		targetLocale: string;
		sourceLocale: string;
		items: TranslationItem[];
		remaining: number;
		done: boolean;
	}> {
		return await withProject(this.projectPath, async (project) => {
			const settings = await project.settings.get();
			const pluginKey = await pickPluginKey(project);
			const snapshot = await exportSnapshot(project, pluginKey);

			const targetLocale = args.targetLocale;
			if (!settings.locales.includes(targetLocale)) {
				throw unknownLocaleError(targetLocale, settings.locales);
			}
			const sourceLocale = args.sourceLocale ?? settings.baseLocale;
			if (!settings.locales.includes(sourceLocale)) {
				throw unknownLocaleError(sourceLocale, settings.locales);
			}
			if (sourceLocale === targetLocale) {
				throw new Error("sourceLocale and targetLocale must differ");
			}

			let keys = [...collectKeys(snapshot)].sort();
			if (args.prefix) {
				keys = keys.filter((key) => key.startsWith(args.prefix!));
			}

			const pending = keys.filter((key) => {
				const source = snapshot[sourceLocale]?.[key];
				if (isEmptyValue(source)) return false;
				return isEmptyValue(snapshot[targetLocale]?.[key]);
			});

			const batchSize = clamp(args.batchSize ?? 5, 1, 25);
			const items: TranslationItem[] = pending
				.slice(0, batchSize)
				.map((key) => {
					const source = snapshot[sourceLocale]![key]!;
					const existingTarget = snapshot[targetLocale]?.[key];
					return {
						key,
						source,
						...(existingTarget !== undefined && { existingTarget }),
						placeholders: placeholdersOf(source),
					};
				});

			return {
				targetLocale,
				sourceLocale,
				items,
				remaining: pending.length,
				done: pending.length === 0,
			};
		});
	}

	async saveTranslations(args: {
		targetLocale: string;
		translations: TranslationInput[];
		allowNewKeys?: boolean;
	}): Promise<{
		results: SaveResultItem[];
		saved: number;
		failed: number;
		remainingForLocale: number;
	}> {
		if (args.translations.length === 0) {
			throw new Error("translations must not be empty");
		}
		if (args.translations.length > 25) {
			throw new Error(
				"max 25 translations per call — translate in small batches to keep error rates low"
			);
		}
		return await withProject(this.projectPath, async (project) => {
			const settings = await project.settings.get();
			const pluginKey = await pickPluginKey(project);
			const snapshot = await exportSnapshot(project, pluginKey);
			const allKeys = collectKeys(snapshot);

			const targetLocale = args.targetLocale;
			if (!settings.locales.includes(targetLocale)) {
				throw unknownLocaleError(targetLocale, settings.locales);
			}

			const results: SaveResultItem[] = [];
			const accepted: Record<string, MessageValue> = {};

			const seen = new Set<string>();
			for (const item of args.translations) {
				if (seen.has(item.key)) {
					results.push({
						key: item.key,
						status: "error",
						error: "duplicate key in this call",
					});
					continue;
				}
				seen.add(item.key);

				if (!allKeys.has(item.key) && !args.allowNewKeys) {
					results.push({
						key: item.key,
						status: "error",
						error:
							"unknown message key — keys must come from get_translation_batch/list_message_keys. " +
							"Pass allowNewKeys=true only when intentionally creating a new message.",
					});
					continue;
				}

				const source = snapshot[settings.baseLocale]?.[item.key];
				if (source !== undefined && targetLocale !== settings.baseLocale) {
					const validation = validateTranslation(source, item.value);
					if (validation.errors.length > 0) {
						results.push({
							key: item.key,
							status: "error",
							error: validation.errors.join("; "),
						});
						continue;
					}
					accepted[item.key] = item.value;
					results.push({
						key: item.key,
						status: "saved",
						...(validation.warnings.length > 0 && {
							warnings: validation.warnings,
						}),
					});
				} else {
					// new key or base-locale edit: only structural validation applies
					if (!isValidMessageValue(item.value)) {
						results.push({
							key: item.key,
							status: "error",
							error:
								"value must be a string or a single-element variant array",
						});
						continue;
					}
					accepted[item.key] = item.value;
					results.push({ key: item.key, status: "saved" });
				}
			}

			if (Object.keys(accepted).length > 0) {
				const content = unflatten(accepted) as object;
				await project.importFiles({
					pluginKey,
					files: [
						{
							locale: targetLocale,
							content: new TextEncoder().encode(JSON.stringify(content)),
						},
					],
				});
				await saveProject(project, this.projectPath);
			}

			// recompute what is still missing so the caller knows when to stop
			const after = await exportSnapshot(project, pluginKey);
			const baseKeys = [...collectKeys(after)];
			const remainingForLocale = baseKeys.filter((key) => {
				const source = after[settings.baseLocale]?.[key];
				if (isEmptyValue(source)) return false;
				return isEmptyValue(after[targetLocale]?.[key]);
			}).length;

			const saved = results.filter((r) => r.status === "saved").length;
			return {
				results,
				saved,
				failed: results.length - saved,
				remainingForLocale,
			};
		});
	}
}

/**
 * Exports all messages via the project's own plugin and flattens each locale
 * file to `key -> value`. Nested keys become dot-joined, exactly like the
 * message format plugin treats them.
 */
async function exportSnapshot(
	project: InlangProject,
	pluginKey: string
): Promise<MessagesSnapshot> {
	const files = await project.exportFiles({ pluginKey });
	const snapshot: MessagesSnapshot = {};
	for (const file of files) {
		const json = JSON.parse(new TextDecoder().decode(file.content));
		delete json.$schema;
		// safe: true keeps variant arrays intact
		snapshot[file.locale] = flatten(json, { safe: true }) as LocaleMessages;
	}
	return snapshot;
}

function collectKeys(snapshot: MessagesSnapshot): Set<string> {
	const keys = new Set<string>();
	for (const messages of Object.values(snapshot)) {
		for (const key of Object.keys(messages)) {
			keys.add(key);
		}
	}
	return keys;
}

function unknownLocaleError(locale: string, locales: string[]): Error {
	return new Error(
		`unknown locale "${locale}" — project locales: ${locales.join(", ")}`
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
