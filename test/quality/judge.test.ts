import { describe, expect, it } from "vitest";

import {
	anchorRecall,
	buildMqmPrompt,
	buildPairwisePrompt,
	crossJudgeAgreement,
	mqmScore,
	pairwiseWinRates,
	parseMqmResponse,
	parsePairwiseResponse,
	plantAnchors,
	selfConsistency,
	type MqmError,
	type PairwiseVerdict,
	type QualityItem,
} from "./judge.js";

/** Sentinel values that must never leak into a judge prompt. */
const SENTINEL_POSITION = 7777;
const SENTINEL_BATCH_COUNT = 8888;
const SENTINEL_CHARS = 9999;

function makeItem(overrides: Partial<QualityItem> = {}): QualityItem {
	return {
		key: "checkout_create_subscription_001",
		positionInBatch: SENTINEL_POSITION,
		batchItemCount: SENTINEL_BATCH_COUNT,
		sourceText:
			"Your subscription was created successfully. You will receive a confirmation email shortly, and your first invoice arrives next week.",
		targetText:
			"Je abonnement is succesvol aangemaakt. Je ontvangt binnenkort een bevestigingsmail, en je eerste factuur komt volgende week.",
		targetLocale: "nl",
		sourceChars: SENTINEL_CHARS,
		...overrides,
	};
}

describe("buildMqmPrompt", () => {
	it("includes the source text, target text, and locale pair", () => {
		const item = makeItem();
		const prompt = buildMqmPrompt(item);
		expect(prompt).toContain(item.sourceText);
		expect(prompt).toContain(item.targetText);
		expect(prompt).toContain(item.targetLocale);
		expect(prompt).toContain("en");
	});

	it("lists all seven error categories including verbosity asymmetries", () => {
		const prompt = buildMqmPrompt(makeItem());
		for (const category of [
			"mistranslation",
			"omission",
			"addition",
			"untranslated",
			"grammar",
			"over-verbosity",
			"over-compression",
		]) {
			expect(prompt).toContain(category);
		}
	});

	it("never leaks batch position, batch size, or budget (blindness)", () => {
		const prompt = buildMqmPrompt(makeItem());
		expect(prompt).not.toContain(String(SENTINEL_POSITION));
		expect(prompt).not.toContain(String(SENTINEL_BATCH_COUNT));
		expect(prompt).not.toContain(String(SENTINEL_CHARS));
		expect(prompt.toLowerCase()).not.toContain("position");
		expect(prompt.toLowerCase()).not.toContain("batch");
		expect(prompt.toLowerCase()).not.toContain("budget");
		expect(prompt.toLowerCase()).not.toContain("token");
	});
});

describe("parseMqmResponse", () => {
	const validError = {
		category: "omission",
		severity: "major",
		evidence: "your first invoice arrives next week",
	};

	it("parses a bare JSON array", () => {
		const parsed = parseMqmResponse(JSON.stringify([validError]));
		expect(parsed).toEqual([validError]);
	});

	it("parses an empty array as zero errors", () => {
		expect(parseMqmResponse("[]")).toEqual([]);
	});

	it("parses JSON inside a fenced code block", () => {
		const raw = "```json\n" + JSON.stringify([validError]) + "\n```";
		expect(parseMqmResponse(raw)).toEqual([validError]);
	});

	it("parses JSON wrapped in prose", () => {
		const raw =
			"Sure! Here are the errors I found:\n" +
			JSON.stringify([validError]) +
			"\nLet me know if you need anything else.";
		expect(parseMqmResponse(raw)).toEqual([validError]);
	});

	it("accepts an {errors: [...]} wrapper object", () => {
		const raw = JSON.stringify({ errors: [validError] });
		expect(parseMqmResponse(raw)).toEqual([validError]);
	});

	it("throws (does not crash) on malformed responses", () => {
		expect(() => parseMqmResponse("I could not evaluate this.")).toThrow();
		expect(() => parseMqmResponse("[{broken json")).toThrow();
		expect(() => parseMqmResponse('{"verdict": "A"}')).toThrow();
		expect(() =>
			parseMqmResponse(JSON.stringify([{ category: "nonsense", severity: "major", evidence: "x" }])),
		).toThrow();
		expect(() =>
			parseMqmResponse(JSON.stringify([{ category: "omission", severity: "huge", evidence: "x" }])),
		).toThrow();
		expect(() =>
			parseMqmResponse(JSON.stringify([{ category: "omission", severity: "major" }])),
		).toThrow();
	});
});

describe("mqmScore", () => {
	it("weights severities 1/5/10 per 100 source words", () => {
		const errors: MqmError[] = [
			{ category: "grammar", severity: "minor", evidence: "a" },
			{ category: "omission", severity: "major", evidence: "b" },
			{ category: "mistranslation", severity: "critical", evidence: "c" },
		];
		// (1 + 5 + 10) / 50 * 100 = 32
		expect(mqmScore(errors, 50)).toBeCloseTo(32);
	});

	it("returns 0 for a clean translation", () => {
		expect(mqmScore([], 20)).toBe(0);
	});

	it("rejects non-positive word counts", () => {
		expect(() => mqmScore([], 0)).toThrow();
		expect(() => mqmScore([], -3)).toThrow();
	});
});

describe("buildPairwisePrompt", () => {
	const head = makeItem({ key: "head_item", targetText: "Vertaling van het begin." });
	const tail = makeItem({ key: "tail_item", targetText: "Vertaling van het einde." });

	it("includes both sources and both translations", () => {
		const { prompt } = buildPairwisePrompt(head, tail, 1);
		expect(prompt).toContain(head.sourceText);
		expect(prompt).toContain(head.targetText);
		expect(prompt).toContain(tail.targetText);
	});

	it("never leaks batch position, batch size, or budget (blindness)", () => {
		const { prompt } = buildPairwisePrompt(head, tail, 1);
		expect(prompt).not.toContain(String(SENTINEL_POSITION));
		expect(prompt).not.toContain(String(SENTINEL_BATCH_COUNT));
		expect(prompt).not.toContain(String(SENTINEL_CHARS));
		expect(prompt.toLowerCase()).not.toContain("position");
		expect(prompt.toLowerCase()).not.toContain("batch");
		expect(prompt.toLowerCase()).not.toContain("budget");
	});

	it("is deterministic for a given seed", () => {
		const first = buildPairwisePrompt(head, tail, 42);
		const second = buildPairwisePrompt(head, tail, 42);
		expect(second.prompt).toBe(first.prompt);
		expect(second.swapped).toBe(first.swapped);
	});

	it("produces both presentation orders across seeds", () => {
		const swappedValues = new Set<boolean>();
		for (let seed = 0; seed < 100; seed += 1) {
			swappedValues.add(buildPairwisePrompt(head, tail, seed).swapped);
		}
		expect(swappedValues).toEqual(new Set([true, false]));
	});

	it("puts itemB first when swapped, itemA first otherwise", () => {
		// Find one seed per order so we can assert the slot mapping directly.
		let straight: string | undefined;
		let flipped: string | undefined;
		for (let seed = 0; seed < 100 && (!straight || !flipped); seed += 1) {
			const built = buildPairwisePrompt(head, tail, seed);
			if (built.swapped) flipped ??= built.prompt;
			else straight ??= built.prompt;
		}
		expect(straight).toBeDefined();
		expect(flipped).toBeDefined();
		// In the straight order, head's translation appears before tail's.
		expect(straight!.indexOf(head.targetText)).toBeLessThan(straight!.indexOf(tail.targetText));
		expect(flipped!.indexOf(tail.targetText)).toBeLessThan(flipped!.indexOf(head.targetText));
	});
});

describe("parsePairwiseResponse", () => {
	it("parses a verdict JSON object", () => {
		expect(parsePairwiseResponse('{"verdict": "A"}')).toBe("A");
		expect(parsePairwiseResponse('{"verdict": "B"}')).toBe("B");
		expect(parsePairwiseResponse('{"verdict": "tie"}')).toBe("tie");
	});

	it("parses fenced and prose-wrapped verdicts", () => {
		expect(parsePairwiseResponse('```json\n{"verdict": "B"}\n```')).toBe("B");
		expect(parsePairwiseResponse('After careful review: {"verdict": "tie"} is my call.')).toBe(
			"tie",
		);
	});

	it("parses bare verdict strings case-insensitively", () => {
		expect(parsePairwiseResponse("A")).toBe("A");
		expect(parsePairwiseResponse(" b ")).toBe("B");
		expect(parsePairwiseResponse('"TIE"')).toBe("tie");
	});

	it("throws on malformed responses", () => {
		expect(() => parsePairwiseResponse("Both translations are fine.")).toThrow();
		expect(() => parsePairwiseResponse('{"verdict": "C"}')).toThrow();
		expect(() => parsePairwiseResponse("")).toThrow();
	});
});

describe("pairwiseWinRates", () => {
	it("un-shuffles positional verdicts back onto head/tail", () => {
		const verdicts: PairwiseVerdict[] = [
			{ verdict: "A", swapped: false }, // head shown as A, head wins
			{ verdict: "A", swapped: true }, // tail shown as A, tail wins
			{ verdict: "B", swapped: true }, // head shown as B, head wins
			{ verdict: "tie", swapped: false },
		];
		const rates = pairwiseWinRates(verdicts);
		expect(rates.total).toBe(4);
		expect(rates.headWins).toBe(2);
		expect(rates.tailWins).toBe(1);
		expect(rates.ties).toBe(1);
		expect(rates.headWinRate).toBeCloseTo(2 / 3);
		// Slot "A" won twice out of three decisive verdicts.
		expect(rates.positionAWinRate).toBeCloseTo(2 / 3);
	});

	it("reports ~50% position-A rate when wins are position-balanced", () => {
		const verdicts: PairwiseVerdict[] = [
			{ verdict: "A", swapped: false },
			{ verdict: "B", swapped: true },
			{ verdict: "A", swapped: true },
			{ verdict: "B", swapped: false },
		];
		expect(pairwiseWinRates(verdicts).positionAWinRate).toBeCloseTo(0.5);
	});

	it("returns NaN rates when there are no decisive verdicts", () => {
		const rates = pairwiseWinRates([{ verdict: "tie", swapped: false }]);
		expect(Number.isNaN(rates.headWinRate)).toBe(true);
		expect(Number.isNaN(rates.positionAWinRate)).toBe(true);
	});
});

describe("plantAnchors", () => {
	const items: QualityItem[] = [
		makeItem({ key: "item_one" }),
		makeItem({
			key: "item_two",
			sourceText:
				"The shared document was archived last month. Restore it from the folder, or download a secure copy before the receipt expires.",
			targetText:
				"Het gedeelde document is vorige maand gearchiveerd. Herstel het vanuit de map, of download een beveiligde kopie voordat het ontvangstbewijs verloopt.",
		}),
	];

	it("produces every defect type plus good passthroughs, tagged correctly", () => {
		const anchors = plantAnchors(items, 7);
		const expectations = new Set(anchors.map((anchor) => anchor.expected));
		expect(expectations).toEqual(
			new Set(["mistranslation", "omission", "over-verbosity", "over-compression", "good"]),
		);
		// All five kinds for each of the two input items.
		expect(anchors).toHaveLength(10);
	});

	it("mutates the target for defects and leaves good passthroughs untouched", () => {
		const anchors = plantAnchors(items, 7);
		for (const anchor of anchors) {
			const origin = items.find((item) => item.key === anchor.key);
			expect(origin).toBeDefined();
			if (anchor.expected === "good") {
				expect(anchor.targetText).toBe(origin!.targetText);
			} else {
				expect(anchor.targetText).not.toBe(origin!.targetText);
				// Defects only touch the translation, never the source.
				expect(anchor.sourceText).toBe(origin!.sourceText);
			}
		}
	});

	it("makes padded variants longer and compressed/omitted variants shorter", () => {
		const anchors = plantAnchors(items, 7);
		for (const anchor of anchors) {
			const origin = items.find((item) => item.key === anchor.key);
			if (anchor.expected === "over-verbosity") {
				expect(anchor.targetText.length).toBeGreaterThan(origin!.targetText.length);
				expect(anchor.targetText).toContain(origin!.targetText);
			}
			if (anchor.expected === "over-compression" || anchor.expected === "omission") {
				expect(anchor.targetText.length).toBeLessThan(origin!.targetText.length);
			}
		}
	});

	it("is deterministic for a given seed", () => {
		expect(plantAnchors(items, 99)).toEqual(plantAnchors(items, 99));
	});

	it("drops defect variants that failed to mutate short targets", () => {
		// A one-word target cannot be compressed; emitting it tagged as a
		// defect would unfairly penalize the judge in anchorRecall.
		const tiny = makeItem({ key: "tiny", sourceText: "Save", targetText: "Opslaan" });
		const anchors = plantAnchors([tiny], 7);
		for (const anchor of anchors) {
			if (anchor.expected !== "good") {
				expect(anchor.targetText).not.toBe(tiny.targetText);
			}
		}
		// The good passthrough always survives.
		expect(anchors.some((anchor) => anchor.expected === "good")).toBe(true);
	});

	it("gives every anchor a unique id tied to its origin and defect", () => {
		const anchors = plantAnchors(items, 7);
		const ids = new Set(anchors.map((anchor) => anchor.anchorId));
		expect(ids.size).toBe(anchors.length);
		expect(ids.has("item_one::omission")).toBe(true);
	});
});

describe("anchorRecall", () => {
	it("counts only correctly-categorized catches and tracks good false alarms", () => {
		const result = anchorRecall([
			{ expected: "omission", flaggedCategories: ["omission"] }, // caught
			{ expected: "mistranslation", flaggedCategories: ["grammar"] }, // wrong category
			{ expected: "over-verbosity", flaggedCategories: ["addition", "over-verbosity"] }, // caught
			{ expected: "over-compression", flaggedCategories: [] }, // missed
			{ expected: "good", flaggedCategories: [] }, // correct silence
			{ expected: "good", flaggedCategories: ["grammar"] }, // false alarm
		]);
		expect(result.defectCount).toBe(4);
		expect(result.caughtCount).toBe(2);
		expect(result.recall).toBeCloseTo(0.5);
		expect(result.goodFalseAlarmRate).toBeCloseTo(0.5);
	});

	it("returns NaN recall when no defects were planted", () => {
		const result = anchorRecall([{ expected: "good", flaggedCategories: [] }]);
		expect(Number.isNaN(result.recall)).toBe(true);
	});
});

describe("selfConsistency", () => {
	it("computes the agreement rate over repeat verdicts", () => {
		expect(
			selfConsistency([
				["A", "A"],
				["A", "B"],
				["tie", "tie"],
				["B", "B"],
			]),
		).toBeCloseTo(0.75);
	});

	it("returns NaN for an empty sample", () => {
		expect(Number.isNaN(selfConsistency([]))).toBe(true);
	});
});

describe("crossJudgeAgreement", () => {
	it("computes kappa on a known contingency table", () => {
		// Classic 2x2 example: 50 items, both-yes 20, both-no 15,
		// A-yes/B-no 10, A-no/B-yes 5. po = 0.7, pe = 0.5, kappa = 0.4.
		const verdictsA: string[] = [];
		const verdictsB: string[] = [];
		const push = (a: string, b: string, times: number): void => {
			for (let i = 0; i < times; i += 1) {
				verdictsA.push(a);
				verdictsB.push(b);
			}
		};
		push("yes", "yes", 20);
		push("no", "no", 15);
		push("yes", "no", 10);
		push("no", "yes", 5);
		const result = crossJudgeAgreement(verdictsA, verdictsB);
		expect(result.agreement).toBeCloseTo(0.7);
		expect(result.kappa).toBeCloseTo(0.4);
	});

	it("yields kappa 1 for perfect agreement across labels", () => {
		const result = crossJudgeAgreement(["A", "B", "tie"], ["A", "B", "tie"]);
		expect(result.agreement).toBe(1);
		expect(result.kappa).toBeCloseTo(1);
	});

	it("handles degenerate constant-label judges without dividing by zero", () => {
		const result = crossJudgeAgreement(["A", "A"], ["A", "A"]);
		expect(result.kappa).toBe(1);
	});

	it("rejects mismatched or empty verdict lists", () => {
		expect(() => crossJudgeAgreement(["A"], [])).toThrow();
		expect(() => crossJudgeAgreement([], [])).toThrow();
	});
});
