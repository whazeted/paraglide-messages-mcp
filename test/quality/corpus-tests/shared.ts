import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateCorpusFile, type CorpusFile } from "../corpus.js";

/**
 * Shared per-category corpus data checks. Each category test file calls
 * `corpusFileSpec` with the options that differ between categories; the
 * structural rules (paragraph count, chars, length spread, ids, provenance)
 * come from the same `validateCorpusFile` the loader uses, so the data tests
 * can never drift from what `loadCorpus` enforces at benchmark time.
 */
export interface CorpusSpecOptions {
	/**
	 * The category was authored for this fixture (guaranteed absent from
	 * model training sets) — requires original-work license/attribution and
	 * skips the recency rule, which only applies to fetched text.
	 */
	originalWork?: boolean;
	/** Distinct cited pages/documents required (variety of sources). */
	minDistinctSourceUrls?: number;
	/** Every effective sourceUrl must be on one of these hosts. */
	allowedHosts?: string[];
}

const CORPUS_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"corpus"
);

/**
 * Recency floor for fetched text: sources created or substantially revised
 * before 2025-06 are likely in model training data, which the corpus exists
 * to mitigate. Encoded as year*100+month for easy comparison.
 */
const MIN_YEAR_MONTH = 2025 * 100 + 6;

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/**
 * Latest year-month mentioned in a provenance string, tolerant of the
 * formats the corpus uses (ISO `2026-06-10`, prose `January 22, 2026`).
 * The latest date wins because attributions may also cite original
 * publication years ("created 2025-07, revised 2026-06") — the revision is
 * what determines crawl recency.
 */
export function latestYearMonth(text: string): number | null {
	let latest: number | null = null;
	for (const match of text.matchAll(/(\d{4})-(\d{2})/g)) {
		const value = Number(match[1]) * 100 + Number(match[2]);
		if (latest === null || value > latest) latest = value;
	}
	const monthPattern = new RegExp(
		`(${MONTHS.join("|")})\\s+(?:\\d{1,2},\\s+)?(\\d{4})`,
		"g"
	);
	for (const match of text.matchAll(monthPattern)) {
		const value =
			Number(match[2]) * 100 + (MONTHS.indexOf(match[1] ?? "") + 1);
		if (latest === null || value > latest) latest = value;
	}
	return latest;
}

export function corpusFileSpec(
	category: string,
	options: CorpusSpecOptions = {}
): void {
	describe(`corpus: ${category}`, () => {
		const raw = fs.readFileSync(
			path.join(CORPUS_DIR, `${category}.json`),
			"utf8"
		);
		const parsed = JSON.parse(raw) as CorpusFile;

		it("satisfies the structural corpus rules", () => {
			expect(validateCorpusFile(parsed)).toEqual([]);
			expect(parsed.category).toBe(category);
		});

		it("contains plain prose without markup artifacts", () => {
			for (const paragraph of parsed.paragraphs) {
				expect(paragraph.text, paragraph.id).not.toMatch(/\[\d+\]/);
				expect(paragraph.text, paragraph.id).not.toMatch(/\{\{|\}\}/);
				expect(paragraph.text, paragraph.id).not.toMatch(/<\/?[a-z]+[\s>]/i);
			}
		});

		if (options.originalWork) {
			it("is marked as original work", () => {
				expect(parsed.license.toLowerCase()).toContain("original work");
				expect(parsed.attribution.toLowerCase()).toContain("authored");
			});
		} else {
			it("cites sources created or revised on/after 2025-06", () => {
				for (const paragraph of parsed.paragraphs) {
					const provenance = paragraph.attribution ?? parsed.attribution;
					const yearMonth = latestYearMonth(provenance);
					expect(
						yearMonth,
						`${paragraph.id}: no date found in "${provenance}"`
					).not.toBeNull();
					expect(yearMonth, paragraph.id).toBeGreaterThanOrEqual(
						MIN_YEAR_MONTH
					);
				}
			});
		}

		if (options.minDistinctSourceUrls !== undefined) {
			it(`draws on at least ${options.minDistinctSourceUrls} distinct sources`, () => {
				const urls = new Set(
					parsed.paragraphs.map((p) => p.sourceUrl ?? parsed.sourceUrl)
				);
				expect(urls.size).toBeGreaterThanOrEqual(
					options.minDistinctSourceUrls!
				);
			});
		}

		if (options.allowedHosts) {
			it("cites only the expected source hosts", () => {
				for (const paragraph of parsed.paragraphs) {
					const url = new URL(paragraph.sourceUrl ?? parsed.sourceUrl);
					expect(options.allowedHosts, `${paragraph.id}: ${url.host}`).toContain(
						url.host
					);
				}
			});
		}
	});
}
