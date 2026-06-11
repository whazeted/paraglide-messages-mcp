import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TranslationService } from "../src/core/service.js";
import type { TranslationInput } from "../src/core/types.js";
import { removeFixture, type FixtureProject } from "./helpers.js";
import { createLargeFixtureProject } from "./large-fixture.js";
import {
	isDryRun,
	textOf,
	translateBatch,
	TRANSLATOR_MODEL,
} from "./quality/driver.js";
import { buildCorpusProject, loadCorpus } from "./quality/corpus.js";
import {
	aggregate,
	decayOnset,
	parseJsonl,
	renderMarkdownReport,
	type MetricFn,
	type RunRow,
} from "./quality/report.js";

/**
 * Instrumented translation sweep for measuring where LLM translation quality
 * decays with output length, to calibrate DEFAULT_OUTPUT_TOKEN_BUDGET.
 *
 * For each output-token budget the sweep runs the standard agent loop
 * (getTranslationBatch -> translateBatch -> saveTranslations) over fresh
 * projects for two target locales, and writes one JSONL row per translated
 * item to bench-results/<run-id>.jsonl. The sweep then scores the rows with
 * the Tier-1 mechanical metrics, writes bench-results/<stamp>-report.md, and
 * prints the detected decay onset per budget — the token dropoff the run
 * exists to find. The LLM judge (Tier 2/3) remains a separate, optional
 * refinement pass over the same JSONL.
 *
 * Excluded from `pnpm test` by the existing `test/benchmark*.test.ts`
 * pattern; run via `pnpm bench:quality`. Without ANTHROPIC_API_KEY the whole
 * sweep is a deterministic offline dry-run that finishes in seconds.
 */

/** 0 disables the output budget entirely — the unbounded control arm. */
const BUDGETS = [750, 1500, 3000, 6000, 0];

const TARGET_LOCALES = ["de", "ja"];

/** Hard stop so a save that never makes progress cannot loop forever. */
const MAX_BATCHES_PER_LOCALE = 500;

const RESULTS_DIR = path.resolve(process.cwd(), "bench-results");

interface BenchRow {
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

/**
 * The benchmark measures real prose, so the vendored corpus is the fixture.
 * The synthetic large fixture only covers a checkout where the corpus data
 * is missing — it keeps the dry-run pipeline testable, nothing more.
 */
function createProject(): FixtureProject {
	const corpus = loadCorpus();
	if (corpus.length > 0) {
		return buildCorpusProject(corpus, TARGET_LOCALES);
	}
	return createLargeFixtureProject({ messageCount: 120 });
}

async function sweepLocale(args: {
	service: TranslationService;
	runId: string;
	budget: number;
	targetLocale: string;
	out: fs.WriteStream;
}): Promise<number> {
	const { service, runId, budget, targetLocale, out } = args;
	let rows = 0;
	for (let batchIndex = 0; batchIndex < MAX_BATCHES_PER_LOCALE; batchIndex++) {
		// maxOutputBudget: 0 explicitly disables the budget — omitting it
		// would silently apply the service default and duplicate that arm
		const batch = service.getTranslationBatch({
			targetLocale,
			maxOutputBudget: budget,
		});
		if (batch.items.length === 0) break;

		const translated = await translateBatch({
			items: batch.items.map((item) => ({ key: item.key, source: item.source })),
			targetLocale,
			sourceLocale: batch.sourceLocale,
		});
		const save = service.saveTranslations({
			targetLocale,
			translations: translated.items.map(
				(item): TranslationInput => ({ key: item.key, value: item.value })
			),
		});
		const saveByKey = new Map(save.results.map((r) => [r.key, r]));
		const sourceByKey = new Map(batch.items.map((i) => [i.key, i.source]));

		translated.items.forEach((item, positionInBatch) => {
			const source = sourceByKey.get(item.key);
			const saveResult = saveByKey.get(item.key);
			const row: BenchRow = {
				runId,
				budget,
				targetLocale,
				model: translated.model,
				batchIndex,
				positionInBatch,
				batchItemCount: translated.items.length,
				key: item.key,
				sourceChars: source === undefined ? 0 : textOf(source).length,
				cumulativeOutputTokensAtEmission: item.cumulativeOutputTokensAtEmission,
				outputTokensForItem: item.outputTokensForItem,
				validationStatus: saveResult?.status ?? "error",
				validationErrors: saveResult?.error ? [saveResult.error] : [],
				warnings: saveResult?.warnings ?? [],
				targetText: textOf(item.value),
				sourceText: source === undefined ? "" : textOf(source),
			};
			out.write(`${JSON.stringify(row)}\n`);
			rows++;
		});

		// A run where every item is rejected would re-fetch the same batch
		// forever — bail out and let the rows record the failures instead.
		if (save.saved === 0) break;
		if (batch.done) break;
	}
	return rows;
}

describe("benchmark: translation quality vs output budget", () => {
	it(
		"sweeps budgets and writes per-item JSONL rows",
		async () => {
			fs.mkdirSync(RESULTS_DIR, { recursive: true });
			const stamp = new Date()
				.toISOString()
				.replace(/[:.]/g, "-")
				.replace(/Z$/, "");
			// eslint-disable-next-line no-console
			console.log(
				`[bench:quality] model=${TRANSLATOR_MODEL} mode=${isDryRun() ? "dry-run" : "live"}`
			);

			const written: string[] = [];
			for (const budget of BUDGETS) {
				const runId = `${stamp}-budget${budget}`;
				const filePath = path.join(RESULTS_DIR, `${runId}.jsonl`);
				const out = fs.createWriteStream(filePath);
				// capture write errors as they happen — an 'error' with no
				// listener would crash the process instead of failing the test
				let writeError: Error | undefined;
				out.on("error", (error) => {
					writeError = error;
				});
				let rows = 0;
				for (const targetLocale of TARGET_LOCALES) {
					// fresh project per (budget, locale) so runs never see each
					// other's saved translations
					const fixture = createProject();
					try {
						const service = new TranslationService(fixture.projectPath);
						rows += await sweepLocale({
							service,
							runId,
							budget,
							targetLocale,
							out,
						});
					} finally {
						removeFixture(fixture.rootDir);
					}
				}
				await new Promise<void>((resolve) => out.end(() => resolve()));
				expect(writeError).toBeUndefined();
				expect(rows).toBeGreaterThan(0);
				written.push(filePath);
				// eslint-disable-next-line no-console
				console.log(`[bench:quality] budget=${budget} rows=${rows} -> ${filePath}`);
			}

			// Schema spot-check on a sampled line of each file, so a drifted
			// writer fails the run instead of silently corrupting the dataset.
			for (const filePath of written) {
				const firstLine = fs
					.readFileSync(filePath, "utf8")
					.split("\n")
					.find((line) => line.trim().length > 0);
				expect(firstLine).toBeDefined();
				const row = JSON.parse(firstLine!) as Record<string, unknown>;
				expect(typeof row.runId).toBe("string");
				expect(typeof row.budget).toBe("number");
				expect(typeof row.targetLocale).toBe("string");
				expect(typeof row.model).toBe("string");
				expect(typeof row.batchIndex).toBe("number");
				expect(typeof row.positionInBatch).toBe("number");
				expect(typeof row.batchItemCount).toBe("number");
				expect(typeof row.key).toBe("string");
				expect(typeof row.sourceChars).toBe("number");
				expect(typeof row.cumulativeOutputTokensAtEmission).toBe("number");
				expect(typeof row.outputTokensForItem).toBe("number");
				expect(typeof row.validationStatus).toBe("string");
				expect(Array.isArray(row.validationErrors)).toBe(true);
				expect(Array.isArray(row.warnings)).toBe(true);
				expect(typeof row.targetText).toBe("string");
				expect(typeof row.sourceText).toBe("string");
			}

			// --- Tier-1 scoring + decay report: the answer the run exists for ---
			const rows: RunRow[] = written.flatMap(
				(filePath) => parseJsonl(fs.readFileSync(filePath, "utf8")).rows
			);
			const metrics = tier1Metrics(rows);
			const aggregates = aggregate(rows, metrics);
			const reportPath = path.join(RESULTS_DIR, `${stamp}-report.md`);
			fs.writeFileSync(reportPath, renderMarkdownReport(aggregates));
			// eslint-disable-next-line no-console
			console.log(`[bench:quality] report -> ${reportPath}`);
			for (const group of aggregates) {
				for (const name of Object.keys(metrics)) {
					const onset = decayOnset(group.tokenBandBuckets, name);
					// eslint-disable-next-line no-console
					console.log(
						`[bench:quality] budget=${group.budget} locale=${group.targetLocale} ` +
							`${name}: ${onset ? `decay onset at ~${onset.label} output tokens` : "no onset detected"}`
					);
				}
			}
		},
		1_800_000
	);
});

/**
 * Tier-1 mechanical metric columns (higher is worse), built as closures over
 * the full row set because the length metrics are relative to each locale's
 * median target/source ratio — absolute ratios differ per language and would
 * drown the positional signal.
 */
function tier1Metrics(rows: RunRow[]): Record<string, MetricFn> {
	const ratiosByLocale = new Map<string, number[]>();
	for (const row of rows) {
		if (row.sourceText.length === 0 || row.targetText.length === 0) continue;
		const ratios = ratiosByLocale.get(row.targetLocale) ?? [];
		ratios.push(row.targetText.length / row.sourceText.length);
		ratiosByLocale.set(row.targetLocale, ratios);
	}
	const medianByLocale = new Map<string, number>();
	for (const [locale, ratios] of ratiosByLocale) {
		const sorted = [...ratios].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		medianByLocale.set(
			locale,
			sorted.length % 2 === 1
				? sorted[mid]!
				: (sorted[mid - 1]! + sorted[mid]!) / 2
		);
	}
	const normalize = (text: string) =>
		text.toLowerCase().replace(/\s+/g, " ").trim();

	return {
		failed: (row) => (row.validationStatus === "saved" ? 0 : 1),
		copyThrough: (row) =>
			row.sourceText.length > 0 &&
			normalize(row.targetText) === normalize(row.sourceText)
				? 1
				: 0,
		// terseness drift: how far an item falls below its locale's median
		// expansion — the formulaic/summarizing signature of output decay
		terseness: (row) => {
			const median = medianByLocale.get(row.targetLocale);
			if (
				median === undefined ||
				median === 0 ||
				row.sourceText.length === 0 ||
				row.targetText.length === 0
			) {
				return null;
			}
			const relative =
				row.targetText.length / row.sourceText.length / median;
			return Math.max(0, 1 - relative);
		},
	};
}
