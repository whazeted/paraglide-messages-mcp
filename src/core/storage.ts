import { flatten, unflatten } from "flat";
import type { InlangProject } from "@inlang/sdk";
import {
	mutateDirectLocale,
	parseDirectProject,
	readDirectSnapshot,
} from "./direct.js";
import { pickPluginKey, saveProject, withProject } from "./project.js";
import type { LocaleMessages, MessagesSnapshot } from "./types.js";

/** Everything an operation needs to know about the project, loaded fresh. */
export interface ProjectSnapshot {
	baseLocale: string;
	locales: string[];
	pluginKey: string;
	snapshot: MessagesSnapshot;
}

/**
 * What a mutation decides to persist, plus the value to return to the
 * caller. Covers every write the tools need: saves are additions to one
 * locale, deletes are key removals across all locales, renames are both.
 */
export interface KeyMutationPlan<T> {
	/** keys to remove from every locale (may be empty) */
	deletions: string[];
	/** per-locale `key -> value` entries to write (may be empty) */
	additions: Record<string, LocaleMessages>;
	result: T;
}

/**
 * How the project is read and written. Both implementations are stateless —
 * every call reads fresh from disk, so external edits (compiler, editor,
 * git) are always picked up.
 */
export interface ProjectStorage {
	read(): Promise<ProjectSnapshot>;
	/**
	 * Reads the snapshot, lets `plan` decide which keys to remove and which
	 * per-locale values to write, persists both, and returns the plan's
	 * result. Read and write happen in one storage session so the SDK path
	 * loads the project only once; the direct path rewrites only the locale
	 * files the plan actually touches.
	 */
	mutateKeys<T>(
		plan: (context: ProjectSnapshot) => KeyMutationPlan<T>
	): Promise<T>;
}

/**
 * Picks the storage for the project: direct JSON file access for
 * message-format projects (fast — see PERFORMANCE.md and direct.ts), the
 * inlang SDK for everything else. The `PARAGLIDE_MCP_FORCE_SDK` escape
 * hatch forces the SDK path. Resolved per call, so settings changes take
 * effect immediately.
 */
export function createStorage(projectPath: string): ProjectStorage {
	const direct = process.env.PARAGLIDE_MCP_FORCE_SDK
		? null
		: parseDirectProject(projectPath);
	if (direct) {
		const read = async (): Promise<ProjectSnapshot> => ({
			baseLocale: direct.baseLocale,
			locales: direct.locales,
			pluginKey: direct.pluginKey,
			snapshot: readDirectSnapshot(direct),
		});
		return {
			read,
			async mutateKeys(plan) {
				const context = await read();
				const { deletions, additions, result } = plan(context);
				for (const locale of direct.locales) {
					mutateDirectLocale(
						direct,
						locale,
						context.snapshot[locale] ?? {},
						additions[locale] ?? {},
						deletions
					);
				}
				return result;
			},
		};
	}

	const read = (project: InlangProject): Promise<ProjectSnapshot> =>
		sdkSnapshot(project);
	return {
		async read() {
			return await withProject(projectPath, read);
		},
		async mutateKeys(plan) {
			return await withProject(projectPath, async (project) => {
				const context = await read(project);
				const { deletions, additions, result } = plan(context);
				const files = Object.entries(additions)
					.filter(([, values]) => Object.keys(values).length > 0)
					.map(([locale, values]) => ({
						locale,
						content: new TextEncoder().encode(
							JSON.stringify(unflatten(values))
						),
					}));
				if (files.length > 0) {
					await project.importFiles({ pluginKey: context.pluginKey, files });
				}
				if (deletions.length > 0) {
					// bundle ids are the message keys; messages/variants cascade
					await project.db
						.deleteFrom("bundle")
						.where("id", "in", deletions)
						.execute();
				}
				if (files.length > 0 || deletions.length > 0) {
					await saveProject(project, projectPath);
				}
				return result;
			});
		},
	};
}

/**
 * Exports all messages via the project's own plugin and flattens each locale
 * file to `key -> value`. Nested keys become dot-joined, exactly like the
 * message format plugin treats them.
 */
async function sdkSnapshot(project: InlangProject): Promise<ProjectSnapshot> {
	const settings = await project.settings.get();
	const pluginKey = await pickPluginKey(project);
	const files = await project.exportFiles({ pluginKey });
	const snapshot: MessagesSnapshot = {};
	for (const file of files) {
		const json = JSON.parse(new TextDecoder().decode(file.content));
		delete json.$schema;
		// safe: true keeps variant arrays intact
		snapshot[file.locale] = flatten(json, { safe: true }) as LocaleMessages;
	}
	return {
		baseLocale: settings.baseLocale,
		locales: settings.locales,
		pluginKey,
		snapshot,
	};
}

/** All message keys present in any locale. */
export function collectKeys(snapshot: MessagesSnapshot): Set<string> {
	const keys = new Set<string>();
	for (const messages of Object.values(snapshot)) {
		for (const key of Object.keys(messages)) {
			keys.add(key);
		}
	}
	return keys;
}
