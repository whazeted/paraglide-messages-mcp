import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface CorpusParagraph {
	id: string;
	chars: number;
	text: string;
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

const categories = ["historic", "fiction"] as const;

for (const category of categories) {
	describe(`corpus/${category}.json`, () => {
		const raw = readFileSync(join(corpusDir, `${category}.json`), "utf8");
		const doc = JSON.parse(raw) as CorpusFile;

		it("declares the expected category", () => {
			expect(doc.category).toBe(category);
		});

		it("is marked as original work (no training-data contamination)", () => {
			expect(doc.license).toBe("MIT (original work)");
			expect(doc.attribution).toContain("Original text authored for this fixture");
		});

		it("has source and retrieval metadata", () => {
			expect(doc.sourceUrl).toBe("https://github.com/WesHaze/paraglide-mcp");
			expect(doc.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it("contains exactly 10 paragraphs", () => {
			expect(Array.isArray(doc.paragraphs)).toBe(true);
			expect(doc.paragraphs).toHaveLength(10);
		});

		it("uses sequential ids with the category prefix", () => {
			doc.paragraphs.forEach((p, i) => {
				expect(p.id).toBe(`${category}_original_${String(i + 1).padStart(3, "0")}`);
			});
		});

		it("has chars equal to text.length for every paragraph", () => {
			for (const p of doc.paragraphs) {
				expect(p.chars).toBe(p.text.length);
			}
		});

		it("keeps every paragraph within 200-2500 chars", () => {
			for (const p of doc.paragraphs) {
				expect(p.chars).toBeGreaterThanOrEqual(200);
				expect(p.chars).toBeLessThanOrEqual(2500);
			}
		});

		it("has the required length spread (>=2 under 500, >=2 over 1200)", () => {
			const under500 = doc.paragraphs.filter((p) => p.chars < 500).length;
			const over1200 = doc.paragraphs.filter((p) => p.chars > 1200).length;
			expect(under500).toBeGreaterThanOrEqual(2);
			expect(over1200).toBeGreaterThanOrEqual(2);
		});

		it("has non-empty, non-duplicated text", () => {
			const texts = new Set(doc.paragraphs.map((p) => p.text));
			expect(texts.size).toBe(doc.paragraphs.length);
			for (const p of doc.paragraphs) {
				expect(p.text.trim().length).toBeGreaterThan(0);
			}
		});
	});
}
