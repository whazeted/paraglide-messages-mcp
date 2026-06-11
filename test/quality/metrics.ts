/**
 * Tier-1 mechanical quality metrics for the translation-length benchmark.
 *
 * All functions here are pure and deterministic: they operate on arrays of
 * benchmark rows (one row per translated item, emitted by the benchmark
 * runner as JSONL) and require no LLM calls and no extra dependencies.
 * Together they surface the known long-output failure signatures of LLM
 * translation — copy-through, terseness drift, self-conditioned repetition,
 * drift-to-summarizing, and validation breakdown — as a function of
 * intra-batch position and cumulative output tokens, which is what we need
 * to calibrate DEFAULT_OUTPUT_TOKEN_BUDGET.
 */

/** One JSONL row emitted by the benchmark runner per translated item. */
export interface BenchmarkRow {
	runId: string;
	budget: number;
	targetLocale: string;
	model: string;
	batchIndex: number;
	positionInBatch: number;
	batchItemCount: number;
	key: string;
	sourceChars: number;
	cumulativeOutputTokensAtEmission: number;
	outputTokensForItem: number;
	validationStatus: string;
	validationErrors: string[];
	warnings: string[];
	targetText: string;
	sourceText: string;
}

/** Lowercase + collapse all whitespace runs to a single space + trim. */
function normalizeText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Word tokens of a text, lowercased, whitespace-delimited. */
function words(text: string): string[] {
	return normalizeText(text).split(" ").filter((w) => w.length > 0);
}

/** All word n-grams of a text as joined strings (with multiplicity). */
function ngrams(text: string, n: number): string[] {
	const tokens = words(text);
	const grams: string[] = [];
	for (let i = 0; i + n <= tokens.length; i++) {
		grams.push(tokens.slice(i, i + n).join(" "));
	}
	return grams;
}

/**
 * Ordinary least-squares slope of y against x.
 * Returns null when fewer than two points or when x has no variance.
 */
function leastSquaresSlope(points: ReadonlyArray<{ x: number; y: number }>): number | null {
	if (points.length < 2) return null;
	let sumX = 0;
	let sumY = 0;
	for (const p of points) {
		sumX += p.x;
		sumY += p.y;
	}
	const meanX = sumX / points.length;
	const meanY = sumY / points.length;
	let num = 0;
	let den = 0;
	for (const p of points) {
		num += (p.x - meanX) * (p.y - meanY);
		den += (p.x - meanX) * (p.x - meanX);
	}
	if (den === 0) return null;
	return num / den;
}

/** Median of a non-empty numeric array; NaN for an empty one. */
function median(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		const m = sorted[mid];
		return m ?? Number.NaN;
	}
	const lo = sorted[mid - 1];
	const hi = sorted[mid];
	if (lo === undefined || hi === undefined) return Number.NaN;
	return (lo + hi) / 2;
}

/** target.length / source.length, or null when the source is empty. */
function lengthRatio(row: BenchmarkRow): number | null {
	if (row.sourceText.length === 0) return null;
	return row.targetText.length / row.sourceText.length;
}

/** Median target/source length ratio per locale (rows with empty sources skipped). */
function medianRatioByLocale(rows: ReadonlyArray<BenchmarkRow>): Map<string, number> {
	const byLocale = new Map<string, number[]>();
	for (const row of rows) {
		const ratio = lengthRatio(row);
		if (ratio === null) continue;
		const list = byLocale.get(row.targetLocale);
		if (list) list.push(ratio);
		else byLocale.set(row.targetLocale, [ratio]);
	}
	const medians = new Map<string, number>();
	for (const [locale, ratios] of byLocale) {
		medians.set(locale, median(ratios));
	}
	return medians;
}

export interface CopyThroughResult {
	/** Fraction of rows whose target is (near-)identical to the source. */
	rate: number;
	/** Number of copy-through rows. */
	copies: number;
	/** Total rows considered. */
	total: number;
	/** Keys of the copy-through rows, for drill-down. */
	copiedKeys: string[];
}

/**
 * Fraction of items whose targetText is identical or near-identical
 * (case- and whitespace-normalized) to the sourceText.
 *
 * Why it matters: an untranslated copy of the source is the cheapest way for
 * a model to "complete" an item late in a long output — a rising
 * copy-through rate with position is a direct giving-up signal.
 */
export function copyThroughRate(rows: ReadonlyArray<BenchmarkRow>): CopyThroughResult {
	const copiedKeys: string[] = [];
	for (const row of rows) {
		if (normalizeText(row.targetText) === normalizeText(row.sourceText)) {
			copiedKeys.push(row.key);
		}
	}
	return {
		rate: rows.length === 0 ? 0 : copiedKeys.length / rows.length,
		copies: copiedKeys.length,
		total: rows.length,
		copiedKeys,
	};
}

export interface LengthRatioDriftItem {
	key: string;
	targetLocale: string;
	positionInBatch: number;
	cumulativeOutputTokensAtEmission: number;
	/** targetText.length / sourceText.length for this item. */
	ratio: number;
	/** ratio divided by the run's per-locale median ratio. ~1.0 = typical. */
	relativeRatio: number;
}

export interface LengthRatioDriftResult {
	/** OLS slope of relative ratio against positionInBatch; null if undefined. */
	slopeByPosition: number | null;
	/** OLS slope of relative ratio against cumulativeOutputTokensAtEmission; null if undefined. */
	slopeByCumulativeTokens: number | null;
	/** Median target/source length ratio per locale. */
	medianRatioByLocale: Record<string, number>;
	/** Per-item ratios (rows with empty source text are skipped). */
	items: LengthRatioDriftItem[];
}

/**
 * Per-item target/source length ratio normalized by the run's per-locale
 * median ratio, with least-squares slopes of that relative ratio against
 * intra-batch position and against cumulative output tokens.
 *
 * Why it matters: translations naturally have a stable per-locale length
 * ratio; a downward slope means later items get systematically terser — the
 * formulaic/terseness drift signature that precedes outright summarizing.
 */
export function lengthRatioDrift(rows: ReadonlyArray<BenchmarkRow>): LengthRatioDriftResult {
	const medians = medianRatioByLocale(rows);
	const items: LengthRatioDriftItem[] = [];
	for (const row of rows) {
		const ratio = lengthRatio(row);
		if (ratio === null) continue;
		const localeMedian = medians.get(row.targetLocale);
		if (localeMedian === undefined || localeMedian === 0 || Number.isNaN(localeMedian)) continue;
		items.push({
			key: row.key,
			targetLocale: row.targetLocale,
			positionInBatch: row.positionInBatch,
			cumulativeOutputTokensAtEmission: row.cumulativeOutputTokensAtEmission,
			ratio,
			relativeRatio: ratio / localeMedian,
		});
	}
	return {
		slopeByPosition: leastSquaresSlope(
			items.map((i) => ({ x: i.positionInBatch, y: i.relativeRatio })),
		),
		slopeByCumulativeTokens: leastSquaresSlope(
			items.map((i) => ({ x: i.cumulativeOutputTokensAtEmission, y: i.relativeRatio })),
		),
		medianRatioByLocale: Object.fromEntries(medians),
		items,
	};
}

export interface RepetitionScoreResult {
	/**
	 * Mean over items of the fraction of word 3-gram occurrences within the
	 * target that are repeats of an earlier 3-gram in the same target.
	 */
	withinItemRepetition: number;
	/**
	 * Mean over consecutive same-batch item pairs of the fraction of the
	 * later target's long n-grams (n = skeletonNgramSize) that also occur in
	 * the previous target but NOT in the corresponding sources.
	 */
	adjacentSkeletonReuse: number;
	/** Per-item within-item repetition, keyed by row key (order preserved). */
	perItemRepetition: Array<{ key: string; repetition: number }>;
	/** Per adjacent pair skeleton reuse (prevKey -> key). */
	perPairReuse: Array<{ prevKey: string; key: string; reuse: number }>;
}

/** N-gram size used for the within-item repetition component. */
const WITHIN_ITEM_NGRAM = 3;
/** N-gram size used for the adjacent-item skeleton-reuse component. */
const SKELETON_NGRAM = 5;

/**
 * Two repetition components: (1) within-item repeated word-3-gram fraction —
 * degenerate looping inside a single translation; (2) adjacent-item skeleton
 * reuse — long word n-grams shared between consecutive targets in the same
 * batch that are NOT shared by the corresponding sources.
 *
 * Why it matters: an autoregressive model conditions on its own prior output,
 * so late items start recycling phrasing from earlier items even when the
 * sources differ — the self-conditioning signature of long-batch decay.
 */
export function repetitionScore(rows: ReadonlyArray<BenchmarkRow>): RepetitionScoreResult {
	const perItemRepetition: Array<{ key: string; repetition: number }> = [];
	for (const row of rows) {
		const grams = ngrams(row.targetText, WITHIN_ITEM_NGRAM);
		const repetition = grams.length === 0
			? 0
			: (grams.length - new Set(grams).size) / grams.length;
		perItemRepetition.push({ key: row.key, repetition });
	}

	// Group rows into batches and walk consecutive items in emission order.
	const batches = new Map<string, BenchmarkRow[]>();
	for (const row of rows) {
		const batchKey = JSON.stringify([row.runId, row.model, row.targetLocale, row.batchIndex]);
		const list = batches.get(batchKey);
		if (list) list.push(row);
		else batches.set(batchKey, [row]);
	}

	const perPairReuse: Array<{ prevKey: string; key: string; reuse: number }> = [];
	for (const batch of batches.values()) {
		const ordered = [...batch].sort((a, b) => a.positionInBatch - b.positionInBatch);
		for (let i = 1; i < ordered.length; i++) {
			const prev = ordered[i - 1];
			const curr = ordered[i];
			if (!prev || !curr) continue;
			const currTargetGrams = new Set(ngrams(curr.targetText, SKELETON_NGRAM));
			if (currTargetGrams.size === 0) {
				perPairReuse.push({ prevKey: prev.key, key: curr.key, reuse: 0 });
				continue;
			}
			const prevTargetGrams = new Set(ngrams(prev.targetText, SKELETON_NGRAM));
			const currSourceGrams = new Set(ngrams(curr.sourceText, SKELETON_NGRAM));
			const sourceShared = new Set(
				ngrams(prev.sourceText, SKELETON_NGRAM).filter((g) => currSourceGrams.has(g)),
			);
			let shared = 0;
			for (const gram of currTargetGrams) {
				if (prevTargetGrams.has(gram) && !sourceShared.has(gram)) shared++;
			}
			perPairReuse.push({ prevKey: prev.key, key: curr.key, reuse: shared / currTargetGrams.size });
		}
	}

	const mean = (xs: number[]): number =>
		xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

	return {
		withinItemRepetition: mean(perItemRepetition.map((i) => i.repetition)),
		adjacentSkeletonReuse: mean(perPairReuse.map((p) => p.reuse)),
		perItemRepetition,
		perPairReuse,
	};
}

export interface SummarizationOutlier {
	key: string;
	targetLocale: string;
	positionInBatch: number;
	cumulativeOutputTokensAtEmission: number;
	/** This item's target/source length ratio. */
	ratio: number;
	/** The locale's median ratio it is measured against. */
	localeMedianRatio: number;
	/** ratio / localeMedianRatio — below the threshold by construction. */
	relativeRatio: number;
}

/**
 * Items whose target length falls far below the locale-median expectation:
 * relative ratio (item ratio / locale median ratio) below `threshold`
 * (default 0.5, i.e. the target is less than half the expected length).
 *
 * Why it matters: document-MT research documents a failure mode where long
 * outputs drift from translating to summarizing; these outliers are the
 * items where that collapse has already happened.
 */
export function summarizationOutliers(
	rows: ReadonlyArray<BenchmarkRow>,
	threshold = 0.5,
): SummarizationOutlier[] {
	const medians = medianRatioByLocale(rows);
	const outliers: SummarizationOutlier[] = [];
	for (const row of rows) {
		const ratio = lengthRatio(row);
		if (ratio === null) continue;
		const localeMedianRatio = medians.get(row.targetLocale);
		if (
			localeMedianRatio === undefined ||
			localeMedianRatio <= 0 ||
			Number.isNaN(localeMedianRatio)
		) {
			continue;
		}
		const relativeRatio = ratio / localeMedianRatio;
		if (relativeRatio < threshold) {
			outliers.push({
				key: row.key,
				targetLocale: row.targetLocale,
				positionInBatch: row.positionInBatch,
				cumulativeOutputTokensAtEmission: row.cumulativeOutputTokensAtEmission,
				ratio,
				localeMedianRatio,
				relativeRatio,
			});
		}
	}
	return outliers;
}

export interface ValidationFailureBucket {
	/** Bucket index, 0 = head of batch, bucketCount-1 = tail. */
	bucket: number;
	failures: number;
	total: number;
	rate: number;
}

export interface ValidationFailureResult {
	/** Overall fraction of rows with validationStatus !== "saved". */
	rate: number;
	failures: number;
	total: number;
	/** Failure rate per relative-position bucket (head -> tail). */
	byPositionBucket: ValidationFailureBucket[];
}

/**
 * Fraction of items the server rejected (validationStatus !== "saved"),
 * overall and per relative intra-batch position bucket.
 *
 * Why it matters: placeholder/format validation failures are the hardest
 * decay signal — if the failure rate climbs in tail buckets, items past that
 * point are not just worse, they are unusable, bounding the safe budget.
 */
export function validationFailureRate(
	rows: ReadonlyArray<BenchmarkRow>,
	bucketCount = 4,
): ValidationFailureResult {
	const isFailure = (row: BenchmarkRow): boolean => row.validationStatus !== "saved";
	const failures = rows.filter(isFailure).length;
	const buckets = bucketByPosition(rows, bucketCount);
	const byPositionBucket: ValidationFailureBucket[] = buckets.map((bucketRows, bucket) => {
		const bucketFailures = bucketRows.filter(isFailure).length;
		return {
			bucket,
			failures: bucketFailures,
			total: bucketRows.length,
			rate: bucketRows.length === 0 ? 0 : bucketFailures / bucketRows.length,
		};
	});
	return {
		rate: rows.length === 0 ? 0 : failures / rows.length,
		failures,
		total: rows.length,
		byPositionBucket,
	};
}

/**
 * Split rows into `bucketCount` buckets by relative intra-batch position
 * (positionInBatch / batchItemCount), so batches of different sizes can be
 * aggregated head-to-tail. Bucket 0 is the head, the last bucket the tail.
 *
 * Why it matters: every positional metric above needs a common head/tail
 * axis across batches of varying size; this is that axis.
 */
export function bucketByPosition(
	rows: ReadonlyArray<BenchmarkRow>,
	bucketCount: number,
): BenchmarkRow[][] {
	if (!Number.isInteger(bucketCount) || bucketCount < 1) {
		throw new Error(`bucketCount must be a positive integer, got ${bucketCount}`);
	}
	const buckets: BenchmarkRow[][] = Array.from({ length: bucketCount }, () => []);
	for (const row of rows) {
		const denom = Math.max(row.batchItemCount, 1);
		const fraction = Math.min(Math.max(row.positionInBatch / denom, 0), 1);
		const index = Math.min(Math.floor(fraction * bucketCount), bucketCount - 1);
		const bucket = buckets[index];
		if (bucket) bucket.push(row);
	}
	return buckets;
}
