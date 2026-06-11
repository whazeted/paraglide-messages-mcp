import { describe, expect, it } from "vitest";
import {
	buildTier1Metrics,
	collectMetricOnsets,
	evaluateGates,
	recommendDefault,
	type MetricOnset,
} from "./calibration.js";
import { aggregate, type RunRow } from "./report.js";

function row(overrides: Partial<RunRow> = {}): RunRow {
	const sourceText = overrides.sourceText ?? "The system saved the document.";
	return {
		runId: "run-1",
		budget: 1500,
		targetLocale: "de",
		model: "test-model",
		batchIndex: 0,
		positionInBatch: 0,
		batchItemCount: 20,
		key: "key_001",
		sourceChars: sourceText.length,
		cumulativeOutputTokensAtEmission: 100,
		outputTokensForItem: 20,
		validationStatus: "saved",
		validationErrors: [],
		warnings: [],
		targetText: "Das System hat das Dokument gespeichert.",
		sourceText,
		...overrides,
	};
}

function passingGateInput() {
	return {
		activeJudgeCount: 1,
		anchorResults: [
			{
				judge: "judge-a",
				recall: 0.9,
				goodFalseAlarmRate: 0.1,
				defectCount: 80,
			},
		],
		selfConsistencyResults: [
			{ judge: "judge-a", score: 0.9, sampleCount: 20 },
		],
		crossJudgeAgreements: [],
		pairwiseResults: [
			{
				judge: "judge-a",
				total: 25,
				headWins: 10,
				tailWins: 10,
				ties: 5,
				headWinRate: 0.5,
				positionAWinRate: 0.5,
			},
		],
	};
}

describe("evaluateGates", () => {
	it("passes a one-judge run with valid anchor, consistency, and pairwise gates", () => {
		const result = evaluateGates(passingGateInput());
		expect(result.admissible).toBe(true);
		expect(result.gates.crossJudgeAgreement.status).toBe("not_applicable");
	});

	it("fails dry/no-judge runs", () => {
		const result = evaluateGates({
			...passingGateInput(),
			activeJudgeCount: 0,
			anchorResults: [],
			selfConsistencyResults: [],
			pairwiseResults: [],
		});
		expect(result.admissible).toBe(false);
		expect(result.gates.activeJudge.status).toBe("fail");
		expect(result.gates.anchorRecall.status).toBe("inconclusive");
	});

	it("fails pairwise position bias outside the allowed A-slot range", () => {
		const input = passingGateInput();
		input.pairwiseResults = [
			{
				...input.pairwiseResults[0]!,
				headWins: 18,
				tailWins: 2,
				positionAWinRate: 0.9,
			},
		];
		const result = evaluateGates(input);
		expect(result.admissible).toBe(false);
		expect(result.gates.pairwisePositionBias.status).toBe("fail");
	});

	it("requires sufficient decisive pairwise verdicts", () => {
		const input = passingGateInput();
		input.pairwiseResults = [
			{
				...input.pairwiseResults[0]!,
				headWins: 5,
				tailWins: 5,
				ties: 15,
			},
		];
		const result = evaluateGates(input);
		expect(result.admissible).toBe(false);
		expect(result.gates.pairwisePositionBias.detail).toContain("10 decisive");
	});

	it("fails a multi-judge run when kappa is below threshold", () => {
		const result = evaluateGates({
			...passingGateInput(),
			activeJudgeCount: 2,
			anchorResults: [
				...passingGateInput().anchorResults,
				{
					judge: "judge-b",
					recall: 0.95,
					goodFalseAlarmRate: 0.05,
					defectCount: 80,
				},
			],
			selfConsistencyResults: [
				...passingGateInput().selfConsistencyResults,
				{ judge: "judge-b", score: 0.95, sampleCount: 20 },
			],
			crossJudgeAgreements: [
				{
					judges: ["judge-a", "judge-b"],
					agreement: 0.6,
					kappa: 0.25,
				},
			],
			pairwiseResults: [
				...passingGateInput().pairwiseResults,
				{
					judge: "judge-b",
					total: 25,
					headWins: 10,
					tailWins: 10,
					ties: 5,
					headWinRate: 0.5,
					positionAWinRate: 0.5,
				},
			],
		});
		expect(result.admissible).toBe(false);
		expect(result.gates.crossJudgeAgreement.status).toBe("fail");
	});
});

describe("recommendDefault", () => {
	const onsets: MetricOnset[] = [
		{ budget: 750, targetLocale: "de", metric: "copyThrough", onset: null },
		{ budget: 750, targetLocale: "ja", metric: "copyThrough", onset: null },
		{ budget: 1500, targetLocale: "de", metric: "copyThrough", onset: null },
		{ budget: 1500, targetLocale: "ja", metric: "copyThrough", onset: null },
		{ budget: 3000, targetLocale: "de", metric: "copyThrough", onset: "1000–1249" },
		{ budget: 3000, targetLocale: "ja", metric: "copyThrough", onset: null },
		{ budget: 0, targetLocale: "de", metric: "copyThrough", onset: null },
		{ budget: 0, targetLocale: "ja", metric: "copyThrough", onset: null },
	];

	it("selects the largest safe nonzero budget and ignores budget 0", () => {
		const result = recommendDefault({
			model: "translator-a",
			admissible: true,
			metricOnsets: onsets,
			budgets: [750, 1500, 3000, 0],
		});
		expect(result.recommendedDefault).toBe(1500);
		expect(result.safeBudgets).toEqual([750, 1500]);
	});

	it("emits no recommendation for inadmissible runs", () => {
		const result = recommendDefault({
			model: "translator-a",
			admissible: false,
			metricOnsets: onsets,
			budgets: [750, 1500, 3000, 0],
		});
		expect(result.recommendedDefault).toBeNull();
		expect(result.reason).toContain("not admissible");
	});

	it("emits no recommendation when every nonzero budget has an onset", () => {
		const result = recommendDefault({
			model: "translator-a",
			admissible: true,
			metricOnsets: [
				{ budget: 750, targetLocale: "de", metric: "failed", onset: "250–499" },
				{ budget: 1500, targetLocale: "de", metric: "failed", onset: "250–499" },
			],
			budgets: [750, 1500, 0],
		});
		expect(result.recommendedDefault).toBeNull();
		expect(result.reason).toContain("no nonzero");
	});
});

describe("buildTier1Metrics / collectMetricOnsets", () => {
	it("exposes row-level mechanical metrics", () => {
		const rows = [
			row({ key: "copy", sourceText: "Save changes", targetText: "save   changes" }),
			row({ key: "fail", validationStatus: "rejected" }),
		];
		const metrics = buildTier1Metrics(rows);
		expect(metrics.copyThrough!(rows[0]!)).toBe(1);
		expect(metrics.validationFailure!(rows[1]!)).toBe(1);
		expect(metrics).toHaveProperty("repetition");
		expect(metrics).toHaveProperty("summarizationOutlier");
	});

	it("collects per-budget metric onsets", () => {
		const rows = Array.from({ length: 8 }, (_, pos) =>
			row({
				positionInBatch: pos,
				cumulativeOutputTokensAtEmission: pos * 250,
				outputTokensForItem: pos < 4 ? 1 : 20,
			})
		);
		const aggregates = aggregate(rows, {
			score: (r) => r.outputTokensForItem,
		});
		const onsets = collectMetricOnsets(aggregates, ["score"]);
		expect(onsets).toHaveLength(1);
		expect(onsets[0]?.metric).toBe("score");
	});
});
