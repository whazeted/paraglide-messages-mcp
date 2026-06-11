import { afterEach, describe, expect, it } from "vitest";
import {
	estimateTokens,
	outputTokensPerSourceChar,
} from "../src/core/budget.js";
import {
	DEFAULT_OUTPUT_TOKEN_BUDGET,
	DEFAULT_TRANSLATION_BATCH_SIZE,
	MIN_CALIBRATION_KEYS,
} from "../src/core/constants.js";
import { TranslationService } from "../src/core/service.js";
import { scaffoldProject, removeFixture, type FixtureProject } from "./helpers.js";

let fixture: FixtureProject | undefined;

afterEach(() => {
	if (fixture) removeFixture(fixture.rootDir);
	fixture = undefined;
});

describe("estimateTokens", () => {
	it("estimates Latin text at ~4 chars per token", () => {
		const text = "Save your changes before closing the editor";
		expect(estimateTokens(text)).toBeCloseTo(text.length / 4);
	});

	it("estimates CJK text as token-dense", () => {
		const text = "設定を保存しました";
		expect(estimateTokens(text)).toBeCloseTo(text.length * 0.8);
	});

	it("estimates Cyrillic between Latin and CJK", () => {
		const latin = estimateTokens("a".repeat(100));
		const cyrillic = estimateTokens("д".repeat(100));
		const cjk = estimateTokens("語".repeat(100));
		expect(cyrillic).toBeGreaterThan(latin);
		expect(cyrillic).toBeLessThan(cjk);
	});
});

describe("outputTokensPerSourceChar", () => {
	function snapshotWith(pairs: number, targetText: (i: number) => string) {
		const en: Record<string, string> = {};
		const xx: Record<string, string> = {};
		for (let i = 0; i < pairs; i++) {
			en[`key_${i}`] = "x".repeat(100);
			xx[`key_${i}`] = targetText(i);
		}
		return { en, xx };
	}

	it("returns null below the calibration threshold", () => {
		const snapshot = snapshotWith(MIN_CALIBRATION_KEYS - 1, () => "y".repeat(100));
		expect(outputTokensPerSourceChar(snapshot, "en", "xx")).toBeNull();
	});

	it("returns null for an empty locale", () => {
		expect(
			outputTokensPerSourceChar({ en: { a: "hi" }, xx: {} }, "en", "xx")
		).toBeNull();
	});

	it("measures the ratio from existing translations at the threshold", () => {
		// 200 target chars per 100 source chars, Latin: 200 * 0.25 / 100 = 0.5
		const snapshot = snapshotWith(MIN_CALIBRATION_KEYS, () => "y".repeat(200));
		expect(outputTokensPerSourceChar(snapshot, "en", "xx")).toBeCloseTo(0.5);
	});

	it("uses the median, so outlier keys do not skew the estimate", () => {
		const snapshot = snapshotWith(MIN_CALIBRATION_KEYS, (i) =>
			// one absurdly verbose translation among uniform ones
			i === 0 ? "y".repeat(100_000) : "y".repeat(100)
		);
		expect(outputTokensPerSourceChar(snapshot, "en", "xx")).toBeCloseTo(0.25);
	});
});

describe("get_translation_batch output budget", () => {
	function proseMessages(count: number, chars: number): Record<string, string> {
		const messages: Record<string, string> = {};
		for (let i = 0; i < count; i++) {
			messages[`prose_${String(i).padStart(3, "0")}`] = "x".repeat(chars);
		}
		return messages;
	}

	/**
	 * Project with MIN_CALIBRATION_KEYS translated keys (translations 2× the
	 * 100-char source → measured coefficient 0.5) plus pending prose keys.
	 */
	function scaffoldCalibrated(pending: Record<string, string>) {
		const translatedSource = proseMessages(MIN_CALIBRATION_KEYS, 100);
		const translations: Record<string, string> = {};
		for (const key of Object.keys(translatedSource)) {
			translations[key] = "y".repeat(200);
		}
		fixture = scaffoldProject({
			baseLocale: "en",
			locales: ["en", "xx"],
			messages: {
				en: { ...translatedSource, ...pending },
				xx: translations,
			},
		});
		return new TranslationService(fixture.projectPath);
	}

	function scaffoldUncalibrated(en: Record<string, string>) {
		fixture = scaffoldProject({
			baseLocale: "en",
			locales: ["en", "xx"],
			messages: { en, xx: {} },
		});
		return new TranslationService(fixture.projectPath);
	}

	function pendingProse(count: number, chars: number): Record<string, string> {
		const messages: Record<string, string> = {};
		for (let i = 0; i < count; i++) {
			messages[`zz_pending_${String(i).padStart(3, "0")}`] = "x".repeat(chars);
		}
		return messages;
	}

	it("uncalibrated cold-start prose is cut by the source's own token estimate", () => {
		// 5000 Latin chars × 0.25 = 1250 estimated source tokens per item —
		// the second item would cross the default budget, so it ships alone
		const service = scaffoldUncalibrated(proseMessages(60, 5000));
		const batch = service.getTranslationBatch({ targetLocale: "xx" });
		expect(batch.items).toHaveLength(1);
	});

	it("uncalibrated short strings still fill the full batch size", () => {
		const service = scaffoldUncalibrated(proseMessages(60, 20));
		const batch = service.getTranslationBatch({ targetLocale: "xx" });
		expect(batch.items).toHaveLength(DEFAULT_TRANSLATION_BATCH_SIZE);
	});

	it("maxOutputBudget is effective before calibration, not a no-op", () => {
		// 1000 Latin chars × 0.25 = 250 estimated tokens per item
		const service = scaffoldUncalibrated(proseMessages(20, 1000));
		const defaultBatch = service.getTranslationBatch({ targetLocale: "xx" });
		expect(defaultBatch.items).toHaveLength(
			Math.floor(DEFAULT_OUTPUT_TOKEN_BUDGET / 250)
		);
		const lowered = service.getTranslationBatch({
			targetLocale: "xx",
			maxOutputBudget: 500,
		});
		expect(lowered.items).toHaveLength(2);
	});

	it("short strings fill the full batch size (count binds, not budget)", () => {
		const service = scaffoldCalibrated(pendingProse(60, 20));
		const batch = service.getTranslationBatch({ targetLocale: "xx" });
		expect(batch.items).toHaveLength(DEFAULT_TRANSLATION_BATCH_SIZE);
	});

	it("long prose is cut by the budget once calibrated", () => {
		// 1000 source chars × measured 0.5 = 500 predicted tokens per item
		const service = scaffoldCalibrated(pendingProse(20, 1000));
		const batch = service.getTranslationBatch({ targetLocale: "xx" });
		expect(batch.items).toHaveLength(
			Math.floor(DEFAULT_OUTPUT_TOKEN_BUDGET / 500)
		);
		expect(batch.remaining).toBe(20);
	});

	it("a single over-budget message still ships alone", () => {
		const service = scaffoldCalibrated(pendingProse(3, 50_000));
		const batch = service.getTranslationBatch({ targetLocale: "xx" });
		expect(batch.items).toHaveLength(1);
	});

	it("maxOutputBudget: 0 disables budgeting (count alone)", () => {
		const service = scaffoldCalibrated(pendingProse(20, 1000));
		const batch = service.getTranslationBatch({
			targetLocale: "xx",
			maxOutputBudget: 0,
		});
		expect(batch.items).toHaveLength(20);
	});

	it("a lower maxOutputBudget shrinks the batch further", () => {
		const service = scaffoldCalibrated(pendingProse(20, 1000));
		const batch = service.getTranslationBatch({
			targetLocale: "xx",
			maxOutputBudget: 500,
		});
		expect(batch.items).toHaveLength(1);
	});
});
