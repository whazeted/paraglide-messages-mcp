import { flatten, unflatten } from "flat";
import type { InlangProject } from "@inlang/sdk";
import {
	readDirectSnapshot,
	resolveDirectProject,
	writeDirectLocale,
} from "./direct.js";
import { pickPluginKey, saveProject, withProject } from "./project.js";
import type {
	LocaleMessages,
	MessagesSnapshot,
	MessageValue,
} from "./types.js";

/** Everything an operation needs to know about the project, loaded fresh. */
export interface ProjectSnapshot {
	baseLocale: string;
	locales: string[];
	pluginKey: string;
	snapshot: MessagesSnapshot;
}

/** What an update decides to persist, plus the value to return to the caller. */
export interface UpdatePlan<T> {
	/** accepted `key -> value` changes for the target locale (may be empty) */
	values: Record<string, MessageValue>;
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
	 * Reads the snapshot, lets `plan` decide what to write for the target
	 * locale, persists those values, and returns the plan's result. Read and
	 * write happen in one storage session so the SDK path loads the project
	 * only once.
	 */
	update<T>(
		targetLocale: string,
		plan: (context: ProjectSnapshot) => UpdatePlan<T>
	): Promise<T>;
}

/**
 * Picks the storage for the project: direct JSON file access for
 * message-format projects (fast — see PERFORMANCE.md and direct.ts), the
 * inlang SDK for everything else. Resolved per call, so settings changes
 * take effect immediately.
 */
export function createStorage(projectPath: string): ProjectStorage {
	const direct = resolveDirectProject(projectPath);
	if (direct) {
		const read = async (): Promise<ProjectSnapshot> => ({
			baseLocale: direct.baseLocale,
			locales: direct.locales,
			pluginKey: direct.pluginKey,
			snapshot: readDirectSnapshot(direct),
		});
		return {
			read,
			async update(targetLocale, plan) {
				const { values, result } = plan(await read());
				if (Object.keys(values).length > 0) {
					writeDirectLocale(direct, targetLocale, values);
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
		async update(targetLocale, plan) {
			return await withProject(projectPath, async (project) => {
				const context = await read(project);
				const { values, result } = plan(context);
				if (Object.keys(values).length > 0) {
					await project.importFiles({
						pluginKey: context.pluginKey,
						files: [
							{
								locale: targetLocale,
								content: new TextEncoder().encode(
									JSON.stringify(unflatten(values))
								),
							},
						],
					});
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
