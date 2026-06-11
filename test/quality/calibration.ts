import {
	repetitionScore,
	summarizationOutliers,
	type BenchmarkRow,
} from "./metrics.js";
import {
	decayOnset,
	type GroupAggregate,
	type MetricFn,
	type RunRow,
} from "./report.js";

export const ANCHOR_RECALL_MIN = 0.8;
export const GOOD_FALSE_ALARM_MAX = 0.2;
export const SELF_CONSISTENCY_MIN = 0.85;
export const CROSS_JUDGE_KAPPA_MIN = 0.4;
export const POSITION_A_WIN_RATE_MIN = 0.4;
export const POSITION_A_WIN_RATE_MAX = 0.6;
export const MIN_PAIRWISE_DECISIVE = 20;

export type GateStatus = "pass" | "fail" | "not_applicable" | "inconclusive";

export interface GateResult {
	status: GateStatus;
	detail: string;
}

export interface AnchorGateInput {
	judge: string;
	recall: number;
	goodFalseAlarmRate: number;
	defectCount: number;
}

export interface SelfConsistencyGateInput {
	judge: string;
	score: number;
	sampleCount: number;
}

export interface CrossJudgeGateInput {
	judges: [string, string];
	agreement: number;
	kappa: number;
}

export interface PairwiseGateInput {
	judge: string;
	total: number;
	headWins: number;
	tailWins: number;
	ties: number;
	headWinRate: number;
	positionAWinRate: number;
}

export interface GateEvaluationInput {
	activeJudgeCount: number;
	anchorResults: AnchorGateInput[];
	selfConsistencyResults: SelfConsistencyGateInput[];
	crossJudgeAgreements: CrossJudgeGateInput[];
	pairwiseResults: PairwiseGateInput[];
}

export interface GateEvaluation {
	admissible: boolean;
	gates: {
		activeJudge: GateResult;
		anchorRecall: GateResult;
		selfConsistency: GateResult;
		crossJudgeAgreement: GateResult;
		pairwisePositionBias: GateResult;
	};
}

export interface MetricOnset {
	budget: number;
	targetLocale: string;
	metric: string;
	onset: string | null;
}

export interface DefaultRecommendation {
	model: string;
	recommendedDefault: number | null;
	reason: string;
	safeBudgets: number[];
}

function pass(detail: string): GateResult {
	return { status: "pass", detail };
}

function fail(detail: string): GateResult {
	return { status: "fail", detail };
}

function notApplicable(detail: string): GateResult {
	return { status: "not_applicable", detail };
}

function inconclusive(detail: string): GateResult {
	return { status: "inconclusive", detail };
}

function isPassingGate(gate: GateResult): boolean {
	return gate.status === "pass" || gate.status === "not_applicable";
}

export function evaluateGates(input: GateEvaluationInput): GateEvaluation {
	const activeJudge =
		input.activeJudgeCount > 0
			? pass(`${input.activeJudgeCount} active judge(s)`)
			: fail("no active live judges; dry/no-key runs cannot calibrate defaults");

	const anchorRecall = evaluateAnchorGate(input.anchorResults);
	const selfConsistency = evaluateSelfConsistencyGate(
		input.selfConsistencyResults
	);
	const crossJudgeAgreement = evaluateCrossJudgeGate(
		input.activeJudgeCount,
		input.crossJudgeAgreements
	);
	const pairwisePositionBias = evaluatePairwiseGate(input.pairwiseResults);
	const gates = {
		activeJudge,
		anchorRecall,
		selfConsistency,
		crossJudgeAgreement,
		pairwisePositionBias,
	};
	return {
		admissible: Object.values(gates).every(isPassingGate),
		gates,
	};
}

function evaluateAnchorGate(results: AnchorGateInput[]): GateResult {
	if (results.length === 0) {
		return inconclusive("no anchor judgments were collected");
	}
	const failures = results.filter(
		(result) =>
			!Number.isFinite(result.recall) ||
			!Number.isFinite(result.goodFalseAlarmRate) ||
			result.defectCount === 0 ||
			result.recall < ANCHOR_RECALL_MIN ||
			result.goodFalseAlarmRate > GOOD_FALSE_ALARM_MAX
	);
	if (failures.length > 0) {
		return fail(
			`anchor gate failed for ${failures
				.map(
					(result) =>
						`${result.judge} (recall ${formatRatio(
							result.recall
						)}, good false alarms ${formatRatio(result.goodFalseAlarmRate)})`
				)
				.join(", ")}`
		);
	}
	return pass(
		`all judges met recall >= ${ANCHOR_RECALL_MIN} and good false alarms <= ${GOOD_FALSE_ALARM_MAX}`
	);
}

function evaluateSelfConsistencyGate(
	results: SelfConsistencyGateInput[]
): GateResult {
	if (results.length === 0) {
		return inconclusive("no repeat judgments were collected");
	}
	const failures = results.filter(
		(result) =>
			!Number.isFinite(result.score) ||
			result.sampleCount === 0 ||
			result.score < SELF_CONSISTENCY_MIN
	);
	if (failures.length > 0) {
		return fail(
			`self-consistency failed for ${failures
				.map((result) => `${result.judge} (${formatRatio(result.score)})`)
				.join(", ")}`
		);
	}
	return pass(`all judges met self-consistency >= ${SELF_CONSISTENCY_MIN}`);
}

function evaluateCrossJudgeGate(
	activeJudgeCount: number,
	agreements: CrossJudgeGateInput[]
): GateResult {
	if (activeJudgeCount < 2) {
		return notApplicable("one active judge; cross-judge kappa not applicable");
	}
	if (agreements.length === 0) {
		return inconclusive("multiple judges configured but no common judgments");
	}
	const failures = agreements.filter(
		(agreement) =>
			!Number.isFinite(agreement.kappa) ||
			agreement.kappa < CROSS_JUDGE_KAPPA_MIN
	);
	if (failures.length > 0) {
		return fail(
			`cross-judge kappa failed for ${failures
				.map(
					(result) =>
						`${result.judges[0]} vs ${result.judges[1]} (${result.kappa.toFixed(
							3
						)})`
				)
				.join(", ")}`
		);
	}
	return pass(`all judge pairs met kappa >= ${CROSS_JUDGE_KAPPA_MIN}`);
}

function evaluatePairwiseGate(results: PairwiseGateInput[]): GateResult {
	if (results.length === 0) {
		return inconclusive("no pairwise judgments were collected");
	}
	const failures = results.filter((result) => {
		const decisive = result.headWins + result.tailWins;
		return (
			decisive < MIN_PAIRWISE_DECISIVE ||
			!Number.isFinite(result.positionAWinRate) ||
			result.positionAWinRate < POSITION_A_WIN_RATE_MIN ||
			result.positionAWinRate > POSITION_A_WIN_RATE_MAX
		);
	});
	if (failures.length > 0) {
		return fail(
			`pairwise position-bias gate failed for ${failures
				.map((result) => {
					const decisive = result.headWins + result.tailWins;
					return `${result.judge} (${decisive} decisive, A win rate ${formatRatio(
						result.positionAWinRate
					)})`;
				})
				.join(", ")}`
		);
	}
	return pass(
		`all judges had >= ${MIN_PAIRWISE_DECISIVE} decisive pairwise verdicts and A-slot win rate ${POSITION_A_WIN_RATE_MIN}-${POSITION_A_WIN_RATE_MAX}`
	);
}

function formatRatio(value: number): string {
	return Number.isFinite(value) ? value.toFixed(3) : "NaN";
}

function rowIdentity(row: Pick<RunRow, "runId" | "targetLocale" | "key">): string {
	return `${row.runId}|${row.targetLocale}|${row.key}`;
}

function normalize(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function median(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[mid]!
		: (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function groupKey(row: RunRow): string {
	return `${row.runId}|${row.budget}|${row.targetLocale}`;
}

function groupsOf(rows: RunRow[]): RunRow[][] {
	const groups = new Map<string, RunRow[]>();
	for (const row of rows) {
		const key = groupKey(row);
		const group = groups.get(key);
		if (group) group.push(row);
		else groups.set(key, [row]);
	}
	return [...groups.values()];
}

export function buildTier1Metrics(rows: RunRow[]): Record<string, MetricFn> {
	const medianRatioByGroup = new Map<string, number>();
	const summarizationIds = new Set<string>();
	const repetitionById = new Map<string, number>();

	for (const group of groupsOf(rows)) {
		const ratios = group
			.filter((row) => row.sourceText.length > 0 && row.targetText.length > 0)
			.map((row) => row.targetText.length / row.sourceText.length);
		medianRatioByGroup.set(groupKey(group[0]!), median(ratios));

		for (const outlier of summarizationOutliers(group as BenchmarkRow[])) {
			const row = group.find((candidate) => candidate.key === outlier.key);
			if (row) summarizationIds.add(rowIdentity(row));
		}

		const repetition = repetitionScore(group as BenchmarkRow[]);
		for (const item of repetition.perItemRepetition) {
			const row = group.find((candidate) => candidate.key === item.key);
			if (!row) continue;
			repetitionById.set(rowIdentity(row), item.repetition);
		}
		for (const pair of repetition.perPairReuse) {
			const row = group.find((candidate) => candidate.key === pair.key);
			if (!row) continue;
			const id = rowIdentity(row);
			repetitionById.set(id, Math.max(repetitionById.get(id) ?? 0, pair.reuse));
		}
	}

	return {
		validationFailure: (row) => (row.validationStatus === "saved" ? 0 : 1),
		copyThrough: (row) =>
			row.sourceText.length > 0 &&
			normalize(row.targetText) === normalize(row.sourceText)
				? 1
				: 0,
		terseness: (row) => {
			const medianRatio = medianRatioByGroup.get(groupKey(row));
			if (
				medianRatio === undefined ||
				!Number.isFinite(medianRatio) ||
				medianRatio === 0 ||
				row.sourceText.length === 0 ||
				row.targetText.length === 0
			) {
				return null;
			}
			const relative =
				row.targetText.length / row.sourceText.length / medianRatio;
			return Math.max(0, 1 - relative);
		},
		repetition: (row) => repetitionById.get(rowIdentity(row)) ?? 0,
		summarizationOutlier: (row) =>
			summarizationIds.has(rowIdentity(row)) ? 1 : 0,
	};
}

export function collectMetricOnsets(
	aggregates: GroupAggregate[],
	metricNames: readonly string[]
): MetricOnset[] {
	const onsets: MetricOnset[] = [];
	for (const group of aggregates) {
		for (const metric of metricNames) {
			const onset = decayOnset(group.tokenBandBuckets, metric);
			onsets.push({
				budget: group.budget,
				targetLocale: group.targetLocale,
				metric,
				onset: onset?.label ?? null,
			});
		}
	}
	return onsets;
}

export function recommendDefault(args: {
	model: string;
	admissible: boolean;
	metricOnsets: readonly MetricOnset[];
	budgets: readonly number[];
}): DefaultRecommendation {
	if (!args.admissible) {
		return {
			model: args.model,
			recommendedDefault: null,
			reason: "run is not admissible",
			safeBudgets: [],
		};
	}
	const candidateBudgets = [...args.budgets]
		.filter((budget) => budget > 0)
		.sort((a, b) => a - b);
	const safeBudgets = candidateBudgets.filter((budget) =>
		args.metricOnsets
			.filter((onset) => onset.budget === budget)
			.every((onset) => onset.onset === null)
	);
	const recommendedDefault = safeBudgets[safeBudgets.length - 1] ?? null;
	return {
		model: args.model,
		recommendedDefault,
		reason:
			recommendedDefault === null
				? "no nonzero swept budget was safe across all metrics and locales"
				: "largest nonzero swept budget with no detected onset across all metrics and locales",
		safeBudgets,
	};
}
