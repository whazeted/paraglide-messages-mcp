import {
	mutateDirectLocale,
	parseDirectProject,
	readDirectSnapshot,
	type DirectProject,
} from "./direct.js";
import type { LocaleMessages, MessagesSnapshot } from "./types.js";

/** Everything an operation needs to know about the project, loaded fresh. */
export interface ProjectSnapshot {
	baseLocale: string;
	/** all project locales from settings, regardless of any read scope */
	locales: string[];
	/** loaded messages — only the scoped locales when a scope was given */
	snapshot: MessagesSnapshot;
}

/** Options for scoping what a read (or a mutation's read) loads. */
export interface ReadOptions {
	/**
	 * Load message data only for these locales (the base locale is always
	 * included). Per-locale operations — the translate loop — pass their
	 * target/source here so a call reads two files instead of every locale's,
	 * which also keeps concurrent per-locale agents from touching each
	 * other's files. `locales` in the snapshot stays the full settings list,
	 * so unknown-locale validation is unaffected.
	 */
	onlyLocales?: string[];
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
 * Reading and writing the project's message files directly (see direct.ts).
 * No translation state lives between calls — reads go through direct.ts's
 * stat-validated file cache, so external edits (compiler, editor, git) are
 * always picked up while unchanged files are parsed only once. All I/O is
 * synchronous: each operation is atomic with respect to concurrent
 * operations in the same process.
 */

// scope -> the locales whose files a call loads (and may write);
// base is always included since validation compares against it
function scopedLocales(
	project: DirectProject,
	options?: ReadOptions
): string[] {
	if (!options?.onlyLocales) return project.locales;
	const scoped = new Set(options.onlyLocales);
	return project.locales.filter(
		(locale) => locale === project.baseLocale || scoped.has(locale)
	);
}

/** Loads a fresh snapshot of the project's messages. */
export function readSnapshot(
	projectPath: string,
	options?: ReadOptions
): ProjectSnapshot {
	const project = parseDirectProject(projectPath);
	return {
		baseLocale: project.baseLocale,
		locales: project.locales,
		snapshot: readDirectSnapshot(project, scopedLocales(project, options)),
	};
}

/**
 * Reads the snapshot, lets `plan` decide which keys to remove and which
 * per-locale values to write, persists both, and returns the plan's result.
 * Only the locale files the plan actually touches are rewritten, and a
 * scoped mutation only ever writes scoped locales' files.
 */
export function mutateKeys<T>(
	projectPath: string,
	plan: (context: ProjectSnapshot) => KeyMutationPlan<T>,
	options?: ReadOptions
): T {
	const project = parseDirectProject(projectPath);
	const locales = scopedLocales(project, options);
	const context: ProjectSnapshot = {
		baseLocale: project.baseLocale,
		locales: project.locales,
		snapshot: readDirectSnapshot(project, locales),
	};
	const { deletions, additions, result } = plan(context);
	for (const locale of locales) {
		mutateDirectLocale(
			project,
			locale,
			context.snapshot[locale] ?? {},
			additions[locale] ?? {},
			deletions
		);
	}
	return result;
}

/** All message keys present in any loaded locale. */
export function collectKeys(snapshot: MessagesSnapshot): Set<string> {
	const keys = new Set<string>();
	for (const messages of Object.values(snapshot)) {
		for (const key of Object.keys(messages)) {
			keys.add(key);
		}
	}
	return keys;
}
