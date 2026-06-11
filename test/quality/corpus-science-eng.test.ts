import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Self-contained validation of the science and engineering corpus files.
// Intentionally does not import test/quality/corpus.ts (built in a parallel PR).

interface CorpusParagraph {
	id: string;
	chars: number;
	text: string;
	attribution?: string;
	sourceUrl?: string;
}

interface CorpusFile {
	category: string;
	license: string;
	attribution: string;
	sourceUrl: string;
	retrieved: string;
	paragraphs: CorpusParagraph[];
}

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), "corpus");

const categories = ["science", "engineering"] as const;

/**
 * Extracts every YYYY-MM occurrence from a string and returns true when at
 * least one is found and all of them are 2025-06 or later.
 */
function datesAreRecent(value: string): boolean {
	const matches = value.match(/\d{4}-\d{2}/g);
	if (!matches || matches.length === 0) {
		return false;
	}
	return matches.every((m) => m >= "2025-06");
}

describe.each(categories)("corpus/%s.json", (category) => {
	const raw = readFileSync(join(corpusDir, `${category}.json`), "utf8");
	const data = JSON.parse(raw) as CorpusFile;

	it("is valid JSON with the expected top-level shape", () => {
		expect(data.category).toBe(category);
		expect(typeof data.license).toBe("string");
		expect(data.license.length).toBeGreaterThan(0);
		expect(typeof data.attribution).toBe("string");
		expect(data.attribution.length).toBeGreaterThan(0);
		expect(typeof data.sourceUrl).toBe("string");
		expect(data.sourceUrl).toMatch(/^https:\/\//);
		expect(Array.isArray(data.paragraphs)).toBe(true);
	});

	it("has exactly 10 paragraphs", () => {
		expect(data.paragraphs).toHaveLength(10);
	});

	it("has unique ids with the correct category/source prefix and numeric suffix", () => {
		const ids = data.paragraphs.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id).toMatch(new RegExp(`^${category}_[a-z0-9_]+_\\d{3}$`));
		}
	});

	it("has chars exactly equal to text.length for every paragraph", () => {
		for (const p of data.paragraphs) {
			expect(p.chars).toBe(p.text.length);
		}
	});

	it("keeps every paragraph between 200 and 2500 chars", () => {
		for (const p of data.paragraphs) {
			expect(p.text.length).toBeGreaterThanOrEqual(200);
			expect(p.text.length).toBeLessThanOrEqual(2500);
		}
	});

	it("has at least 2 paragraphs under 500 chars and at least 2 over 1200 chars", () => {
		const short = data.paragraphs.filter((p) => p.text.length < 500);
		const long = data.paragraphs.filter((p) => p.text.length > 1200);
		expect(short.length).toBeGreaterThanOrEqual(2);
		expect(long.length).toBeGreaterThanOrEqual(2);
	});

	it("contains plain prose without wiki markup or citation brackets", () => {
		for (const p of data.paragraphs) {
			expect(p.text).not.toMatch(/\[\d+\]/);
			expect(p.text).not.toMatch(/\{\{|\}\}|\[\[|\]\]/);
			expect(p.text).not.toMatch(/==+/);
			expect(p.text).not.toMatch(/<[a-z]+[^>]*>/i);
		}
	});

	it("records a retrieved date of 2025-06 or later", () => {
		expect(data.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(datesAreRecent(data.retrieved)).toBe(true);
	});

	it("records recent (2025-06+) attribution dates for every paragraph", () => {
		for (const p of data.paragraphs) {
			const attribution = p.attribution ?? data.attribution;
			expect(attribution.length).toBeGreaterThan(0);
			expect(datesAreRecent(attribution)).toBe(true);
		}
	});

	it("records a valid source URL for every paragraph", () => {
		for (const p of data.paragraphs) {
			const sourceUrl = p.sourceUrl ?? data.sourceUrl;
			expect(sourceUrl).toMatch(/^https:\/\//);
		}
	});
});
