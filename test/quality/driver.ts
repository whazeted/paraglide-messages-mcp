import type { MessageValue } from "../../src/core/types.js";
import { pseudoTranslate } from "../large-fixture.js";

/**
 * LLM call layer for the translation-quality benchmark.
 *
 * Everything network-bound lives here so the benchmark sweep
 * (test/benchmark-quality.test.ts) and the judge module can stay pure
 * orchestration. Two modes:
 *
 * - Real mode (ANTHROPIC_API_KEY set): translateBatch sends one Messages API
 *   call per batch and reports the call's EXACT `usage.output_tokens`, so
 *   per-item token numbers are anchored to what the API actually billed.
 * - Dry-run mode (no key): pseudoTranslate stands in for the model and token
 *   counts are synthesized with estimateTokens. This keeps `pnpm test` and
 *   CI free, offline, and deterministic.
 */

/** Translator model — env-overridable so sweeps can compare models. */
export const TRANSLATOR_MODEL =
	process.env.BENCH_TRANSLATOR_MODEL ?? "claude-sonnet-4-6";

/**
 * Judge model — deliberately a different model family than the translator to
 * avoid judge self-preference bias when grading translations.
 */
export const JUDGE_MODEL = process.env.BENCH_JUDGE_MODEL ?? "claude-opus-4-8";

/** Canned judge reply for offline runs; kept JSON-ish so consumers can parse it. */
export const DRY_RUN_JUDGE_STUB =
	'{"score": 5, "rationale": "dry-run stub (ANTHROPIC_API_KEY not set)"}';

/** Dry-run is decided per call so tests can toggle the key via vi.stubEnv. */
export function isDryRun(): boolean {
	return !process.env.ANTHROPIC_API_KEY;
}

/**
 * Local mirrors of src/core/budget.ts (landing in a sibling PR of this
 * benchmark effort). Kept here so this unit compiles and runs standalone;
 * once budget.ts is merged these can be swapped for direct imports. The
 * 4-chars-per-token heuristic matches the budget module's estimator.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Plain-text projection of a message value (variant matches joined). */
export function textOf(value: MessageValue): string {
	if (typeof value === "string") return value;
	return value
		.flatMap((variant) => Object.values(variant.match))
		.join(" ");
}

export interface BatchItem {
	key: string;
	/** Source-locale value; complex (variant) messages are passed through as-is. */
	source: MessageValue;
}

export interface TranslatedItem {
	key: string;
	/** Translated value, same shape as the source when the model cooperates. */
	value: MessageValue;
	/** This item's share of the call's output tokens (sums to the call total). */
	outputTokensForItem: number;
	/** Running output-token sum at the moment this item finished emitting. */
	cumulativeOutputTokensAtEmission: number;
}

export interface TranslateBatchResult {
	items: TranslatedItem[];
	/** Exact `usage.output_tokens` of the call (synthesized in dry-run mode). */
	totalOutputTokens: number;
	model: string;
	dryRun: boolean;
}

/**
 * Apportions a call-level token total across items proportionally to the
 * given weights. Uses cumulative rounding (round the running fraction, then
 * diff) so the per-item integers always sum to exactly `total` and the
 * cumulative series is monotonically non-decreasing — both properties the
 * benchmark's decay analysis depends on. Zero total weight falls back to an
 * even split, since "no signal" should not mean "no attribution".
 */
export function apportionTokens(
	weights: number[],
	total: number
): { perItem: number[]; cumulative: number[] } {
	const n = weights.length;
	if (n === 0) return { perItem: [], cumulative: [] };
	const weightSum = weights.reduce((sum, w) => sum + w, 0);
	const perItem: number[] = [];
	const cumulative: number[] = [];
	let runningWeight = 0;
	let previousCumulative = 0;
	for (let i = 0; i < n; i++) {
		runningWeight += weights[i]!;
		const exactCumulative =
			weightSum > 0
				? (total * runningWeight) / weightSum
				: (total * (i + 1)) / n;
		const roundedCumulative = Math.round(exactCumulative);
		perItem.push(roundedCumulative - previousCumulative);
		cumulative.push(roundedCumulative);
		previousCumulative = roundedCumulative;
	}
	return { perItem, cumulative };
}

/**
 * Pulls a JSON array out of model output. Models love wrapping JSON in code
 * fences or prose, so we strip fences first and then fall back to the
 * outermost `[...]` slice before giving up.
 */
export function parseTranslationArray(
	raw: string
): Array<{ key: string; value: MessageValue }> {
	const unfenced = raw
		.replace(/```[a-zA-Z]*\s*\n?/g, "")
		.replace(/```/g, "")
		.trim();
	const candidates = [unfenced];
	const start = unfenced.indexOf("[");
	const end = unfenced.lastIndexOf("]");
	if (start !== -1 && end > start) {
		candidates.push(unfenced.slice(start, end + 1));
	}
	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (Array.isArray(parsed)) {
				return parsed.filter(
					(entry): entry is { key: string; value: MessageValue } =>
						typeof entry === "object" &&
						entry !== null &&
						typeof (entry as { key?: unknown }).key === "string" &&
						(entry as { value?: unknown }).value !== undefined
				);
			}
		} catch {
			// try the next candidate
		}
	}
	throw new Error(
		`could not parse a JSON array from model output: ${raw.slice(0, 200)}`
	);
}

/** Lazy SDK construction so dry-run never touches @anthropic-ai/sdk auth. */
async function createClient() {
	const { default: Anthropic } = await import("@anthropic-ai/sdk");
	return new Anthropic();
}

function buildTranslationPrompt(
	items: BatchItem[],
	sourceLocale: string,
	targetLocale: string
): string {
	const payload = items.map((item) => ({ key: item.key, source: item.source }));
	return [
		`Translate the following UI message items from locale "${sourceLocale}" to locale "${targetLocale}".`,
		"",
		"Rules:",
		"- Preserve any {placeholder} tokens exactly as written (same name, same braces).",
		'- If a source is a JSON variant array (objects with a "match" map), return the same shape with only the match values translated.',
		'- Respond with ONLY a JSON array of objects: [{"key": "...", "value": ...}, ...] — one entry per input item, using the exact same keys, in the same order.',
		"",
		"Items:",
		JSON.stringify(payload, null, 2),
	].join("\n");
}

/**
 * Translates one batch of message items.
 *
 * Per-item token attribution: the call reports only one exact
 * `usage.output_tokens`, so each item's share is apportioned proportionally
 * to estimateTokens(textOf(item value)) — the same estimator the server-side
 * budget logic uses — and `cumulativeOutputTokensAtEmission` is the running
 * sum in emission (item) order. That cumulative position is the x-axis of
 * the quality-decay analysis.
 */
export async function translateBatch(args: {
	items: BatchItem[];
	targetLocale: string;
	sourceLocale: string;
	model?: string;
}): Promise<TranslateBatchResult> {
	const model = args.model ?? TRANSLATOR_MODEL;
	if (args.items.length === 0) {
		return { items: [], totalOutputTokens: 0, model, dryRun: isDryRun() };
	}

	let values: Map<string, MessageValue>;
	let totalOutputTokens: number;
	let dryRun: boolean;

	if (isDryRun()) {
		dryRun = true;
		values = new Map(
			args.items.map((item) => [
				item.key,
				pseudoTranslate(item.source, args.targetLocale),
			])
		);
		// Synthesize the "call total" from the same estimator used for the
		// per-item weights, so dry-run rows are internally consistent.
		totalOutputTokens = args.items.reduce(
			(sum, item) =>
				sum + estimateTokens(textOf(values.get(item.key) ?? item.source)),
			0
		);
	} else {
		dryRun = false;
		const client = await createClient();
		// Streaming avoids SDK HTTP timeouts on long outputs: an uncapped
		// (budget 0) batch of long corpus passages can exceed what a
		// non-streaming request reliably returns.
		const stream = client.messages.stream({
			model,
			max_tokens: 32000,
			messages: [
				{
					role: "user",
					content: buildTranslationPrompt(
						args.items,
						args.sourceLocale,
						args.targetLocale
					),
				},
			],
		});
		const response = await stream.finalMessage();
		const text = response.content
			.flatMap((block: { type: string; text?: string }) =>
				block.type === "text" ? [block.text ?? ""] : []
			)
			.join("");
		totalOutputTokens = response.usage.output_tokens;
		const parsed = parseTranslationArray(text);
		values = new Map(parsed.map((entry) => [entry.key, entry.value]));
	}

	// Items the model dropped still get a row (with the source echoed back),
	// so positional analysis never has holes; their weight reflects the echo.
	const resolved = args.items.map((item) => ({
		key: item.key,
		value: values.get(item.key) ?? item.source,
	}));
	const { perItem, cumulative } = apportionTokens(
		resolved.map((item) => estimateTokens(textOf(item.value))),
		totalOutputTokens
	);
	return {
		items: resolved.map((item, i) => ({
			key: item.key,
			value: item.value,
			outputTokensForItem: perItem[i]!,
			cumulativeOutputTokensAtEmission: cumulative[i]!,
		})),
		totalOutputTokens,
		model,
		dryRun,
	};
}

/**
 * Sends a prompt to the judge model and returns the raw response text.
 * The sibling judge module owns prompt construction and parsing; this layer
 * only guarantees "text in, text out" plus the offline stub.
 */
export async function callJudge(
	prompt: string,
	model?: string
): Promise<string> {
	if (isDryRun()) return DRY_RUN_JUDGE_STUB;
	const client = await createClient();
	const response = await client.messages.create({
		model: model ?? JUDGE_MODEL,
		max_tokens: 16000,
		messages: [{ role: "user", content: prompt }],
	});
	return response.content
		.flatMap((block: { type: string; text?: string }) =>
				block.type === "text" ? [block.text ?? ""] : []
			)
		.join("");
}
