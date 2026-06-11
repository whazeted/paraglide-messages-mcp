import { describe, expect, it } from "vitest";
import { loadCorpus } from "../corpus.js";

/**
 * Guards the exact code path the benchmark runner takes: loadCorpus() must
 * accept the real vendored corpus. The per-category specs validate each file
 * in isolation; this catches anything only the loader enforces (e.g. the
 * category-matches-filename rule) so a violation fails the suite here
 * instead of aborting a paid benchmark run.
 */
describe("full corpus", () => {
	it("loads all categories through the benchmark's loader", () => {
		const corpus = loadCorpus();
		expect(corpus.map((file) => file.category)).toEqual([
			"children",
			"engineering",
			"fiction",
			"historic",
			"legal",
			"marketing",
			"medical",
			"news",
			"science",
			"travel",
		]);
		expect(corpus.flatMap((file) => file.paragraphs)).toHaveLength(100);
	});
});
