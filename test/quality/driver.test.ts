import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apportionTokens,
	callJudge,
	DRY_RUN_JUDGE_STUB,
	estimateTokens,
	isDryRun,
	parseTranslationArray,
	textOf,
	translateBatch,
} from "./driver.js";

/**
 * Offline unit tests for the LLM driver. ANTHROPIC_API_KEY is stubbed to ""
 * (falsy) for every test so the suite stays deterministic and network-free
 * even on machines where a real key is exported.
 */

beforeEach(() => {
	vi.stubEnv("ANTHROPIC_API_KEY", "");
	vi.stubEnv("GEMINI_API_KEY", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("dry-run translateBatch", () => {
	it("returns one translated item per input, preserving keys and order", async () => {
		const result = await translateBatch({
			items: [
				{ key: "greeting", source: "Hello {name}!" },
				{ key: "checkout_title", source: "Checkout" },
				{
					key: "inbox_count",
					source: [
						{
							declarations: ["input count"],
							selectors: ["countPlural"],
							match: {
								"countPlural=one": "You have {count} message",
								"countPlural=other": "You have {count} messages",
							},
						},
					],
				},
			],
			targetLocale: "de",
			sourceLocale: "en",
		});

		expect(isDryRun()).toBe(true);
		expect(result.dryRun).toBe(true);
		expect(result.items.map((i) => i.key)).toEqual([
			"greeting",
			"checkout_title",
			"inbox_count",
		]);
		// pseudoTranslate tags simple strings and keeps placeholders intact
		expect(result.items[0]!.value).toBe("DE:Hello {name}!");
		// complex messages keep their variant shape
		const complex = result.items[2]!.value;
		expect(Array.isArray(complex)).toBe(true);
		expect(textOf(complex)).toContain("{count}");
	});

	it("synthesizes a call total that the per-item tokens sum to exactly", async () => {
		const result = await translateBatch({
			items: [
				{ key: "a", source: "short" },
				{ key: "b", source: "a noticeably longer source sentence with words" },
				{ key: "c", source: "" },
			],
			targetLocale: "ja",
			sourceLocale: "en",
		});

		const sum = result.items.reduce((s, i) => s + i.outputTokensForItem, 0);
		expect(sum).toBe(result.totalOutputTokens);
		expect(result.totalOutputTokens).toBeGreaterThan(0);
	});

	it("produces a monotonically non-decreasing cumulative series ending at the total", async () => {
		const result = await translateBatch({
			items: Array.from({ length: 10 }, (_, i) => ({
				key: `k${i}`,
				source: `message number ${i} with some padding text`,
			})),
			targetLocale: "de",
			sourceLocale: "en",
		});

		let previous = 0;
		let running = 0;
		for (const item of result.items) {
			running += item.outputTokensForItem;
			expect(item.cumulativeOutputTokensAtEmission).toBe(running);
			expect(item.cumulativeOutputTokensAtEmission).toBeGreaterThanOrEqual(
				previous
			);
			previous = item.cumulativeOutputTokensAtEmission;
		}
		expect(previous).toBe(result.totalOutputTokens);
	});

	it("handles an empty batch", async () => {
		const result = await translateBatch({
			items: [],
			targetLocale: "de",
			sourceLocale: "en",
		});
		expect(result.items).toEqual([]);
		expect(result.totalOutputTokens).toBe(0);
	});
});

describe("apportionTokens", () => {
	it("sums to the call total for uneven weights", () => {
		const weights = [3, 1, 7, 2, 5];
		const { perItem, cumulative } = apportionTokens(weights, 1043);
		expect(perItem.reduce((s, t) => s + t, 0)).toBe(1043);
		expect(cumulative[cumulative.length - 1]).toBe(1043);
	});

	it("never decreases the cumulative series, even with zero weights", () => {
		const { perItem, cumulative } = apportionTokens([0, 5, 0, 0, 2], 97);
		expect(perItem.reduce((s, t) => s + t, 0)).toBe(97);
		for (let i = 1; i < cumulative.length; i++) {
			expect(cumulative[i]!).toBeGreaterThanOrEqual(cumulative[i - 1]!);
		}
	});

	it("splits evenly when all weights are zero", () => {
		const { perItem } = apportionTokens([0, 0, 0, 0], 10);
		expect(perItem.reduce((s, t) => s + t, 0)).toBe(10);
		// even split of 10 over 4 → 2.5 each; cumulative rounding gives 3/2/3/2
		for (const tokens of perItem) {
			expect(Math.abs(tokens - 2.5)).toBeLessThanOrEqual(0.5);
		}
	});
});

describe("parseTranslationArray", () => {
	const expected = [
		{ key: "a", value: "Hallo" },
		{ key: "b", value: "Welt" },
	];
	const json = JSON.stringify(expected);

	it("parses plain JSON", () => {
		expect(parseTranslationArray(json)).toEqual(expected);
	});

	it("parses fenced JSON (```json blocks)", () => {
		expect(parseTranslationArray(`\`\`\`json\n${json}\n\`\`\``)).toEqual(
			expected
		);
	});

	it("parses JSON surrounded by prose", () => {
		const raw = `Here are the translations you asked for:\n\n${json}\n\nLet me know if you need adjustments.`;
		expect(parseTranslationArray(raw)).toEqual(expected);
	});

	it("drops malformed entries instead of failing the batch", () => {
		const raw = JSON.stringify([
			{ key: "a", value: "Hallo" },
			{ value: "missing key" },
			"not an object",
		]);
		expect(parseTranslationArray(raw)).toEqual([{ key: "a", value: "Hallo" }]);
	});

	it("throws on output with no JSON array at all", () => {
		expect(() => parseTranslationArray("Sorry, I cannot do that.")).toThrow(
			/could not parse/
		);
	});
});

describe("callJudge (dry-run)", () => {
	it("returns the canned stub without touching the network", async () => {
		const raw = await callJudge("score this translation 1-5: ...");
		expect(raw).toBe(DRY_RUN_JUDGE_STUB);
		// consumers parse judge output as JSON — the stub must round-trip
		expect(() => JSON.parse(raw)).not.toThrow();
	});
});

describe("estimateTokens / textOf", () => {
	it("uses the production script-aware token estimator", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(1.25);
		expect(estimateTokens("日本語")).toBeCloseTo(2.4);
	});

	it("projects complex messages to their variant texts", () => {
		expect(
			textOf([
				{ match: { "x=one": "one thing", "x=other": "many things" } },
			])
		).toBe("one thing many things");
	});
});

describe("parseModelSpec / provider gating", () => {
	it("parses provider prefixes and defaults bare ids to anthropic", async () => {
		const { parseModelSpec } = await import("./driver.js");
		expect(parseModelSpec("openai:gpt-5")).toEqual({
			provider: "openai",
			model: "gpt-5",
		});
		expect(parseModelSpec("gemini:gemini-3.5-flash")).toEqual({
			provider: "gemini",
			model: "gemini-3.5-flash",
		});
		expect(parseModelSpec("anthropic:claude-opus-4-8")).toEqual({
			provider: "anthropic",
			model: "claude-opus-4-8",
		});
		expect(parseModelSpec("claude-sonnet-4-6")).toEqual({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
		});
		// model ids may themselves contain colons after the provider prefix
		expect(parseModelSpec("openai:org:custom")).toEqual({
			provider: "openai",
			model: "org:custom",
		});
	});

	it("gates each provider on its own key", async () => {
		const { hasKeyFor, isDryRun } = await import("./driver.js");
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		vi.stubEnv("GEMINI_API_KEY", "test-key");
		expect(hasKeyFor("anthropic")).toBe(false);
		expect(hasKeyFor("openai")).toBe(true);
		expect(hasKeyFor("gemini")).toBe(true);
		expect(isDryRun("claude-sonnet-4-6")).toBe(true);
		expect(isDryRun("openai:gpt-5")).toBe(false);
		expect(isDryRun("gemini:gemini-3.5-flash")).toBe(false);
		vi.unstubAllEnvs();
	});

	it("stubs the judge only when its own provider lacks a key", async () => {
		const { callJudge, DRY_RUN_JUDGE_STUB } = await import("./driver.js");
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("GEMINI_API_KEY", "");
		expect(await callJudge("prompt", "openai:gpt-5")).toBe(DRY_RUN_JUDGE_STUB);
		expect(await callJudge("prompt", "gemini:gemini-3.5-flash")).toBe(
			DRY_RUN_JUDGE_STUB
		);
		expect(await callJudge("prompt", "anthropic:claude-opus-4-8")).toBe(
			DRY_RUN_JUDGE_STUB
		);
		vi.unstubAllEnvs();
	});
});
