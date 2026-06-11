import { describe, expect, it } from "vitest";
import {
	bucketByPosition,
	copyThroughRate,
	lengthRatioDrift,
	repetitionScore,
	summarizationOutliers,
	validationFailureRate,
	type BenchmarkRow,
} from "./metrics.js";

/** Build a row with sensible defaults, overridable per test. */
function row(overrides: Partial<BenchmarkRow>): BenchmarkRow {
	const sourceText = overrides.sourceText ?? "Hello world, how are you today?";
	return {
		runId: "run-1",
		budget: 1500,
		targetLocale: "de",
		model: "test-model",
		batchIndex: 0,
		positionInBatch: 0,
		batchItemCount: 10,
		key: "key_0",
		sourceChars: sourceText.length,
		cumulativeOutputTokensAtEmission: 100,
		outputTokensForItem: 50,
		validationStatus: "saved",
		validationErrors: [],
		warnings: [],
		targetText: "Hallo Welt, wie geht es dir heute?",
		sourceText,
		...overrides,
	};
}

describe("copyThroughRate", () => {
	it("returns 0 for an empty input", () => {
		expect(copyThroughRate([]).rate).toBe(0);
	});

	it("counts exact copies", () => {
		const rows = [
			row({ key: "a", sourceText: "Add to cart", targetText: "Add to cart" }),
			row({ key: "b", sourceText: "Add to cart", targetText: "In den Warenkorb" }),
		];
		const result = copyThroughRate(rows);
		expect(result.rate).toBe(0.5);
		expect(result.copies).toBe(1);
		expect(result.total).toBe(2);
		expect(result.copiedKeys).toEqual(["a"]);
	});

	it("treats case and whitespace differences as copies", () => {
		const rows = [
			row({ key: "a", sourceText: "Add to cart", targetText: "  add   TO\ncart " }),
		];
		expect(copyThroughRate(rows).rate).toBe(1);
	});

	it("does not flag genuine translations", () => {
		const rows = [
			row({ key: "a", sourceText: "Add to cart", targetText: "In den Warenkorb legen" }),
		];
		expect(copyThroughRate(rows).rate).toBe(0);
	});
});

describe("lengthRatioDrift", () => {
	it("computes per-locale median ratios", () => {
		const rows = [
			row({ key: "a", sourceText: "aaaa", targetText: "bbbbbbbb" }), // ratio 2
			row({ key: "b", sourceText: "aaaa", targetText: "bbbb" }), // ratio 1
			row({ key: "c", sourceText: "aaaa", targetText: "bbbbbb" }), // ratio 1.5
		];
		const result = lengthRatioDrift(rows);
		expect(result.medianRatioByLocale["de"]).toBeCloseTo(1.5);
		const itemA = result.items.find((i) => i.key === "a");
		expect(itemA?.relativeRatio).toBeCloseTo(2 / 1.5);
	});

	it("detects a downward slope when later items get terser", () => {
		// Targets shrink linearly with position: clear negative drift.
		const rows = [0, 1, 2, 3, 4].map((pos) =>
			row({
				key: `k${pos}`,
				positionInBatch: pos,
				cumulativeOutputTokensAtEmission: 100 * (pos + 1),
				sourceText: "x".repeat(100),
				targetText: "y".repeat(100 - 10 * pos), // ratios 1.0, 0.9, ..., 0.6
			}),
		);
		const result = lengthRatioDrift(rows);
		expect(result.slopeByPosition).not.toBeNull();
		expect(result.slopeByPosition ?? 0).toBeLessThan(0);
		expect(result.slopeByCumulativeTokens ?? 0).toBeLessThan(0);
		// Median ratio is 0.8; raw slope of ratio vs position is -0.1,
		// so relative slope is -0.1 / 0.8 = -0.125.
		expect(result.slopeByPosition).toBeCloseTo(-0.125);
	});

	it("yields a ~zero slope for stable ratios", () => {
		const rows = [0, 1, 2, 3].map((pos) =>
			row({
				key: `k${pos}`,
				positionInBatch: pos,
				sourceText: "x".repeat(100),
				targetText: "y".repeat(110),
			}),
		);
		const result = lengthRatioDrift(rows);
		expect(result.slopeByPosition).toBeCloseTo(0);
	});

	it("returns null slopes when there are not enough points", () => {
		const result = lengthRatioDrift([row({ key: "only" })]);
		expect(result.slopeByPosition).toBeNull();
		expect(result.slopeByCumulativeTokens).toBeNull();
	});

	it("skips rows with empty source text", () => {
		const result = lengthRatioDrift([row({ key: "empty", sourceText: "", targetText: "x" })]);
		expect(result.items).toHaveLength(0);
	});

	it("normalizes per locale independently", () => {
		const rows = [
			row({ key: "de1", targetLocale: "de", sourceText: "aaaa", targetText: "bbbbbbbb" }), // 2
			row({ key: "fr1", targetLocale: "fr", sourceText: "aaaa", targetText: "bb" }), // 0.5
		];
		const result = lengthRatioDrift(rows);
		// Each item IS its locale's median, so both relative ratios are 1.
		expect(result.items.every((i) => Math.abs(i.relativeRatio - 1) < 1e-9)).toBe(true);
	});
});

describe("repetitionScore", () => {
	it("scores 0 within-item repetition for varied text", () => {
		const rows = [row({ key: "a", targetText: "one two three four five six" })];
		expect(repetitionScore(rows).withinItemRepetition).toBe(0);
	});

	it("detects within-item repeated 3-grams", () => {
		// "der text der text der text": tokens = 6 words, 4 trigrams,
		// trigrams: [der text der, text der text, der text der, text der text]
		// unique = 2, repeated fraction = (4 - 2) / 4 = 0.5
		const rows = [row({ key: "a", targetText: "der text der text der text" })];
		expect(repetitionScore(rows).withinItemRepetition).toBeCloseTo(0.5);
	});

	it("detects planted skeleton reuse between adjacent items", () => {
		const skeleton = "klicken sie hier um fortzufahren bitte";
		const rows = [
			row({
				key: "a",
				positionInBatch: 0,
				sourceText: "Press the red button now",
				targetText: skeleton,
			}),
			row({
				key: "b",
				positionInBatch: 1,
				sourceText: "Open the settings page first",
				targetText: skeleton,
			}),
		];
		const result = repetitionScore(rows);
		// Identical 6-word targets share all 5-grams; sources share none.
		expect(result.adjacentSkeletonReuse).toBe(1);
		expect(result.perPairReuse).toEqual([{ prevKey: "a", key: "b", reuse: 1 }]);
	});

	it("scores 0 reuse when adjacent targets share nothing", () => {
		const rows = [
			row({
				key: "a",
				positionInBatch: 0,
				sourceText: "Press the red button now please",
				targetText: "druecken sie jetzt bitte den roten knopf",
			}),
			row({
				key: "b",
				positionInBatch: 1,
				sourceText: "Open the settings page first today",
				targetText: "oeffnen sie heute zuerst die einstellungsseite",
			}),
		];
		expect(repetitionScore(rows).adjacentSkeletonReuse).toBe(0);
	});

	it("excludes verbatim source-shared n-grams from reuse", () => {
		// Both sources and both targets contain the same untranslatable name.
		const phrase = "acme cloud platform enterprise edition pro";
		const rows = [
			row({ key: "a", positionInBatch: 0, sourceText: phrase, targetText: phrase }),
			row({ key: "b", positionInBatch: 1, sourceText: phrase, targetText: phrase }),
		];
		// Every target 5-gram is shared, but every one is also shared by the
		// sources, so the self-conditioning score is 0.
		expect(repetitionScore(rows).adjacentSkeletonReuse).toBe(0);
	});

	it("does not pair items across different batches", () => {
		const skeleton = "klicken sie hier um fortzufahren bitte";
		const rows = [
			row({ key: "a", batchIndex: 0, positionInBatch: 5, targetText: skeleton }),
			row({ key: "b", batchIndex: 1, positionInBatch: 0, targetText: skeleton }),
		];
		expect(repetitionScore(rows).perPairReuse).toHaveLength(0);
	});

	it("handles short texts without n-grams", () => {
		const rows = [
			row({ key: "a", positionInBatch: 0, targetText: "ok" }),
			row({ key: "b", positionInBatch: 1, targetText: "yes" }),
		];
		const result = repetitionScore(rows);
		expect(result.withinItemRepetition).toBe(0);
		expect(result.adjacentSkeletonReuse).toBe(0);
	});
});

describe("summarizationOutliers", () => {
	it("flags an item far below the locale-median length expectation", () => {
		const rows = [
			row({ key: "a", sourceText: "x".repeat(100), targetText: "y".repeat(110) }),
			row({ key: "b", sourceText: "x".repeat(100), targetText: "y".repeat(110) }),
			row({ key: "c", sourceText: "x".repeat(100), targetText: "y".repeat(110) }),
			// Median ratio 1.1; this item's ratio 0.2 => relative 0.18 < 0.5.
			row({ key: "shrunk", positionInBatch: 9, sourceText: "x".repeat(100), targetText: "y".repeat(20) }),
		];
		const outliers = summarizationOutliers(rows);
		expect(outliers).toHaveLength(1);
		expect(outliers[0]?.key).toBe("shrunk");
		expect(outliers[0]?.localeMedianRatio).toBeCloseTo(1.1);
		expect(outliers[0]?.relativeRatio).toBeCloseTo(0.2 / 1.1);
	});

	it("respects a custom threshold", () => {
		const rows = [
			row({ key: "a", sourceText: "x".repeat(100), targetText: "y".repeat(100) }),
			row({ key: "b", sourceText: "x".repeat(100), targetText: "y".repeat(100) }),
			row({ key: "c", sourceText: "x".repeat(100), targetText: "y".repeat(80) }), // relative 0.8
		];
		expect(summarizationOutliers(rows, 0.5)).toHaveLength(0);
		expect(summarizationOutliers(rows, 0.9).map((o) => o.key)).toEqual(["c"]);
	});

	it("returns nothing for an empty input", () => {
		expect(summarizationOutliers([])).toEqual([]);
	});
});

describe("validationFailureRate", () => {
	it("computes the overall failure rate", () => {
		const rows = [
			row({ key: "a", validationStatus: "saved" }),
			row({ key: "b", validationStatus: "rejected" }),
			row({ key: "c", validationStatus: "saved" }),
			row({ key: "d", validationStatus: "skipped" }),
		];
		const result = validationFailureRate(rows);
		expect(result.rate).toBe(0.5);
		expect(result.failures).toBe(2);
		expect(result.total).toBe(4);
	});

	it("buckets failures by relative position (failures in the tail)", () => {
		const rows = [0, 1, 2, 3, 4, 5, 6, 7].map((pos) =>
			row({
				key: `k${pos}`,
				positionInBatch: pos,
				batchItemCount: 8,
				validationStatus: pos >= 6 ? "rejected" : "saved",
			}),
		);
		const result = validationFailureRate(rows, 4);
		expect(result.byPositionBucket).toHaveLength(4);
		expect(result.byPositionBucket[0]?.rate).toBe(0);
		expect(result.byPositionBucket[1]?.rate).toBe(0);
		expect(result.byPositionBucket[2]?.rate).toBe(0);
		expect(result.byPositionBucket[3]?.rate).toBe(1);
		expect(result.byPositionBucket[3]?.failures).toBe(2);
	});

	it("handles empty input", () => {
		const result = validationFailureRate([]);
		expect(result.rate).toBe(0);
		expect(result.byPositionBucket.every((b) => b.rate === 0 && b.total === 0)).toBe(true);
	});
});

describe("bucketByPosition", () => {
	it("splits rows of equal-size batches evenly", () => {
		const rows = [0, 1, 2, 3].map((pos) =>
			row({ key: `k${pos}`, positionInBatch: pos, batchItemCount: 4 }),
		);
		const buckets = bucketByPosition(rows, 2);
		expect(buckets[0]?.map((r) => r.key)).toEqual(["k0", "k1"]);
		expect(buckets[1]?.map((r) => r.key)).toEqual(["k2", "k3"]);
	});

	it("aggregates different batch sizes onto the same relative axis", () => {
		const rows = [
			row({ key: "small-tail", positionInBatch: 3, batchItemCount: 4 }),
			row({ key: "big-tail", positionInBatch: 90, batchItemCount: 100 }),
			row({ key: "big-head", positionInBatch: 2, batchItemCount: 100 }),
		];
		const buckets = bucketByPosition(rows, 2);
		expect(buckets[0]?.map((r) => r.key)).toEqual(["big-head"]);
		expect(buckets[1]?.map((r) => r.key)?.sort()).toEqual(["big-tail", "small-tail"]);
	});

	it("clamps out-of-range positions into the last bucket", () => {
		const rows = [row({ key: "odd", positionInBatch: 10, batchItemCount: 10 })];
		const buckets = bucketByPosition(rows, 3);
		expect(buckets[2]?.map((r) => r.key)).toEqual(["odd"]);
	});

	it("rejects a non-positive bucket count", () => {
		expect(() => bucketByPosition([], 0)).toThrow();
	});
});
