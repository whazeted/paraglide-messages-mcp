import type { QualityItem } from "./judge.js";
import type { BenchmarkRow } from "./metrics.js";
import type { RunRow } from "./report.js";

export const SENTINEL_POSITION = 7777;
export const SENTINEL_BATCH_COUNT = 8888;
export const SENTINEL_CHARS = 9999;

export function benchmarkRow(
	overrides: Partial<BenchmarkRow> = {}
): BenchmarkRow {
	const sourceText = overrides.sourceText ?? "Hello world, how are you today?";
	return {
		runId: "run-1",
		budget: 1500,
		targetLocale: "de",
		model: "test-model",
		batchIndex: 0,
		positionInBatch: 0,
		batchItemCount: 10,
		key: "key_0",
		sourceChars: sourceText.length,
		cumulativeOutputTokensAtEmission: 100,
		outputTokensForItem: 50,
		validationStatus: "saved",
		validationErrors: [],
		warnings: [],
		targetText: "Hallo Welt, wie geht es dir heute?",
		sourceText,
		...overrides,
	};
}

export function runRow(overrides: Partial<RunRow> = {}): RunRow {
	return {
		runId: "run-1",
		budget: 1500,
		targetLocale: "de",
		model: "test-model",
		batchIndex: 0,
		positionInBatch: 0,
		batchItemCount: 20,
		key: "fiction_austen_001",
		sourceChars: 412,
		cumulativeOutputTokensAtEmission: 0,
		outputTokensForItem: 10,
		validationStatus: "saved",
		validationErrors: [],
		warnings: [],
		targetText: "Übersetzter Text",
		sourceText: "Translated text",
		...overrides,
	};
}

export function qualityItem(overrides: Partial<QualityItem> = {}): QualityItem {
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
