import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeFixture } from "../helpers.js";
import {
	buildCorpusProject,
	loadCorpus,
	validateCorpusFile,
	type CorpusFile,
} from "./corpus.js";

/**
 * Inline sample builders rather than real corpus JSON: the data files land
 * in parallel PRs, so these tests must pass with an empty corpus directory.
 */
function sampleText(length: number): string {
	return "x".repeat(length);
}

function sampleParagraph(category: string, index: number, length: number) {
	const text = sampleText(length);
	return {
		id: `${category}_sample_${String(index + 1).padStart(3, "0")}`,
		chars: text.length,
		text,
	};
}

/** Valid file: 10 paragraphs, 3 short (<500), 3 long (>1200), rest mid. */
function sampleCorpusFile(category = "fiction"): CorpusFile {
	const lengths = [250, 300, 450, 700, 800, 900, 1000, 1300, 1500, 2000];
	return {
		category,
		license: "Public domain",
		attribution: "Sample text generated for unit tests, 2026 revision",
		sourceUrl: "https://example.com/sample",
		retrieved: "2026-06-11",
		paragraphs: lengths.map((length, index) =>
			sampleParagraph(category, index, length)
		),
	};
}

describe("validateCorpusFile", () => {
	it("accepts a valid corpus file", () => {
		expect(validateCorpusFile(sampleCorpusFile())).toEqual([]);
	});

	it("rejects non-object input", () => {
		expect(validateCorpusFile(null)).toHaveLength(1);
		expect(validateCorpusFile([])).toHaveLength(1);
		expect(validateCorpusFile("nope")).toHaveLength(1);
	});

	it("rejects a file without exactly 10 paragraphs", () => {
		const file = sampleCorpusFile();
		file.paragraphs = file.paragraphs.slice(0, 9);
		expect(validateCorpusFile(file)).toContainEqual(
			expect.stringContaining("exactly 10 paragraphs")
		);
	});

	it("rejects a chars/text.length mismatch", () => {
		const file = sampleCorpusFile();
		file.paragraphs[0]!.chars = 999;
		expect(validateCorpusFile(file)).toContainEqual(
			expect.stringContaining("must equal text.length")
		);
	});

	it("rejects ids that do not start with the file's category", () => {
		const file = sampleCorpusFile();
		file.paragraphs[0]!.id = "legal_sample_001";
		expect(validateCorpusFile(file)).toContainEqual(
			expect.stringContaining('start with "fiction_"')
		);
	});

	it("rejects ids that do not match <category>_<source>_<nnn>", () => {
		const file = sampleCorpusFile();
		file.paragraphs[0]!.id = "fiction_sample_1"; // nnn must be 3 digits
		expect(validateCorpusFile(file)).toContainEqual(
			expect.stringContaining("<category>_<source>_<nnn>")
		);
	});

	it("rejects paragraphs outside the 200-2500 char range", () => {
		const tooShort = sampleCorpusFile();
		const shortParagraph = sampleParagraph("fiction", 0, 150);
		tooShort.paragraphs[0] = shortParagraph;
		expect(validateCorpusFile(tooShort)).toContainEqual(
			expect.stringContaining("outside 200-2500")
		);

		const tooLong = sampleCorpusFile();
		tooLong.paragraphs[9] = sampleParagraph("fiction", 9, 2600);
		expect(validateCorpusFile(tooLong)).toContainEqual(
			expect.stringContaining("outside 200-2500")
		);
	});

	it("rejects a file with fewer than 2 short paragraphs", () => {
		const file = sampleCorpusFile();
		// Lift two of the three short paragraphs above the 500-char threshold.
		file.paragraphs[0] = sampleParagraph("fiction", 0, 600);
		file.paragraphs[1] = sampleParagraph("fiction", 1, 600);
		expect(validateCorpusFile(file)).toContainEqual(
			expect.stringContaining("under 500 chars")
		);
	});

	it("rejects a file with fewer than 2 long paragraphs", () => {
		const file = sampleCorpusFile();
		file.paragraphs[7] = sampleParagraph("fiction", 7, 1100);
		file.paragraphs[8] = sampleParagraph("fiction", 8, 1100);
		expect(validateCorpusFile(file)).toContainEqual(
			expect.stringContaining("over 1200 chars")
		);
	});

	it("rejects duplicate paragraph ids", () => {
		const file = sampleCorpusFile();
		file.paragraphs[1]!.id = file.paragraphs[0]!.id;
		expect(validateCorpusFile(file)).toContainEqual(
			expect.stringContaining("is a duplicate")
		);
	});

	it("rejects empty provenance fields", () => {
		const file = sampleCorpusFile();
		file.license = "";
		file.attribution = "   ";
		const violations = validateCorpusFile(file);
		expect(violations).toContainEqual(
			expect.stringContaining("license must be a non-empty string")
		);
		expect(violations).toContainEqual(
			expect.stringContaining("attribution must be a non-empty string")
		);
	});

	it("collects multiple violations in one pass", () => {
		const file = sampleCorpusFile();
		file.sourceUrl = "";
		file.paragraphs[0]!.chars = 1;
		expect(validateCorpusFile(file).length).toBeGreaterThanOrEqual(2);
	});
});

describe("loadCorpus", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	function makeTempDir(): string {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-test-"));
		return tempDir;
	}

	it("returns [] for a missing directory", () => {
		expect(loadCorpus(path.join(os.tmpdir(), "corpus-does-not-exist"))).toEqual(
			[]
		);
	});

	it("returns [] for a directory with no JSON files", () => {
		const dir = makeTempDir();
		fs.writeFileSync(path.join(dir, "README.md"), "# not corpus data");
		expect(loadCorpus(dir)).toEqual([]);
	});

	it("loads valid corpus files sorted by filename", () => {
		const dir = makeTempDir();
		for (const category of ["legal", "fiction"]) {
			fs.writeFileSync(
				path.join(dir, `${category}.json`),
				JSON.stringify(sampleCorpusFile(category))
			);
		}
		const corpus = loadCorpus(dir);
		expect(corpus.map((file) => file.category)).toEqual(["fiction", "legal"]);
		expect(corpus[0]!.paragraphs).toHaveLength(10);
	});

	it("throws listing violations from every invalid file", () => {
		const dir = makeTempDir();
		const broken = sampleCorpusFile("legal");
		broken.paragraphs = broken.paragraphs.slice(0, 5);
		fs.writeFileSync(path.join(dir, "legal.json"), JSON.stringify(broken));
		fs.writeFileSync(path.join(dir, "tech.json"), "{ not json");
		expect(() => loadCorpus(dir)).toThrowError(/legal\.json[\s\S]*tech\.json/);
	});

	it("throws when category does not match the filename", () => {
		const dir = makeTempDir();
		fs.writeFileSync(
			path.join(dir, "legal.json"),
			JSON.stringify(sampleCorpusFile("fiction"))
		);
		expect(() => loadCorpus(dir)).toThrowError(/does not match filename/);
	});
});

describe("buildCorpusProject", () => {
	it("builds a project with corpus paragraphs as en messages and empty targets", () => {
		const corpus = [sampleCorpusFile("fiction"), sampleCorpusFile("legal")];
		const project = buildCorpusProject(corpus, ["en", "de", "fr"]);
		try {
			const en = project.readMessages("en");
			expect(en["fiction_sample_001"]).toBe(
				corpus[0]!.paragraphs[0]!.text
			);
			expect(en["legal_sample_010"]).toBe(
				corpus[1]!.paragraphs[9]!.text
			);
			// 20 paragraphs + the $schema key.
			expect(Object.keys(en)).toHaveLength(21);

			const de = project.readMessages("de");
			expect(Object.keys(de)).toEqual(["$schema"]);
		} finally {
			removeFixture(project.rootDir);
		}
	});

	it("always includes the en base locale", () => {
		const project = buildCorpusProject([sampleCorpusFile()], ["de"]);
		try {
			expect(project.readMessages("en")["fiction_sample_001"]).toBeDefined();
			expect(project.readMessages("de")).toBeDefined();
		} finally {
			removeFixture(project.rootDir);
		}
	});
});
