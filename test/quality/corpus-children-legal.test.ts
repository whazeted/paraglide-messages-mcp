import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Self-contained assertions for the children + legal corpus fixtures.
// Intentionally does NOT import any shared corpus helper (built in a parallel PR).

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), "corpus");

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

function loadCorpus(name: string): CorpusFile {
	const raw = readFileSync(join(corpusDir, name), "utf8");
	return JSON.parse(raw) as CorpusFile;
}

function assertCommonShape(corpus: CorpusFile, category: string, idPrefix: RegExp): void {
	expect(corpus.category).toBe(category);
	expect(corpus.license.length).toBeGreaterThan(0);
	expect(corpus.attribution.length).toBeGreaterThan(0);
	expect(corpus.sourceUrl).toMatch(/^https:\/\//);
	expect(corpus.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);

	expect(corpus.paragraphs).toHaveLength(10);

	const ids = new Set<string>();
	for (const paragraph of corpus.paragraphs) {
		expect(paragraph.id).toMatch(idPrefix);
		expect(ids.has(paragraph.id)).toBe(false);
		ids.add(paragraph.id);

		expect(typeof paragraph.text).toBe("string");
		expect(paragraph.chars).toBe(paragraph.text.length);
		expect(paragraph.chars).toBeGreaterThanOrEqual(200);
		expect(paragraph.chars).toBeLessThanOrEqual(2500);

		// Plain prose: no leftover markup, no internal line breaks.
		expect(paragraph.text).not.toMatch(/[<>]/);
		expect(paragraph.text).not.toMatch(/\n/);
		expect(paragraph.text.trim()).toBe(paragraph.text);
	}

	const under500 = corpus.paragraphs.filter((p) => p.chars < 500);
	const over1200 = corpus.paragraphs.filter((p) => p.chars > 1200);
	expect(under500.length).toBeGreaterThanOrEqual(2);
	expect(over1200.length).toBeGreaterThanOrEqual(2);
}

describe("corpus/children.json", () => {
	const corpus = loadCorpus("children.json");

	it("is valid JSON with the expected shape and length spread", () => {
		assertCommonShape(corpus, "children", /^children_original_\d{3}$/);
	});

	it("is marked as original work (contamination mitigation)", () => {
		expect(corpus.license).toBe("MIT (original work)");
		expect(corpus.attribution.toLowerCase()).toContain("original");
		expect(corpus.attribution).toContain("2026");
	});
});

describe("corpus/legal.json", () => {
	const corpus = loadCorpus("legal.json");

	it("is valid JSON with the expected shape and length spread", () => {
		assertCommonShape(corpus, "legal", /^legal_[a-z0-9]+_\d{3}$/);
	});

	it("is public-domain US government work with provenance", () => {
		expect(corpus.license).toBe("Public domain (US government work)");
		expect(corpus.attribution.length).toBeGreaterThan(0);
	});

	it("cites recent documents (published 2025-06 or later)", () => {
		// Top-level retrieved date and per-paragraph publication dates must be recent.
		const cutoff = "2025-06";
		expect(corpus.retrieved >= cutoff).toBe(true);

		const attributions = [corpus.attribution, ...corpus.paragraphs.map((p) => p.attribution ?? "")];
		const dates = attributions.flatMap((a) => a.match(/\d{4}-\d{2}-\d{2}/g) ?? []);
		expect(dates.length).toBeGreaterThan(0);
		for (const date of dates) {
			expect(date >= cutoff).toBe(true);
		}
	});

	it("draws from at least three distinct source documents", () => {
		const sources = new Set(
			corpus.paragraphs.map((p) => {
				const match = p.id.match(/^legal_([a-z0-9]+)_\d{3}$/);
				expect(match).not.toBeNull();
				return match![1];
			}),
		);
		expect(sources.size).toBeGreaterThanOrEqual(3);

		for (const paragraph of corpus.paragraphs) {
			expect(paragraph.attribution ?? corpus.attribution).toMatch(/\d{4}-\d{2}-\d{2}/);
			expect(paragraph.sourceUrl ?? corpus.sourceUrl).toMatch(/^https:\/\//);
		}
	});
});
