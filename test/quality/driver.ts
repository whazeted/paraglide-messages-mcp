import { estimateTokens } from "../../src/core/budget.js";
import type { MessageValue } from "../../src/core/types.js";
import { pseudoTranslate } from "../large-fixture.js";

export { estimateTokens };

/**
 * LLM call layer for the translation-quality benchmark.
 *
 * Everything network-bound lives here so the benchmark sweep
 * (test/benchmark-quality.test.ts) and the judge module can stay pure
 * orchestration.
 *
 * Models are addressed by spec strings of the form `<provider>:<model>`
 * ("openai:gpt-5", "gemini:gemini-3.5-flash",
 * "anthropic:claude-opus-4-8"); a bare model id means Anthropic. Each
 * provider is gated on its own key (ANTHROPIC_API_KEY / OPENAI_API_KEY /
 * GEMINI_API_KEY): a call whose provider has no key runs in dry-run mode
 * (pseudoTranslate + synthesized token counts for translation, a canned stub
 * for judging), which keeps `pnpm test` and CI free, offline, and
 * deterministic. Live translation calls report the API's exact output-token
 * usage so per-item token numbers are anchored to what was actually billed.
 */

export interface ModelSpec {
	provider: "anthropic" | "openai" | "gemini";
	model: string;
}

/** `"openai:gpt-5"` → openai; bare model ids default to Anthropic. */
export function parseModelSpec(spec: string): ModelSpec {
	const colon = spec.indexOf(":");
	if (colon > 0) {
		const head = spec.slice(0, colon);
		if (head === "anthropic" || head === "openai" || head === "gemini") {
			return { provider: head, model: spec.slice(colon + 1) };
		}
	}
	return { provider: "anthropic", model: spec };
}

export function hasKeyFor(provider: ModelSpec["provider"]): boolean {
	if (provider === "openai") return Boolean(process.env.OPENAI_API_KEY);
	if (provider === "gemini") return Boolean(process.env.GEMINI_API_KEY);
	return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Translator model spec — env-overridable so sweeps can compare models. */
export const TRANSLATOR_MODEL =
	process.env.BENCH_TRANSLATOR_MODEL ?? "claude-sonnet-4-6";

/**
 * Judge model specs (comma-separated env list). Judges should differ from
 * the translator — ideally across providers — so self- and family-preference
 * bias can't inflate scores; with two or more judges the sweep also reports
 * cross-judge agreement.
 */
export const JUDGE_MODELS: string[] = (
	process.env.BENCH_JUDGE_MODELS ??
	process.env.BENCH_JUDGE_MODEL ??
	"claude-opus-4-8,gemini:gemini-3.5-flash"
)
	.split(",")
	.map((spec) => spec.trim())
	.filter((spec) => spec.length > 0);

/** First judge spec, for callers that only need one. */
export const JUDGE_MODEL = JUDGE_MODELS[0] ?? "claude-opus-4-8";

/** Canned judge reply for offline runs; kept JSON-ish so consumers can parse it. */
export const DRY_RUN_JUDGE_STUB =
	'{"score": 5, "rationale": "dry-run stub (provider API key not set)"}';

/**
 * Dry-run is decided per call (and per provider) so tests can toggle keys
 * via vi.stubEnv. No argument = the translator's provider, preserving the
 * original "is this sweep live" semantics.
 */
export function isDryRun(spec: string = TRANSLATOR_MODEL): boolean {
	return !hasKeyFor(parseModelSpec(spec).provider);
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

/**
 * One live model call, routed by provider. SDKs are imported lazily so
 * dry-run (and the provider you don't use) never touches their auth or even
 * loads their module. Anthropic calls stream to avoid SDK HTTP timeouts on
 * long outputs; both providers return the exact billed output-token count.
 */
async function callModelLive(
	spec: ModelSpec,
	prompt: string,
	maxTokens: number
): Promise<{ text: string; outputTokens: number }> {
	if (spec.provider === "gemini") {
		const { GoogleGenAI } = await import("@google/genai");
		const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
		const response = await client.models.generateContent({
			model: spec.model,
			contents: prompt,
			config: {
				maxOutputTokens: maxTokens,
			},
		});
		const usage = response.usageMetadata;
		return {
			text: response.text ?? "",
			outputTokens:
				usage?.candidatesTokenCount ??
				Math.max(
					0,
					(usage?.totalTokenCount ?? 0) -
						(usage?.promptTokenCount ?? 0) -
						(usage?.thoughtsTokenCount ?? 0)
				),
		};
	}
	if (spec.provider === "openai") {
		const { default: OpenAI } = await import("openai");
		const client = new OpenAI();
		const response = await client.chat.completions.create({
			model: spec.model,
			max_completion_tokens: maxTokens,
			messages: [{ role: "user", content: prompt }],
		});
		return {
			text: response.choices[0]?.message?.content ?? "",
			outputTokens: response.usage?.completion_tokens ?? 0,
		};
	}
	const { default: Anthropic } = await import("@anthropic-ai/sdk");
	const client = new Anthropic();
	const stream = client.messages.stream({
		model: spec.model,
		max_tokens: maxTokens,
		messages: [{ role: "user", content: prompt }],
	});
	const response = await stream.finalMessage();
	return {
		text: response.content
			.flatMap((block: { type: string; text?: string }) =>
				block.type === "text" ? [block.text ?? ""] : []
			)
			.join(""),
		outputTokens: response.usage.output_tokens,
	};
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
		return { items: [], totalOutputTokens: 0, model, dryRun: isDryRun(model) };
	}

	let values: Map<string, MessageValue>;
	let totalOutputTokens: number;
	let dryRun: boolean;

	if (isDryRun(model)) {
		dryRun = true;
		values = new Map(
			args.items.map((item) => [
				item.key,
				pseudoTranslate(item.source, args.targetLocale),
			])
		);
		// Synthesize the "call total" from the same estimator used for the
		// per-item weights, so dry-run rows are internally consistent.
		totalOutputTokens = Math.round(
			args.items.reduce(
				(sum, item) =>
					sum + estimateTokens(textOf(values.get(item.key) ?? item.source)),
				0
			)
		);
	} else {
		dryRun = false;
		// 32k output headroom: an uncapped (budget 0) batch of long corpus
		// passages is the longest single generation the sweep produces.
		const { text, outputTokens } = await callModelLive(
			parseModelSpec(model),
			buildTranslationPrompt(args.items, args.sourceLocale, args.targetLocale),
			32000
		);
		totalOutputTokens = outputTokens;
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
	const spec = parseModelSpec(model ?? JUDGE_MODEL);
	if (!hasKeyFor(spec.provider)) return DRY_RUN_JUDGE_STUB;
	const { text } = await callModelLive(spec, prompt, 16000);
	return text;
}
