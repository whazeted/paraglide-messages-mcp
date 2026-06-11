import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

function assertCommonInvariants(corpus: CorpusFile, idPattern: RegExp): void {
	expect(corpus.license.length).toBeGreaterThan(0);
	expect(corpus.attribution.length).toBeGreaterThan(0);
	expect(corpus.sourceUrl).toMatch(/^https:\/\//);
	expect(corpus.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);

	expect(corpus.paragraphs).toHaveLength(10);

	const ids = new Set<string>();
	for (const paragraph of corpus.paragraphs) {
		expect(paragraph.id).toMatch(idPattern);
		expect(ids.has(paragraph.id)).toBe(false);
		ids.add(paragraph.id);

		expect(paragraph.chars).toBe(paragraph.text.length);
		expect(paragraph.chars).toBeGreaterThanOrEqual(200);
		expect(paragraph.chars).toBeLessThanOrEqual(2500);

		// Plain prose: no markup, no list markers, no heading syntax.
		expect(paragraph.text).not.toMatch(/<[a-z][^>]*>/i);
		expect(paragraph.text).not.toMatch(/^[#*•-]\s/);
		expect(paragraph.text).not.toMatch(/\n/);
	}

	const under500 = corpus.paragraphs.filter((p) => p.chars < 500);
	const over1200 = corpus.paragraphs.filter((p) => p.chars > 1200);
	expect(under500.length).toBeGreaterThanOrEqual(2);
	expect(over1200.length).toBeGreaterThanOrEqual(2);
}

describe("corpus/medical.json", () => {
	const corpus = loadCorpus("medical.json");

	it("satisfies the shared corpus invariants", () => {
		assertCommonInvariants(corpus, /^medical_[a-z]+_\d{3}$/);
	});

	it("has medical category and public-domain provenance", () => {
		expect(corpus.category).toBe("medical");
		expect(corpus.license).toBe("Public domain (US government work)");
		expect(corpus.sourceUrl).toContain("medlineplus.gov");
	});

	it("cites at least 3 distinct source pages, each reviewed 2025-06 or later", () => {
		const monthNumber: Record<string, number> = {
			January: 1,
			February: 2,
			March: 3,
			April: 4,
			May: 5,
			June: 6,
			July: 7,
			August: 8,
			September: 9,
			October: 10,
			November: 11,
			December: 12,
		};
		const sourceUrls = new Set<string>();
		for (const paragraph of corpus.paragraphs) {
			expect(paragraph.sourceUrl).toMatch(/^https:\/\/medlineplus\.gov\//);
			expect(paragraph.attribution?.length ?? 0).toBeGreaterThan(0);
			sourceUrls.add(paragraph.sourceUrl as string);

			const match = /last (?:updated|reviewed|revised) ([A-Z][a-z]+) (\d{1,2}), (\d{4})/.exec(
				paragraph.attribution as string,
			);
			expect(match).not.toBeNull();
			const [, monthName, , yearText] = match as RegExpExecArray;
			const year = Number(yearText);
			const month = monthNumber[monthName];
			expect(month).toBeGreaterThanOrEqual(1);
			expect(year * 100 + month).toBeGreaterThanOrEqual(2025 * 100 + 6);
		}
		expect(sourceUrls.size).toBeGreaterThanOrEqual(3);
	});
});

describe("corpus/marketing.json", () => {
	const corpus = loadCorpus("marketing.json");

	it("satisfies the shared corpus invariants", () => {
		assertCommonInvariants(corpus, /^marketing_original_\d{3}$/);
	});

	it("has marketing category and is marked as original work", () => {
		expect(corpus.category).toBe("marketing");
		expect(corpus.license).toBe("MIT (original work)");
		expect(corpus.attribution).toBe("Original text authored for this fixture, 2026");
	});
});
