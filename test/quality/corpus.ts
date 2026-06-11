import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scaffoldProject, type FixtureProject } from "../helpers.js";

/**
 * One paragraph of benchmark prose. `chars` is stored redundantly with the
 * text so reviewers (and diffs) can see length distribution at a glance —
 * validation cross-checks it against `text.length` to catch silent edits.
 */
export interface CorpusParagraph {
	id: string;
	chars: number;
	text: string;
}

/**
 * One corpus category file (`test/quality/corpus/<category>.json`). The
 * provenance fields (license/attribution/sourceUrl/retrieved) exist because
 * the corpus text carries its own source licenses, distinct from the repo's
 * MIT code license — see test/quality/corpus/README.md.
 */
export interface CorpusFile {
	category: string;
	license: string;
	attribution: string;
	sourceUrl: string;
	retrieved: string;
	paragraphs: CorpusParagraph[];
}

const PARAGRAPHS_PER_FILE = 10;
const MIN_CHARS = 200;
const MAX_CHARS = 2500;
const SHORT_THRESHOLD = 500;
const LONG_THRESHOLD = 1200;
const MIN_SHORT = 2;
const MIN_LONG = 2;

/**
 * Validates a parsed corpus JSON object and returns a list of human-readable
 * violations (empty when valid). Returns strings rather than throwing so
 * `loadCorpus` can aggregate problems across all files into one error — the
 * corpus is authored by many parallel contributors and a single run should
 * surface every mistake at once.
 */
export function validateCorpusFile(parsed: unknown): string[] {
	const violations: string[] = [];

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return ["corpus file must be a JSON object"];
	}
	const file = parsed as Record<string, unknown>;

	const category = file["category"];
	if (typeof category !== "string" || category.length === 0) {
		violations.push("category must be a non-empty string");
	}
	for (const field of ["license", "attribution", "sourceUrl", "retrieved"]) {
		const value = file[field];
		if (typeof value !== "string" || value.trim().length === 0) {
			violations.push(`${field} must be a non-empty string`);
		}
	}

	const paragraphs = file["paragraphs"];
	if (!Array.isArray(paragraphs)) {
		violations.push("paragraphs must be an array");
		return violations;
	}
	if (paragraphs.length !== PARAGRAPHS_PER_FILE) {
		violations.push(
			`expected exactly ${PARAGRAPHS_PER_FILE} paragraphs, found ${paragraphs.length}`
		);
	}

	/*
	 * Paragraph ids must be `<category>_<source>_<nnn>` so the server's
	 * prefix-locality batching groups paragraphs of the same category — the
	 * benchmark relies on that grouping to fill batches with related text.
	 */
	const idPattern =
		typeof category === "string" && category.length > 0
			? new RegExp(
					`^${category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_[a-z0-9]+_\\d{3}$`
				)
			: null;

	let shortCount = 0;
	let longCount = 0;
	const seenIds = new Set<string>();
	paragraphs.forEach((entry: unknown, index: number) => {
		const label = `paragraphs[${index}]`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			violations.push(`${label} must be an object`);
			return;
		}
		const paragraph = entry as Record<string, unknown>;
		const id = paragraph["id"];
		const chars = paragraph["chars"];
		const text = paragraph["text"];

		if (typeof id !== "string" || id.length === 0) {
			violations.push(`${label}.id must be a non-empty string`);
		} else {
			if (idPattern && !idPattern.test(id)) {
				violations.push(
					`${label}.id "${id}" must match <category>_<source>_<nnn> and start with "${category}_"`
				);
			}
			/*
			 * Ids become message keys in buildCorpusProject — a duplicate would
			 * silently overwrite a paragraph and shrink the benchmark corpus.
			 */
			if (seenIds.has(id)) {
				violations.push(`${label}.id "${id}" is a duplicate`);
			}
			seenIds.add(id);
		}

		if (typeof text !== "string" || text.length === 0) {
			violations.push(`${label}.text must be a non-empty string`);
			return;
		}
		if (typeof chars !== "number" || chars !== text.length) {
			violations.push(
				`${label}.chars (${String(chars)}) must equal text.length (${text.length})`
			);
		}
		if (text.length < MIN_CHARS || text.length > MAX_CHARS) {
			violations.push(
				`${label}.text length ${text.length} outside ${MIN_CHARS}-${MAX_CHARS} chars`
			);
		}
		if (text.length < SHORT_THRESHOLD) shortCount += 1;
		if (text.length > LONG_THRESHOLD) longCount += 1;
	});

	/*
	 * The length-spread rule guarantees every category exercises both the
	 * short-message and long-message regimes — without it a category could
	 * cluster around one length and tell us nothing about decay.
	 */
	if (shortCount < MIN_SHORT) {
		violations.push(
			`need at least ${MIN_SHORT} paragraphs under ${SHORT_THRESHOLD} chars, found ${shortCount}`
		);
	}
	if (longCount < MIN_LONG) {
		violations.push(
			`need at least ${MIN_LONG} paragraphs over ${LONG_THRESHOLD} chars, found ${longCount}`
		);
	}

	return violations;
}

const DEFAULT_CORPUS_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"corpus"
);

/**
 * Loads and validates every `*.json` corpus file in `dir`. Throws a single
 * error listing all violations across all files. Tolerates a missing or
 * empty directory (returns []) because the category data files land in
 * parallel PRs and infra must not break the suite before they merge.
 */
export function loadCorpus(dir: string = DEFAULT_CORPUS_DIR): CorpusFile[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	const files = fs
		.readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort();

	const corpus: CorpusFile[] = [];
	const violations: string[] = [];
	for (const name of files) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
		} catch (error) {
			violations.push(`${name}: invalid JSON (${(error as Error).message})`);
			continue;
		}
		const fileViolations = validateCorpusFile(parsed);
		if (fileViolations.length > 0) {
			violations.push(...fileViolations.map((v) => `${name}: ${v}`));
			continue;
		}
		const file = parsed as CorpusFile;
		const expectedCategory = name.replace(/\.json$/, "");
		if (file.category !== expectedCategory) {
			violations.push(
				`${name}: category "${file.category}" does not match filename "${expectedCategory}"`
			);
			continue;
		}
		corpus.push(file);
	}

	if (violations.length > 0) {
		throw new Error(
			`Corpus validation failed:\n${violations.map((v) => `  - ${v}`).join("\n")}`
		);
	}
	return corpus;
}

/**
 * Builds a temp Paraglide project whose base-locale (`en`) messages are the
 * corpus paragraphs keyed by paragraph id. Because ids share their category
 * prefix, the server's prefix-locality batching keeps category text together
 * — the benchmark depends on that to form realistic batches. Non-base
 * locales start empty so the benchmark measures translation from scratch.
 */
export function buildCorpusProject(
	corpus: CorpusFile[],
	locales: string[]
): FixtureProject {
	const baseLocale = "en";
	const allLocales = locales.includes(baseLocale)
		? locales
		: [baseLocale, ...locales];

	const enMessages: Record<string, unknown> = {};
	for (const file of corpus) {
		for (const paragraph of file.paragraphs) {
			enMessages[paragraph.id] = paragraph.text;
		}
	}

	const messages: Record<string, Record<string, unknown>> = {};
	for (const locale of allLocales) {
		messages[locale] = locale === baseLocale ? enMessages : {};
	}

	return scaffoldProject({ baseLocale, locales: allLocales, messages });
}
