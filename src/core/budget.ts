import { MIN_CALIBRATION_KEYS } from "./constants.js";
import { isEmptyValue, patternsOf } from "./format.js";
import type { MessagesSnapshot, MessageValue } from "./types.js";

/**
 * Predicted-output-token batch budgeting.
 *
 * Translation quality degrades with how much a model must GENERATE in one
 * response, not with how much it reads: deep into a long emission,
 * translations drift formulaic, and a `max_tokens` truncation mid-JSON fails
 * the whole save call. So batches are cut by predicted output tokens, not by
 * item count alone.
 *
 * Exact token counts are impossible in principle — the server cannot know
 * the client model's tokenizer — but BPE tokenizers agree closely on
 * per-script densities, so a character-class estimate lands within ~15% of
 * any of them. For deciding where to cut a batch, that is indistinguishable
 * from exact.
 */

/** The translatable text of a message value (all patterns, concatenated). */
export function textOf(value: MessageValue): string {
	return patternsOf(value).join("");
}

/**
 * Tokens of the per-item JSON wrapper a translating agent emits around each
 * translation ( `{"key": "...", "value": "..."}` — braces, quotes, field
 * names, comma). A constant because the wrapper is the same for every item.
 */
const ITEM_WRAPPER_TOKENS = 10;

/**
 * Estimated tokens of the structural emission for one item beyond its
 * translated text: the echoed message key, the JSON wrapper, and — for
 * variant messages — the declarations/selectors/match scaffolding the agent
 * must reproduce. Measured from the serialized value minus its pattern text,
 * so a heavily-structured plural message is budgeted for what emitting it
 * actually costs. Quality decays with TOTAL generated tokens, and for short
 * UI strings this envelope can approach half the real emission — text-only
 * prediction would systematically under-budget exactly those batches.
 */
export function emissionOverheadTokens(
	key: string,
	source: MessageValue
): number {
	let overhead = ITEM_WRAPPER_TOKENS + estimateTokens(key);
	if (typeof source !== "string") {
		const structuralChars = Math.max(
			0,
			JSON.stringify(source).length - textOf(source).length
		);
		// JSON scaffolding is ASCII: ~4 chars per token
		overhead += structuralChars * 0.25;
	}
	return overhead;
}

/**
 * Predicted output tokens for translating one source message — the full
 * emission, not just the translated text: structural overhead (key, JSON
 * wrapper, variant scaffolding) plus the predicted text tokens.
 *
 * For the text component: with a calibrated coefficient (the locale pair's
 * measured output-tokens-per-source-char ratio), the prediction scales the
 * source length by it. Before calibration, the source text's own estimated
 * tokens serve as the floor: translations are rarely shorter than their
 * source in token terms, so this under-estimates conservatively — it is
 * measured from data in hand, not guessed from the locale tag — and keeps a
 * fresh prose-heavy locale from shipping giant batches before calibration
 * can ever happen. The calibrated coefficient is text-vs-text (stored
 * translations contain no envelope), so adding the overhead here never
 * double-counts it.
 */
export function predictOutputTokens(
	key: string,
	source: MessageValue,
	coefficient: number | null
): number {
	const text = textOf(source);
	const textTokens =
		coefficient === null ? estimateTokens(text) : coefficient * text.length;
	return textTokens + emissionOverheadTokens(key, source);
}

/**
 * Estimated tokens of a text, by Unicode script class: Latin-script prose
 * runs ~4 chars/token, CJK ~1.2, other non-Latin scripts ~2.5.
 */
export function estimateTokens(text: string): number {
	let tokens = 0;
	for (const char of text) {
		tokens += tokenWeight(char.codePointAt(0)!);
	}
	return tokens;
}

function tokenWeight(codePoint: number): number {
	// CJK ideographs, kana, hangul, CJK punctuation
	if (
		(codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7af) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0x20000 && codePoint <= 0x2ffff)
	) {
		return 0.8;
	}
	// other non-Latin scripts (Greek, Cyrillic, Hebrew, Arabic, Indic, Thai, …)
	if (codePoint >= 0x0370 && codePoint <= 0x1fff) {
		return 0.4;
	}
	// Latin, digits, punctuation, whitespace
	return 0.25;
}

/**
 * Predicted output tokens per source character for a locale pair, measured
 * from the project's own translations: the median per-key ratio of estimated
 * target tokens to source characters over keys translated in both locales.
 * The median (not the mean or ratio-of-sums) keeps a handful of
 * unrepresentative keys — translation happens in waves, e.g. all short UI
 * labels first — from skewing the estimate.
 *
 * Returns null below MIN_CALIBRATION_KEYS samples: the budget only ever
 * cuts batches from measured data, never from a guessed coefficient.
 * Uncalibrated locales batch by message count alone.
 */
export function outputTokensPerSourceChar(
	snapshot: MessagesSnapshot,
	sourceLocale: string,
	targetLocale: string
): number | null {
	const sourceMessages = snapshot[sourceLocale];
	const targetMessages = snapshot[targetLocale];
	if (!sourceMessages || !targetMessages) {
		return null;
	}

	const ratios: number[] = [];
	for (const [key, targetValue] of Object.entries(targetMessages)) {
		const sourceValue = sourceMessages[key];
		if (isEmptyValue(targetValue) || isEmptyValue(sourceValue)) continue;
		const sourceChars = textOf(sourceValue!).length;
		if (sourceChars === 0) continue;
		ratios.push(estimateTokens(textOf(targetValue)) / sourceChars);
	}

	if (ratios.length < MIN_CALIBRATION_KEYS) {
		return null;
	}
	return median(ratios);
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[mid]!
		: (sorted[mid - 1]! + sorted[mid]!) / 2;
}
