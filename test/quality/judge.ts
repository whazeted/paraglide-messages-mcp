import { mulberry32 } from "../generate-messages.js";

/**
 * LLM-as-judge layer for the translation-quality benchmark.
 *
 * Everything in this module is a pure function: prompt builders, response
 * parsers, and statistics. The actual model call is injected by the caller as
 * `callModel: (prompt: string) => Promise<string>`, so the whole layer is
 * testable offline with stubbed responses and carries no SDK dependency.
 *
 * Blindness requirement: judge prompts must never reveal batch position,
 * batch size, token budget, or the degradation hypothesis — otherwise the
 * judge could rationalize the very effect we are trying to measure.
 */

/** One translated item as emitted by the benchmark runner (JSONL row). */
export interface QualityItem {
	key: string;
	positionInBatch: number;
	batchItemCount: number;
	sourceText: string;
	targetText: string;
	targetLocale: string;
	sourceChars: number;
}

/* ------------------------------------------------------------------ */
/* Tier 2: MQM error counting                                          */
/* ------------------------------------------------------------------ */

export const MQM_CATEGORIES = [
	"mistranslation",
	"omission",
	"addition",
	"untranslated",
	"grammar",
	"over-verbosity",
	"over-compression",
] as const;

export type MqmCategory = (typeof MQM_CATEGORIES)[number];

export const MQM_SEVERITIES = ["minor", "major", "critical"] as const;

export type MqmSeverity = (typeof MQM_SEVERITIES)[number];

/** A discrete error the judge found in one translation. */
export interface MqmError {
	category: MqmCategory;
	severity: MqmSeverity;
	/** Short quote from the source or translation evidencing the error. */
	evidence: string;
}

/**
 * Severity weights from the MQM scoring convention: a critical error costs an
 * order of magnitude more than a minor one, so a single dropped sentence is
 * not drowned out by a handful of typos.
 */
const SEVERITY_WEIGHTS: Record<MqmSeverity, number> = {
	minor: 1,
	major: 5,
	critical: 10,
};

/**
 * Build the MQM judging prompt for a single item.
 *
 * Only the source text, the translation, and the locale pair are revealed —
 * never the item's position, the batch size, or any budget figure (see the
 * blindness note at the top of this file).
 */
export function buildMqmPrompt(item: QualityItem): string {
	return [
		"You are an expert translation quality evaluator using the MQM (Multidimensional Quality Metrics) framework.",
		"",
		"Source locale: en",
		`Target locale: ${item.targetLocale}`,
		"",
		"Source text:",
		"<<<",
		item.sourceText,
		">>>",
		"",
		"Translation:",
		"<<<",
		item.targetText,
		">>>",
		"",
		"List every discrete error you find in the translation. Use exactly these categories:",
		"- mistranslation: the translation conveys a different meaning than the source",
		"- omission: content present in the source is missing from the translation",
		"- addition: content absent from the source was added to the translation",
		"- untranslated: source-language text was left untranslated",
		"- grammar: grammatical, morphological, or agreement errors in the target language",
		"- over-verbosity: padding, unjustified explicitation, or hedging absent from the source",
		"- over-compression: terseness that drops nuance, detail, or tone present in the source",
		"",
		'Severity is one of "minor", "major", or "critical".',
		"",
		"Respond with ONLY a JSON array, one object per error:",
		'[{"category": "<category>", "severity": "<severity>", "evidence": "<short quote from the source or translation>"}]',
		"If the translation has no errors, respond with [].",
	].join("\n");
}

/**
 * Strip a fenced code block or surrounding prose and return the innermost
 * JSON payload. LLM judges frequently wrap JSON in ``` fences or a sentence
 * of commentary, so naive JSON.parse on the raw response would fail.
 */
function extractJsonPayload(raw: string): string {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
	const body = fenced?.[1] ?? raw;
	// Take the outermost bracket span: whichever of "[" / "{" opens first.
	const firstArray = body.indexOf("[");
	const firstObject = body.indexOf("{");
	let start: number;
	let end: number;
	if (firstArray !== -1 && (firstObject === -1 || firstArray < firstObject)) {
		start = firstArray;
		end = body.lastIndexOf("]");
	} else {
		start = firstObject;
		end = body.lastIndexOf("}");
	}
	if (start === -1 || end === -1 || end < start) {
		throw new Error(`No JSON payload found in judge response: ${raw.slice(0, 120)}`);
	}
	return body.slice(start, end + 1);
}

function isMqmCategory(value: unknown): value is MqmCategory {
	return typeof value === "string" && (MQM_CATEGORIES as readonly string[]).includes(value);
}

function isMqmSeverity(value: unknown): value is MqmSeverity {
	return typeof value === "string" && (MQM_SEVERITIES as readonly string[]).includes(value);
}

/**
 * Parse the judge's MQM response into validated errors.
 *
 * Accepts a bare JSON array or an `{"errors": [...]}` wrapper, with or
 * without code fences / prose. Throws (never crashes with a TypeError) on
 * malformed responses so callers can count judge failures explicitly.
 */
export function parseMqmResponse(raw: string): MqmError[] {
	const payload = extractJsonPayload(raw);
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		throw new Error(`Judge response is not valid JSON: ${payload.slice(0, 120)}`);
	}
	let list: unknown[];
	if (Array.isArray(parsed)) {
		list = parsed;
	} else if (
		parsed !== null &&
		typeof parsed === "object" &&
		Array.isArray((parsed as { errors?: unknown }).errors)
	) {
		list = (parsed as { errors: unknown[] }).errors;
	} else {
		throw new Error("Judge response JSON is neither an array nor an {errors: []} object");
	}
	return list.map((entry, index) => {
		if (entry === null || typeof entry !== "object") {
			throw new Error(`MQM error #${index} is not an object`);
		}
		const { category, severity, evidence } = entry as Record<string, unknown>;
		if (!isMqmCategory(category)) {
			throw new Error(`MQM error #${index} has invalid category: ${String(category)}`);
		}
		if (!isMqmSeverity(severity)) {
			throw new Error(`MQM error #${index} has invalid severity: ${String(severity)}`);
		}
		if (typeof evidence !== "string") {
			throw new Error(`MQM error #${index} has non-string evidence`);
		}
		return { category, severity, evidence };
	});
}

/**
 * Severity-weighted errors per 100 source words (minor=1, major=5,
 * critical=10). Normalizing by source length lets short and long items be
 * compared on the same scale — raw error counts would penalize long items.
 */
export function mqmScore(errors: readonly MqmError[], sourceWordCount: number): number {
	if (!Number.isFinite(sourceWordCount) || sourceWordCount <= 0) {
		throw new Error(`sourceWordCount must be a positive number, got ${sourceWordCount}`);
	}
	const weighted = errors.reduce((sum, error) => sum + SEVERITY_WEIGHTS[error.severity], 0);
	return (weighted / sourceWordCount) * 100;
}

/* ------------------------------------------------------------------ */
/* Tier 3: pairwise head-vs-tail comparison                            */
/* ------------------------------------------------------------------ */

export type PairwiseChoice = "A" | "B" | "tie";

/** Built pairwise prompt plus the order bookkeeping needed to un-shuffle. */
export interface PairwisePrompt {
	prompt: string;
	/**
	 * True when the presentation order was flipped: slot "A" in the prompt
	 * holds itemB and slot "B" holds itemA. Recorded so aggregation can map
	 * the judge's positional verdict back to the head/tail items.
	 */
	swapped: boolean;
}

/**
 * Build a pairwise comparison prompt for two length-matched items
 * (by convention itemA = head-of-batch, itemB = tail-of-batch).
 *
 * Presentation order is randomized by a deterministic seed so that judge
 * position bias (favoring whichever translation appears first) averages out
 * across the run instead of systematically favoring head or tail.
 */
export function buildPairwisePrompt(
	itemA: QualityItem,
	itemB: QualityItem,
	seed: number,
): PairwisePrompt {
	const rng = mulberry32(seed);
	const swapped = rng() < 0.5;
	const first = swapped ? itemB : itemA;
	const second = swapped ? itemA : itemB;
	const prompt = [
		"You are an expert translation quality evaluator. Compare two independent English-to-target translations and decide which is the better overall translation of its own source.",
		"",
		"Translation A:",
		`Target locale: ${first.targetLocale}`,
		"Source text:",
		"<<<",
		first.sourceText,
		">>>",
		"Translation:",
		"<<<",
		first.targetText,
		">>>",
		"",
		"Translation B:",
		`Target locale: ${second.targetLocale}`,
		"Source text:",
		"<<<",
		second.sourceText,
		">>>",
		"Translation:",
		"<<<",
		second.targetText,
		">>>",
		"",
		"Judge accuracy, completeness, fluency, and faithfulness of register and length to the source.",
		'Respond with ONLY a JSON object: {"verdict": "A"} or {"verdict": "B"} or {"verdict": "tie"}.',
	].join("\n");
	return { prompt, swapped };
}

/**
 * Parse the judge's pairwise verdict. Tolerates fences, prose, a bare
 * "A"/"B"/"tie" string, or a {"verdict": ...} object; throws on anything
 * else so silent misreads cannot skew win rates.
 */
export function parsePairwiseResponse(raw: string): PairwiseChoice {
	const normalize = (value: string): PairwiseChoice | null => {
		const trimmed = value.trim();
		if (/^a$/i.test(trimmed)) return "A";
		if (/^b$/i.test(trimmed)) return "B";
		if (/^tie$/i.test(trimmed)) return "tie";
		return null;
	};
	// Fast path: the whole response is just the choice (optionally quoted).
	const bare = normalize(raw.replace(/^["'\s]+|["'\s]+$/g, ""));
	if (bare !== null) return bare;
	let payload: string;
	try {
		payload = extractJsonPayload(raw);
	} catch {
		throw new Error(`No pairwise verdict found in judge response: ${raw.slice(0, 120)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		throw new Error(`Pairwise judge response is not valid JSON: ${payload.slice(0, 120)}`);
	}
	if (parsed !== null && typeof parsed === "object") {
		const verdict = (parsed as { verdict?: unknown }).verdict;
		if (typeof verdict === "string") {
			const choice = normalize(verdict);
			if (choice !== null) return choice;
		}
	} else if (typeof parsed === "string") {
		const choice = normalize(parsed);
		if (choice !== null) return choice;
	}
	throw new Error(`Pairwise judge response has no valid verdict: ${raw.slice(0, 120)}`);
}

/** One pairwise outcome: the judge's positional choice plus the order flag. */
export interface PairwiseVerdict {
	verdict: PairwiseChoice;
	/** Mirrors PairwisePrompt.swapped for the same comparison. */
	swapped: boolean;
}

export interface PairwiseWinRates {
	total: number;
	headWins: number;
	tailWins: number;
	ties: number;
	/** Head wins over decisive (non-tie) verdicts; NaN when none decisive. */
	headWinRate: number;
	/**
	 * Fraction of decisive verdicts won by presentation slot "A". Under
	 * seeded order randomization this should sit near 0.5; a large deviation
	 * means the judge has position bias and verdicts need scrutiny.
	 */
	positionAWinRate: number;
}

/**
 * Aggregate pairwise verdicts back onto head/tail items, undoing the
 * per-comparison presentation shuffle recorded in `swapped`.
 */
export function pairwiseWinRates(verdicts: readonly PairwiseVerdict[]): PairwiseWinRates {
	let headWins = 0;
	let tailWins = 0;
	let ties = 0;
	let slotAWins = 0;
	for (const { verdict, swapped } of verdicts) {
		if (verdict === "tie") {
			ties += 1;
			continue;
		}
		if (verdict === "A") slotAWins += 1;
		// Un-shuffle: when swapped, slot "A" held the tail item (itemB).
		const headWon = swapped ? verdict === "B" : verdict === "A";
		if (headWon) headWins += 1;
		else tailWins += 1;
	}
	const decisive = headWins + tailWins;
	return {
		total: verdicts.length,
		headWins,
		tailWins,
		ties,
		headWinRate: decisive === 0 ? Number.NaN : headWins / decisive,
		positionAWinRate: decisive === 0 ? Number.NaN : slotAWins / decisive,
	};
}

/* ------------------------------------------------------------------ */
/* Anchors: judge-reliability ground truth                             */
/* ------------------------------------------------------------------ */

/** What the judge is expected to flag for an anchor ("good" = nothing). */
export type AnchorExpectation = MqmCategory | "good";

export interface AnchorItem extends QualityItem {
	/** Stable id tying the anchor back to its origin item and defect type. */
	anchorId: string;
	expected: AnchorExpectation;
}

/** Filler/hedging fragments used to build over-verbosity anchors. */
const PADDING_PREFIXES = [
	"Please note that, generally speaking, ",
	"It is perhaps worth mentioning that, in most cases, ",
	"As you may already be aware, broadly speaking, ",
] as const;

const PADDING_SUFFIXES = [
	" — though of course this may vary somewhat depending on the circumstances.",
	" (at least, that is usually the case, more or less).",
	" — naturally, individual results and details may differ to some extent.",
] as const;

function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length > 0);
}

function splitWords(text: string): string[] {
	return text.split(/\s+/).filter((word) => word.length > 0);
}

/** Pick the index of the longest word — a proxy for "content word". */
function longestWordIndex(words: readonly string[]): number {
	let best = 0;
	for (let i = 1; i < words.length; i += 1) {
		const candidate = words[i];
		const current = words[best];
		if (candidate !== undefined && current !== undefined && candidate.length > current.length) {
			best = i;
		}
	}
	return best;
}

/**
 * Deliberate mistranslation: replace the longest content word with a content
 * word borrowed from another item's translation (same run, so plausibly the
 * same language), creating a semantic mismatch against the source.
 */
function mistranslateTarget(target: string, donorTarget: string, rng: () => number): string {
	const words = splitWords(target);
	if (words.length === 0) return "wrong";
	const victimIndex = longestWordIndex(words);
	const victim = words[victimIndex] ?? "";
	const donors = splitWords(donorTarget).filter(
		(word) => word.length >= 4 && word.toLowerCase() !== victim.toLowerCase(),
	);
	const donor = donors.length > 0 ? donors[Math.floor(rng() * donors.length)] : undefined;
	// Fallback: reversing the word still yields a wrong content word.
	words[victimIndex] = donor ?? victim.split("").reverse().join("");
	return words.join(" ");
}

/** Omission: drop the last sentence, or the trailing half of a one-sentence text. */
function omitFromTarget(target: string): string {
	const sentences = splitSentences(target);
	if (sentences.length > 1) {
		return sentences.slice(0, -1).join(" ");
	}
	const words = splitWords(target);
	if (words.length < 2) return "";
	const kept = words.slice(0, Math.ceil(words.length / 2));
	const result = kept.join(" ");
	// Guarantee the variant actually differs from the original.
	return result === target ? kept.slice(0, -1).join(" ") : result;
}

/** Over-verbosity anchor: wrap the translation in hedging absent from the source. */
function padTarget(target: string, rng: () => number): string {
	const prefix = PADDING_PREFIXES[Math.floor(rng() * PADDING_PREFIXES.length)] ?? "";
	const suffix = PADDING_SUFFIXES[Math.floor(rng() * PADDING_SUFFIXES.length)] ?? "";
	return `${prefix}${target}${suffix}`;
}

/**
 * Over-compression anchor: strip comma-bounded sub-clauses (detail/nuance),
 * falling back to keeping only the first sentence or first 60% of words —
 * terser than the source but, unlike the omission anchor, trimming texture
 * throughout rather than amputating the ending.
 */
function compressTarget(target: string): string {
	const declawed = target.replace(/,[^,.!?]*/g, "");
	if (declawed !== target && splitWords(declawed).length > 0) {
		return declawed.replace(/\s+/g, " ").trim();
	}
	const sentences = splitSentences(target);
	if (sentences.length > 1) {
		return sentences[0] ?? "";
	}
	const words = splitWords(target);
	if (words.length < 2) return target;
	return words.slice(0, Math.max(1, Math.ceil(words.length * 0.6))).join(" ");
}

/**
 * Derive known-bad variants ("anchors") from real translated items, plus
 * known-good passthroughs. The judge is run over these blind; anchorRecall
 * then tells us whether the judge's verdicts elsewhere can be trusted.
 *
 * Every input item yields all five anchor kinds, so even a small sample
 * exercises every defect category the benchmark cares about.
 */
export function plantAnchors(items: readonly QualityItem[], seed: number): AnchorItem[] {
	const rng = mulberry32(seed);
	const anchors: AnchorItem[] = [];
	for (let i = 0; i < items.length; i += 1) {
		const item = items[i];
		if (item === undefined) continue;
		const donor = items[(i + 1) % items.length] ?? item;
		const variants: ReadonlyArray<readonly [AnchorExpectation, string]> = [
			["mistranslation", mistranslateTarget(item.targetText, donor.targetText, rng)],
			["omission", omitFromTarget(item.targetText)],
			["over-verbosity", padTarget(item.targetText, rng)],
			["over-compression", compressTarget(item.targetText)],
			["good", item.targetText],
		];
		for (const [expected, targetText] of variants) {
			// A defect variant that failed to mutate (e.g. a one-word target that
			// cannot be compressed) would be a falsely-tagged anchor and unfairly
			// penalize the judge in anchorRecall — skip it.
			if (expected !== "good" && targetText === item.targetText) continue;
			anchors.push({
				...item,
				targetText,
				anchorId: `${item.key}::${expected}`,
				expected,
			});
		}
	}
	return anchors;
}

/** One judged anchor: what was planted vs. what the judge flagged. */
export interface JudgedAnchor {
	expected: AnchorExpectation;
	/** Categories of all errors the judge reported for this anchor. */
	flaggedCategories: readonly MqmCategory[];
}

export interface AnchorRecallResult {
	/** Planted defects the judge flagged with the right category / all defects. */
	recall: number;
	defectCount: number;
	caughtCount: number;
	/** Fraction of known-good anchors the judge (wrongly) flagged at all. */
	goodFalseAlarmRate: number;
}

/**
 * Fraction of planted defects the judge flagged with the correct category.
 * If this is low, the judge cannot reliably see the defects we know exist,
 * so its verdicts on real (unknown) items are inadmissible.
 */
export function anchorRecall(judged: readonly JudgedAnchor[]): AnchorRecallResult {
	let defectCount = 0;
	let caughtCount = 0;
	let goodCount = 0;
	let goodFlagged = 0;
	for (const anchor of judged) {
		if (anchor.expected === "good") {
			goodCount += 1;
			if (anchor.flaggedCategories.length > 0) goodFlagged += 1;
			continue;
		}
		defectCount += 1;
		if (anchor.flaggedCategories.includes(anchor.expected)) caughtCount += 1;
	}
	return {
		recall: defectCount === 0 ? Number.NaN : caughtCount / defectCount,
		defectCount,
		caughtCount,
		goodFalseAlarmRate: goodCount === 0 ? Number.NaN : goodFlagged / goodCount,
	};
}

/* ------------------------------------------------------------------ */
/* Reliability statistics                                              */
/* ------------------------------------------------------------------ */

/**
 * Agreement rate across re-judged samples: each pair is (first verdict,
 * repeat verdict) for the same item. A flaky judge (low self-consistency)
 * needs more repeats per item before its scores mean anything.
 */
export function selfConsistency(
	pairsOfRepeatVerdicts: ReadonlyArray<readonly [string, string]>,
): number {
	if (pairsOfRepeatVerdicts.length === 0) return Number.NaN;
	let agreements = 0;
	for (const [first, second] of pairsOfRepeatVerdicts) {
		if (first === second) agreements += 1;
	}
	return agreements / pairsOfRepeatVerdicts.length;
}

export interface CrossJudgeAgreement {
	/** Raw fraction of items where both judges gave the same label. */
	agreement: number;
	/**
	 * Cohen's kappa: agreement corrected for chance. Raw agreement can look
	 * high purely because both judges favor the same label; kappa exposes
	 * that. When expected chance agreement is 1 (both judges constant on the
	 * same label), kappa is defined here as 1 if they fully agree, else 0.
	 */
	kappa: number;
}

/**
 * Simple agreement plus Cohen's kappa between two judges labeling the same
 * items (verdictsA[i] and verdictsB[i] refer to item i).
 */
export function crossJudgeAgreement(
	verdictsA: readonly string[],
	verdictsB: readonly string[],
): CrossJudgeAgreement {
	if (verdictsA.length !== verdictsB.length) {
		throw new Error(
			`Judge verdict lists differ in length: ${verdictsA.length} vs ${verdictsB.length}`,
		);
	}
	const n = verdictsA.length;
	if (n === 0) {
		throw new Error("Cannot compute agreement on zero verdicts");
	}
	let observedAgreements = 0;
	const countsA = new Map<string, number>();
	const countsB = new Map<string, number>();
	for (let i = 0; i < n; i += 1) {
		const a = verdictsA[i];
		const b = verdictsB[i];
		if (a === undefined || b === undefined) continue;
		if (a === b) observedAgreements += 1;
		countsA.set(a, (countsA.get(a) ?? 0) + 1);
		countsB.set(b, (countsB.get(b) ?? 0) + 1);
	}
	const po = observedAgreements / n;
	let pe = 0;
	for (const [label, countA] of countsA) {
		const countB = countsB.get(label) ?? 0;
		pe += (countA / n) * (countB / n);
	}
	const kappa = pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
	return { agreement: po, kappa };
}
