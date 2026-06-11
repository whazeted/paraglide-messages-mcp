/**
 * Analysis / reporting layer for output-token limit calibration.
 *
 * Consumes the instrumented runner's JSONL output (one row per translated
 * item) and turns it into per-budget decay tables and a detected decay
 * onset. The metric columns are pluggable per-row scoring functions so the
 * Tier-1 mechanical metrics and the Tier-2 judge scores can plug in without
 * this module importing those modules — their PRs land in parallel, so the
 * row/score types are defined locally here instead of imported.
 *
 * Everything in this file is pure and deterministic: same rows + same
 * metric functions → byte-identical report.
 */

/** One JSONL row emitted by the instrumented benchmark runner. */
export interface RunRow {
	runId: string;
	/** Output-token budget the run was sweeping (e.g. 1500). */
	budget: number;
	targetLocale: string;
	model: string;
	batchIndex: number;
	/** 0-based position of this item within its batch. */
	positionInBatch: number;
	batchItemCount: number;
	key: string;
	sourceChars: number;
	/** Running output-token total at the moment this item was emitted. */
	cumulativeOutputTokensAtEmission: number;
	outputTokensForItem: number;
	validationStatus: string;
	validationErrors: string[];
	warnings: string[];
	targetText: string;
	sourceText: string;
}

/** A line that could not be parsed into a {@link RunRow}, kept for the report. */
export interface MalformedLine {
	/** 1-based line number in the original JSONL content. */
	lineNumber: number;
	line: string;
	reason: string;
}

export interface ParseResult {
	rows: RunRow[];
	malformed: MalformedLine[];
}

/**
 * Per-row scoring function. Higher = more degraded (error-style score), so
 * decay shows up as the score *rising* toward the tail. Return `null` to
 * exclude the row from this metric (e.g. judge skipped the item).
 */
export type MetricFn = (row: RunRow) => number | null;

/** Mean / spread of one metric over the rows of one bucket. */
export interface MetricStats {
	/** Rows that produced a non-null score for this metric. */
	n: number;
	mean: number;
	/** Population standard deviation (deterministic, no sampling correction). */
	stddev: number;
}

export interface BucketStats {
	/** Human-readable bucket label, e.g. "0–4" or "0–249". */
	label: string;
	/** Numeric lower edge of the bucket, used for deterministic ordering. */
	start: number;
	/** Total rows that fell into the bucket (before per-metric null filtering). */
	count: number;
	metrics: Record<string, MetricStats>;
}

/** Aggregates for one budget × locale group. */
export interface GroupAggregate {
	budget: number;
	targetLocale: string;
	/** Buckets over `positionInBatch`. */
	positionBuckets: BucketStats[];
	/** Buckets over `cumulativeOutputTokensAtEmission` bands. */
	tokenBandBuckets: BucketStats[];
}

export interface AggregateOptions {
	/** Width of each positionInBatch bucket. Default 5. */
	positionBucketSize?: number;
	/** Width of each cumulative-output-token band. Default 250. */
	tokenBandSize?: number;
}

/* -------------------------------------------------------------------------
 * Parsing
 * ---------------------------------------------------------------------- */

/**
 * Field validators for the row schema. Kept as a table so the "what makes a
 * row malformed" definition lives in one place and the reason strings stay
 * consistent.
 */
const ROW_FIELD_CHECKS: ReadonlyArray<
	readonly [keyof RunRow, (v: unknown) => boolean, string]
> = [
	["runId", (v) => typeof v === "string", "string"],
	["budget", isFiniteNumber, "number"],
	["targetLocale", (v) => typeof v === "string", "string"],
	["model", (v) => typeof v === "string", "string"],
	["batchIndex", isFiniteNumber, "number"],
	["positionInBatch", isFiniteNumber, "number"],
	["batchItemCount", isFiniteNumber, "number"],
	["key", (v) => typeof v === "string", "string"],
	["sourceChars", isFiniteNumber, "number"],
	["cumulativeOutputTokensAtEmission", isFiniteNumber, "number"],
	["outputTokensForItem", isFiniteNumber, "number"],
	["validationStatus", (v) => typeof v === "string", "string"],
	["validationErrors", isStringArray, "string[]"],
	["warnings", isStringArray, "string[]"],
	["targetText", (v) => typeof v === "string", "string"],
	["sourceText", (v) => typeof v === "string", "string"],
];

function isFiniteNumber(v: unknown): boolean {
	return typeof v === "number" && Number.isFinite(v);
}

function isStringArray(v: unknown): boolean {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Parse JSONL content into rows, skipping and collecting malformed lines
 * instead of throwing — a long paid benchmark run must never lose its whole
 * dataset to one truncated line. Blank lines are ignored silently.
 */
export function parseJsonl(content: string): ParseResult {
	const rows: RunRow[] = [];
	const malformed: MalformedLine[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (raw === undefined) continue;
		const line = raw.trim();
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			malformed.push({
				lineNumber: i + 1,
				line,
				reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
			});
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			malformed.push({ lineNumber: i + 1, line, reason: "not a JSON object" });
			continue;
		}
		const obj = parsed as Record<string, unknown>;
		const badField = ROW_FIELD_CHECKS.find(([name, ok]) => !ok(obj[name]));
		if (badField !== undefined) {
			malformed.push({
				lineNumber: i + 1,
				line,
				reason: `field "${badField[0]}" missing or not a ${badField[2]}`,
			});
			continue;
		}
		rows.push(obj as unknown as RunRow);
	}
	return { rows, malformed };
}

/* -------------------------------------------------------------------------
 * Aggregation
 * ---------------------------------------------------------------------- */

function bucketLabel(start: number, size: number): string {
	return `${start}–${start + size - 1}`;
}

/**
 * Bucket the rows of one group along one axis and compute per-bucket metric
 * stats. Buckets are emitted sorted by their numeric lower edge so output
 * order never depends on row order.
 */
function bucketize(
	rows: RunRow[],
	axis: (row: RunRow) => number,
	bucketSize: number,
	metrics: Record<string, MetricFn>,
): BucketStats[] {
	const byStart = new Map<number, RunRow[]>();
	for (const row of rows) {
		const value = axis(row);
		// Negative axis values would come from a buggy runner; floor still
		// produces a stable bucket rather than dropping the row.
		const start = Math.floor(value / bucketSize) * bucketSize;
		const existing = byStart.get(start);
		if (existing === undefined) byStart.set(start, [row]);
		else existing.push(row);
	}
	const starts = [...byStart.keys()].sort((a, b) => a - b);
	return starts.map((start) => {
		const bucketRows = byStart.get(start) ?? [];
		const metricStats: Record<string, MetricStats> = {};
		for (const [name, fn] of Object.entries(metrics)) {
			const scores: number[] = [];
			for (const row of bucketRows) {
				const score = fn(row);
				if (score !== null && Number.isFinite(score)) scores.push(score);
			}
			metricStats[name] = summarize(scores);
		}
		return {
			label: bucketLabel(start, bucketSize),
			start,
			count: bucketRows.length,
			metrics: metricStats,
		};
	});
}

function summarize(scores: number[]): MetricStats {
	if (scores.length === 0) return { n: 0, mean: NaN, stddev: NaN };
	const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
	const variance =
		scores.reduce((acc, s) => acc + (s - mean) * (s - mean), 0) / scores.length;
	return { n: scores.length, mean, stddev: Math.sqrt(variance) };
}

/**
 * Group rows by budget × target locale and bucket each group along both
 * decay axes. Groups are sorted by budget then locale for deterministic
 * report order.
 */
export function aggregate(
	rows: RunRow[],
	metrics: Record<string, MetricFn>,
	options: AggregateOptions = {},
): GroupAggregate[] {
	const positionBucketSize = options.positionBucketSize ?? 5;
	const tokenBandSize = options.tokenBandSize ?? 250;
	const groups = new Map<string, { budget: number; locale: string; rows: RunRow[] }>();
	for (const row of rows) {
		const key = `${row.budget}|${row.targetLocale}`;
		const existing = groups.get(key);
		if (existing === undefined) {
			groups.set(key, { budget: row.budget, locale: row.targetLocale, rows: [row] });
		} else {
			existing.rows.push(row);
		}
	}
	const sorted = [...groups.values()].sort(
		(a, b) => a.budget - b.budget || a.locale.localeCompare(b.locale),
	);
	return sorted.map((group) => ({
		budget: group.budget,
		targetLocale: group.locale,
		positionBuckets: bucketize(
			group.rows,
			(r) => r.positionInBatch,
			positionBucketSize,
			metrics,
		),
		tokenBandBuckets: bucketize(
			group.rows,
			(r) => r.cumulativeOutputTokensAtEmission,
			tokenBandSize,
			metrics,
		),
	}));
}

/* -------------------------------------------------------------------------
 * Decay onset
 * ---------------------------------------------------------------------- */

/**
 * Find the first bucket whose mean leaves the head buckets' noise floor.
 *
 * The head is the first `headCount` buckets; the noise floor is the mean of
 * the head bucket means plus twice their standard deviation. The first
 * later bucket whose mean strictly exceeds the floor is the onset. This is
 * deliberately a relative test: it asks "where does the tail stop looking
 * like the head", which is robust to memorized corpus text — memorization
 * does not vary by position in the output.
 *
 * Metrics follow the higher-is-worse convention of {@link MetricFn}.
 * Buckets with no scored rows are skipped on both sides. Returns the onset
 * bucket, or `null` when nothing leaves the floor (flat data) or there are
 * not enough scored buckets to define head and tail.
 */
export function decayOnset(
	buckets: BucketStats[],
	metricName: string,
	headCount = 3,
): BucketStats | null {
	const scored = buckets.filter((b) => (b.metrics[metricName]?.n ?? 0) > 0);
	if (scored.length <= headCount) return null;
	const headMeans = scored
		.slice(0, headCount)
		.map((b) => b.metrics[metricName]?.mean)
		.filter((m): m is number => m !== undefined);
	if (headMeans.length === 0) return null;
	const { mean: headMean, stddev: headStd } = summarize(headMeans);
	// Tiny epsilon keeps float jitter on perfectly flat data from producing
	// a spurious onset when the head stddev is exactly zero.
	const floor = headMean + 2 * headStd + 1e-9;
	for (const bucket of scored.slice(headCount)) {
		const stats = bucket.metrics[metricName];
		if (stats !== undefined && stats.mean > floor) return bucket;
	}
	return null;
}

/* -------------------------------------------------------------------------
 * Markdown rendering
 * ---------------------------------------------------------------------- */

function formatNumber(value: number): string {
	if (Number.isNaN(value)) return "—";
	return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function metricNamesOf(aggregates: GroupAggregate[]): string[] {
	// Metric names come from the pluggable scoring functions; collect them
	// from the data (sorted) so the table layout is stable across runs.
	const names = new Set<string>();
	for (const group of aggregates) {
		for (const bucket of [...group.positionBuckets, ...group.tokenBandBuckets]) {
			for (const name of Object.keys(bucket.metrics)) names.add(name);
		}
	}
	return [...names].sort();
}

function renderBucketTable(
	heading: string,
	axisLabel: string,
	buckets: BucketStats[],
	metricNames: string[],
): string[] {
	const lines: string[] = [];
	lines.push(`#### ${heading}`);
	lines.push("");
	lines.push(`| ${axisLabel} | n | ${metricNames.map((n) => `${n} (mean ± sd)`).join(" | ")} |`);
	lines.push(`| --- | --- | ${metricNames.map(() => "---").join(" | ")} |`);
	for (const bucket of buckets) {
		const cells = metricNames.map((name) => {
			const stats = bucket.metrics[name];
			if (stats === undefined || stats.n === 0) return "—";
			return `${formatNumber(stats.mean)} ± ${formatNumber(stats.stddev)}`;
		});
		lines.push(`| ${bucket.label} | ${bucket.count} | ${cells.join(" | ")} |`);
	}
	lines.push("");
	return lines;
}

function describeMetric(name: string): string {
	if (name === "validationFailure") {
		return "Server-side validation failure rate. Goal: catch unusable translations, especially placeholder or message-shape breakage.";
	}
	if (name === "copyThrough") {
		return "Source text copied into the target after case/whitespace normalization. Goal: catch untranslated give-up behavior.";
	}
	if (name === "terseness") {
		return "Shortfall from the budget/locale group's median target/source length ratio. Goal: catch tail items becoming systematically too short.";
	}
	if (name === "repetition") {
		return "Repeated target n-grams within an item or reused target skeletons across adjacent items. Goal: catch self-conditioning and looping.";
	}
	if (name === "summarizationOutlier") {
		return "Target/source length ratio far below the locale median. Goal: catch translation collapsing into summary.";
	}
	if (name.startsWith("mqm(")) {
		return "Blind LLM MQM score: severity-weighted translation errors per 100 source words. Goal: catch semantic and fluency defects mechanical metrics miss.";
	}
	return "Custom error-style metric supplied by the benchmark runner. Goal: catch degradation where higher scores are worse.";
}

function renderMetricGuide(metricNames: string[]): string[] {
	const lines: string[] = [];
	lines.push("## Metrics and goals");
	lines.push("");
	lines.push("| metric | goal |");
	lines.push("| --- | --- |");
	for (const name of metricNames) {
		lines.push(`| \`${name}\` | ${describeMetric(name)} |`);
	}
	lines.push("");
	return lines;
}

function renderMethodologyGuide(): string[] {
	return [
		"## Why this methodology is reliable",
		"",
		"| control | why it helps |",
		"| --- | --- |",
		"| Deterministic Tier 1 metrics | Computed from saved JSONL rows, so they do not depend on judge preference or prompt phrasing. |",
		"| Error-style scoring | Higher always means worse, which makes onset detection consistent across mechanical and judge-backed signals. |",
		"| Position and token-band axes | Measures where output quality degrades over generation length rather than judging absolute translation taste. |",
		"| Relative onset threshold | Compares tail buckets to the head buckets' noise floor, so one-off bad rows do not automatically mark a budget unsafe. |",
		"| Blind LLM judges | Judge prompts hide batch position, token budget, and the decay hypothesis; judge scores are only used when reliability gates pass. |",
		"| Randomized pairwise order | Head-vs-tail judging randomizes A/B order, then unshuffles verdicts to expose judge position bias. |",
		"",
	];
}

function renderOnsetSummary(group: GroupAggregate, metricNames: string[]): string[] {
	const lines: string[] = [];
	lines.push("#### Onset summary");
	lines.push("");
	lines.push("| metric | token-band onset | status |");
	lines.push("| --- | --- | --- |");
	for (const name of metricNames) {
		const onset = decayOnset(group.tokenBandBuckets, name);
		lines.push(
			`| ${name} | ${onset?.label ?? "—"} | ${
				onset === null ? "no onset detected" : "decay detected"
			} |`,
		);
	}
	lines.push("");
	return lines;
}

/**
 * Render the aggregates as a Markdown report: one section per budget ×
 * locale group with a bucket × metric table for each decay axis, plus a
 * per-budget summary table with the detected onset for each metric (the
 * token-band axis is the one the budget constant actually limits, so onsets
 * are reported on that axis).
 */
export function renderMarkdownReport(aggregates: GroupAggregate[]): string {
	const metricNames = metricNamesOf(aggregates);
	const lines: string[] = [];
	lines.push("# Output-token limit calibration report");
	lines.push("");
	lines.push(...renderMetricGuide(metricNames));
	lines.push(...renderMethodologyGuide());
	lines.push("## Results");
	lines.push("");
	for (const group of aggregates) {
		lines.push(`### Budget ${group.budget} · locale ${group.targetLocale}`);
		lines.push("");
		lines.push(
			...renderBucketTable(
				"By position in batch",
				"position",
				group.positionBuckets,
				metricNames,
			),
		);
		lines.push(
			...renderBucketTable(
				"By cumulative output tokens",
				"tokens",
				group.tokenBandBuckets,
				metricNames,
			),
		);
		lines.push(...renderOnsetSummary(group, metricNames));
	}
	return lines.join("\n");
}
