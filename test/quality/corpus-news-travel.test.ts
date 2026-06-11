import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Self-contained validation of the news and travel corpus files.
// Intentionally does not import test/quality/corpus.ts (built in a parallel PR);
// all assertions are inlined here.

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
	const raw = readFileSync(join(corpusDir, `${name}.json`), "utf8");
	return JSON.parse(raw) as CorpusFile;
}

const cases: Array<{
	category: string;
	expectedLicense: string;
	sourceHost: string;
	attributionPattern: RegExp;
}> = [
	{
		category: "news",
		expectedLicense: "CC BY 2.5",
		sourceHost: "en.wikinews.org",
		// e.g. "Wikinews, 'Story title' (2026-04-24)"
		attributionPattern: /^Wikinews, '.+' \((\d{4})-(\d{2})-\d{2}\)$/,
	},
	{
		category: "travel",
		expectedLicense: "CC BY-SA 3.0",
		sourceHost: "en.wikivoyage.org",
		// e.g. "Wikivoyage, 'Page' (revision 5287811, 2026-06-04)"
		attributionPattern: /^Wikivoyage, '.+' \(revision \d+, (\d{4})-(\d{2})-\d{2}\)$/,
	},
];

// Stories/revisions must be from 2025-06 or later (training-data contamination mitigation).
function assertRecentDate(year: string, month: string, context: string): void {
	const y = Number(year);
	const m = Number(month);
	expect(y * 100 + m, `${context}: date ${year}-${month} must be 2025-06 or later`).toBeGreaterThanOrEqual(202506);
}

for (const { category, expectedLicense, sourceHost, attributionPattern } of cases) {
	describe(`corpus/${category}.json`, () => {
		const corpus = loadCorpus(category);

		it("has valid top-level provenance fields", () => {
			expect(corpus.category).toBe(category);
			expect(corpus.license).toBe(expectedLicense);
			expect(corpus.attribution.length).toBeGreaterThan(0);
			expect(corpus.sourceUrl).toContain(sourceHost);
			expect(corpus.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			assertRecentDate(corpus.retrieved.slice(0, 4), corpus.retrieved.slice(5, 7), "retrieved");
		});

		it("has exactly 10 paragraphs", () => {
			expect(corpus.paragraphs).toHaveLength(10);
		});

		it("has accurate char counts within 200-2500", () => {
			for (const p of corpus.paragraphs) {
				expect(p.chars, p.id).toBe(p.text.length);
				expect(p.chars, p.id).toBeGreaterThanOrEqual(200);
				expect(p.chars, p.id).toBeLessThanOrEqual(2500);
			}
		});

		it("has the required length spread", () => {
			const lengths = corpus.paragraphs.map((p) => p.chars);
			expect(lengths.filter((n) => n < 500).length).toBeGreaterThanOrEqual(2);
			expect(lengths.filter((n) => n > 1200).length).toBeGreaterThanOrEqual(2);
		});

		it("has well-formed, unique ids", () => {
			const ids = new Set<string>();
			for (const p of corpus.paragraphs) {
				expect(p.id).toMatch(new RegExp(`^${category}_[a-z0-9]+_\\d{3}$`));
				ids.add(p.id);
			}
			expect(ids.size).toBe(corpus.paragraphs.length);
		});

		it("has non-empty prose without wiki markup artifacts", () => {
			for (const p of corpus.paragraphs) {
				expect(p.text.trim(), p.id).toBe(p.text);
				expect(p.text, p.id).not.toMatch(/\n/);
				expect(p.text, p.id).not.toMatch(/(\[\[|\]\]|\{\{|\}\}|==|<ref)/);
			}
		});

		it("has per-paragraph attribution with recent dates and source URLs", () => {
			const sources = new Set<string>();
			for (const p of corpus.paragraphs) {
				expect(p.attribution, p.id).toBeDefined();
				expect(p.sourceUrl, p.id).toContain(sourceHost);
				const match = (p.attribution as string).match(attributionPattern);
				expect(match, `${p.id}: attribution '${p.attribution}' must match expected format`).not.toBeNull();
				if (match) {
					assertRecentDate(match[1], match[2], p.id);
				}
				sources.add(p.id.split("_")[1]);
			}
			expect(sources.size, "at least 4 distinct sources").toBeGreaterThanOrEqual(4);
		});
	});
}
