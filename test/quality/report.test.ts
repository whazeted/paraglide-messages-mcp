import { describe, expect, it } from "vitest";
import {
	aggregate,
	decayOnset,
	parseJsonl,
	renderMarkdownReport,
	type MetricFn,
	type RunRow,
} from "./report.js";
import { runRow as makeRow } from "./test-helpers.js";

function toJsonl(rows: RunRow[]): string {
	return rows.map((r) => JSON.stringify(r)).join("\n");
}

/** Error-style metric: higher = worse, read straight off the row. */
const score: MetricFn = (row) => row.outputTokensForItem;

describe("parseJsonl", () => {
	it("parses valid rows and skips blank lines", () => {
		const content = `\n${toJsonl([makeRow(), makeRow({ positionInBatch: 1 })])}\n\n`;
		const result = parseJsonl(content);
		expect(result.rows).toHaveLength(2);
		expect(result.malformed).toHaveLength(0);
		expect(result.rows[1]?.positionInBatch).toBe(1);
	});

	it("collects malformed lines without losing the good ones", () => {
		const good = makeRow();
		const missingField = { ...makeRow() } as Record<string, unknown>;
		delete missingField["budget"];
		const content = [
			JSON.stringify(good),
			"{not json at all",
			JSON.stringify(missingField),
			'["an", "array"]',
			JSON.stringify(makeRow({ positionInBatch: 5 })),
		].join("\n");
		const result = parseJsonl(content);
		expect(result.rows).toHaveLength(2);
		expect(result.malformed).toHaveLength(3);
		expect(result.malformed[0]?.lineNumber).toBe(2);
		expect(result.malformed[0]?.reason).toContain("invalid JSON");
		expect(result.malformed[1]?.reason).toContain('"budget"');
		expect(result.malformed[2]?.reason).toContain("not a JSON object");
	});

	it("rejects rows with wrong field types", () => {
		const badType = { ...makeRow(), warnings: "oops" } as unknown as RunRow;
		const result = parseJsonl(JSON.stringify(badType));
		expect(result.rows).toHaveLength(0);
		expect(result.malformed[0]?.reason).toContain('"warnings"');
	});
});

describe("aggregate", () => {
	it("groups by budget × locale and sorts groups deterministically", () => {
		const rows = [
			makeRow({ budget: 3000, targetLocale: "fr" }),
			makeRow({ budget: 1500, targetLocale: "fr" }),
			makeRow({ budget: 1500, targetLocale: "de" }),
		];
		const groups = aggregate(rows, { score });
		expect(groups.map((g) => `${g.budget}/${g.targetLocale}`)).toEqual([
			"1500/de",
			"1500/fr",
			"3000/fr",
		]);
	});

	it("buckets along both axes and skips null metric scores", () => {
		const rows = [
			makeRow({ positionInBatch: 0, cumulativeOutputTokensAtEmission: 100 }),
			makeRow({ positionInBatch: 1, cumulativeOutputTokensAtEmission: 300 }),
			makeRow({ positionInBatch: 7, cumulativeOutputTokensAtEmission: 700 }),
		];
		const sparse: MetricFn = (row) => (row.positionInBatch === 7 ? null : 1);
		const groups = aggregate(rows, { sparse }, { positionBucketSize: 5, tokenBandSize: 250 });
		const group = groups[0];
		expect(group).toBeDefined();
		expect(group?.positionBuckets.map((b) => b.label)).toEqual(["0–4", "5–9"]);
		expect(group?.tokenBandBuckets.map((b) => b.label)).toEqual([
			"0–249",
			"250–499",
			"500–749",
		]);
		// Row at position 7 scored null: counted in the bucket, not the metric.
		const tail = group?.positionBuckets[1];
		expect(tail?.count).toBe(1);
		expect(tail?.metrics["sparse"]?.n).toBe(0);
	});
});

describe("decayOnset", () => {
	/**
	 * Plant a decay: positions 0–11 oscillate around a flat score of 10,
	 * positions 12–19 rise sharply. With bucket size 1 the onset must land
	 * exactly on the planted bucket.
	 */
	function plantedRows(): RunRow[] {
		const rows: RunRow[] = [];
		for (let pos = 0; pos < 20; pos++) {
			const flat = pos % 2 === 0 ? 9 : 11;
			const value = pos < 12 ? flat : 20 + (pos - 12) * 5;
			rows.push(
				makeRow({
					positionInBatch: pos,
					cumulativeOutputTokensAtEmission: pos * 100,
					outputTokensForItem: value,
				}),
			);
		}
		return rows;
	}

	it("finds the planted onset bucket", () => {
		const groups = aggregate(plantedRows(), { score }, { positionBucketSize: 1 });
		const buckets = groups[0]?.positionBuckets ?? [];
		const onset = decayOnset(buckets, "score");
		expect(onset?.label).toBe("12–12");
	});

	it("returns null on flat data", () => {
		const rows = Array.from({ length: 20 }, (_, pos) =>
			makeRow({ positionInBatch: pos, outputTokensForItem: 10 }),
		);
		const groups = aggregate(rows, { score }, { positionBucketSize: 1 });
		expect(decayOnset(groups[0]?.positionBuckets ?? [], "score")).toBeNull();
	});

	it("returns null when there are not enough buckets for a head", () => {
		const rows = [makeRow({ positionInBatch: 0 }), makeRow({ positionInBatch: 1 })];
		const groups = aggregate(rows, { score }, { positionBucketSize: 1 });
		expect(decayOnset(groups[0]?.positionBuckets ?? [], "score")).toBeNull();
	});

	it("returns null for an unknown metric name", () => {
		const groups = aggregate(plantedRows(), { score }, { positionBucketSize: 1 });
		expect(decayOnset(groups[0]?.positionBuckets ?? [], "nope")).toBeNull();
	});
});

describe("renderMarkdownReport", () => {
	it("renders per-group tables and onset summary lines", () => {
		const rows: RunRow[] = [];
		for (let pos = 0; pos < 20; pos++) {
			rows.push(
				makeRow({
					positionInBatch: pos,
					cumulativeOutputTokensAtEmission: pos * 250,
					outputTokensForItem: pos < 12 ? 10 : 50,
				}),
			);
		}
		const report = renderMarkdownReport(
			aggregate(rows, { score }, { positionBucketSize: 5, tokenBandSize: 250 }),
		);
		expect(report).toContain("# Translation-quality decay report");
		expect(report).toContain("## Budget 1500 · locale de");
		expect(report).toContain("#### By position in batch");
		expect(report).toContain("#### By cumulative output tokens");
		expect(report).toContain("| position | n | score (mean ± sd) |");
		expect(report).toContain("| tokens | n | score (mean ± sd) |");
		expect(report).toContain("**Summary (budget 1500, de)**");
		expect(report).toContain("onset at");
	});

	it("reports 'no onset detected' on flat data", () => {
		const rows = Array.from({ length: 20 }, (_, pos) =>
			makeRow({ positionInBatch: pos, cumulativeOutputTokensAtEmission: pos * 250 }),
		);
		const report = renderMarkdownReport(aggregate(rows, { score }));
		expect(report).toContain("no onset detected");
	});

	it("is deterministic", () => {
		const groups = aggregate(
			[makeRow(), makeRow({ positionInBatch: 3 })],
			{ score },
		);
		expect(renderMarkdownReport(groups)).toBe(renderMarkdownReport(groups));
	});
});
