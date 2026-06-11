import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TranslationService } from "../src/core/service.js";
import type { TranslationInput } from "../src/core/types.js";
import { removeFixture, type FixtureProject } from "./helpers.js";
import { createLargeFixtureProject } from "./large-fixture.js";
import {
	callJudge,
	hasKeyFor,
	isDryRun,
	JUDGE_MODELS,
	parseModelSpec,
	textOf,
	translateBatch,
	TRANSLATOR_MODEL,
} from "./quality/driver.js";
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
	type PairwiseVerdict,
	type QualityItem,
} from "./quality/judge.js";
import { buildCorpusProject, loadCorpus } from "./quality/corpus.js";
import {
	aggregate,
	decayOnset,
	parseJsonl,
	renderMarkdownReport,
	type RunRow,
} from "./quality/report.js";
import {
	buildTier1Metrics,
	collectMetricOnsets,
	evaluateGates,
	recommendDefault,
	type AnchorGateInput,
	type CrossJudgeGateInput,
	type GateEvaluation,
	type PairwiseGateInput,
	type SelfConsistencyGateInput,
} from "./quality/calibration.js";

/**
 * Instrumented translation sweep for measuring where LLM translation quality
 * decays with output length, to calibrate DEFAULT_OUTPUT_TOKEN_BUDGET.
 *
 * For each output-token budget the sweep runs the standard agent loop
 * (getTranslationBatch -> translateBatch -> saveTranslations) over fresh
 * projects for two target locales, and writes one JSONL row per translated
 * item to test/quality/reports/<run-id>.jsonl. The sweep then scores the rows
 * with mechanical metrics and reliability-gated LLM judges, writes
 * test/quality/reports/<stamp>-report.md, and prints the detected decay onset
 * per budget — the token dropoff the run exists to find.
 *
 * Excluded from `pnpm test` by the existing `test/benchmark*.test.ts`
 * pattern; run via `pnpm bench:quality`. Without ANTHROPIC_API_KEY the whole
 * sweep is a deterministic offline dry-run that finishes in seconds.
 */

/** 0 disables the output budget entirely — the unbounded control arm. */
const BUDGETS = [750, 1500, 3000, 6000, 0];

const TARGET_LOCALES = ["de", "ja"];

/**
 * Rows MQM-judged per budget × locale group, stratified along the
 * cumulative-output-token axis (the decay axis). Each active judge model
 * scores the same sample so cross-judge agreement is computable.
 */
const JUDGE_SAMPLE = Math.max(
	0,
	Number(process.env.BENCH_JUDGE_SAMPLE ?? 20)
);

/** Concurrent judge calls; small to stay friendly to both providers. */
const JUDGE_CONCURRENCY = 8;

/** Source rows used for anchor and repeat-judgment reliability checks. */
const RELIABILITY_SAMPLE = 20;

/** Head/tail pairs per budget × locale group for blind pairwise judging. */
const PAIRWISE_PAIRS_PER_GROUP = 4;

/** Hard stop so a save that never makes progress cannot loop forever. */
const MAX_BATCHES_PER_LOCALE = 500;

const RESULTS_DIR = path.resolve(process.cwd(), "test/quality/reports");

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
			const metrics = buildTier1Metrics(rows);

			// --- Tier-2: MQM judge pass over a stratified sample, one column
			// per configured judge model (cross-provider judges supported) ---
			const judgeRun = await judgeSampledRows(rows);
			const gateEvaluation = evaluateGates({
				activeJudgeCount: judgeRun.activeJudges.length,
				anchorResults: judgeRun.anchorResults,
				selfConsistencyResults: judgeRun.selfConsistencyResults,
				crossJudgeAgreements: judgeRun.agreements,
				pairwiseResults: judgeRun.pairwiseResults,
			});
			if (gateEvaluation.admissible) {
				for (const [spec, scores] of judgeRun.scoresByJudge) {
					metrics[`mqm(${spec})`] = (row) => scores.get(rowId(row)) ?? null;
				}
			}

			const aggregates = aggregate(rows, metrics);
			const metricOnsets = collectMetricOnsets(aggregates, Object.keys(metrics));
			const recommendation = recommendDefault({
				model: TRANSLATOR_MODEL,
				admissible: gateEvaluation.admissible,
				metricOnsets,
				budgets: BUDGETS,
			});
			const reportPath = path.join(RESULTS_DIR, `${stamp}-report.md`);
			const metadata = renderRunMetadata({
				stamp,
				rows: rows.length,
				judgeRun,
				gateEvaluation,
				recommendation,
			});
			fs.writeFileSync(
				reportPath,
				`${metadata}\n${renderMarkdownReport(aggregates)}`
			);
			fs.writeFileSync(
				path.join(RESULTS_DIR, `${stamp}-config.json`),
				`${JSON.stringify(
					runConfig(stamp, judgeRun, gateEvaluation, metricOnsets, recommendation),
					null,
					"\t"
				)}\n`
			);
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

/** Stable row identity for joining judge scores back onto rows. */
function rowId(row: RunRow): string {
	return `${row.runId}|${row.targetLocale}|${row.key}`;
}

interface JudgeRunResult {
	activeJudges: string[];
	/** judge spec -> rowId -> severity-weighted MQM errors per 100 words. */
	scoresByJudge: Map<string, Map<string, number>>;
	/** Configured judges whose provider key is absent (documented, not run). */
	skippedJudges: string[];
	sampledRowCount: number;
	/** Pairwise agreement between judges on coarse verdict labels. */
	agreements: CrossJudgeGateInput[];
	anchorResults: AnchorGateInput[];
	selfConsistencyResults: SelfConsistencyGateInput[];
	pairwiseResults: PairwiseGateInput[];
}

/**
 * Tier-2 MQM judging over a stratified sample: per budget × locale group,
 * up to JUDGE_SAMPLE rows evenly spaced along the cumulative-output-token
 * axis, so the head and the tail of every generation are represented. Every
 * active judge scores the same rows — that is what makes the per-judge
 * metric columns comparable and cross-judge agreement meaningful. Judges
 * whose provider key is missing are skipped and reported, never stubbed:
 * a canned score would silently poison the decay analysis.
 */
async function judgeSampledRows(rows: RunRow[]): Promise<JudgeRunResult> {
	const activeJudges = JUDGE_MODELS.filter((spec) =>
		hasKeyFor(parseModelSpec(spec).provider)
	);
	const skippedJudges = JUDGE_MODELS.filter(
		(spec) => !hasKeyFor(parseModelSpec(spec).provider)
	);
	if (activeJudges.length === 0 || JUDGE_SAMPLE === 0) {
		return {
			activeJudges,
			scoresByJudge: new Map(),
			skippedJudges,
			sampledRowCount: 0,
			agreements: [],
			anchorResults: [],
			selfConsistencyResults: [],
			pairwiseResults: [],
		};
	}

	const sampled = sampleRowsByBudgetLocale(rows, JUDGE_SAMPLE);

	const scoresByJudge = new Map<string, Map<string, number>>();
	const labelsByJudge = new Map<string, Map<string, string>>();
	for (const spec of activeJudges) {
		const scores = new Map<string, number>();
		const labels = new Map<string, string>();
		for (let i = 0; i < sampled.length; i += JUDGE_CONCURRENCY) {
			const chunk = sampled.slice(i, i + JUDGE_CONCURRENCY);
			await Promise.all(
				chunk.map(async (row) => {
					try {
						const raw = await callJudge(
							buildMqmPrompt({
								key: row.key,
								positionInBatch: row.positionInBatch,
								batchItemCount: row.batchItemCount,
								sourceText: row.sourceText,
								targetText: row.targetText,
								targetLocale: row.targetLocale,
								sourceChars: row.sourceChars,
							}),
							spec
						);
						const errors = parseMqmResponse(raw);
						const words = row.sourceText.split(/\s+/).filter(Boolean).length;
						scores.set(rowId(row), mqmScore(errors, Math.max(1, words)));
						labels.set(rowId(row), verdictLabel(errors.map((e) => e.severity)));
					} catch {
						// an unparseable judge response loses one sample, not the run
					}
				})
			);
		}
		scoresByJudge.set(spec, scores);
		labelsByJudge.set(spec, labels);
	}

	const agreements: JudgeRunResult["agreements"] = [];
	for (let a = 0; a < activeJudges.length; a++) {
		for (let b = a + 1; b < activeJudges.length; b++) {
			const labelsA = labelsByJudge.get(activeJudges[a]!)!;
			const labelsB = labelsByJudge.get(activeJudges[b]!)!;
			const common = [...labelsA.keys()].filter((id) => labelsB.has(id));
			if (common.length === 0) continue;
			const result = crossJudgeAgreement(
				common.map((id) => labelsA.get(id)!),
				common.map((id) => labelsB.get(id)!)
			);
			agreements.push({
				judges: [activeJudges[a]!, activeJudges[b]!],
				...result,
			});
		}
	}

	const reliabilityRows = pickEvenly(
		[...sampled].sort((a, b) => rowId(a).localeCompare(rowId(b))),
		Math.min(RELIABILITY_SAMPLE, sampled.length)
	);
	const anchorResults = await judgeAnchors(activeJudges, reliabilityRows);
	const selfConsistencyResults = await judgeSelfConsistency(
		activeJudges,
		reliabilityRows,
		labelsByJudge
	);
	const pairwiseResults = await judgePairwise(activeJudges, rows);

	return {
		activeJudges,
		scoresByJudge,
		skippedJudges,
		sampledRowCount: sampled.length,
		agreements,
		anchorResults,
		selfConsistencyResults,
		pairwiseResults,
	};
}

/** Coarse per-item verdict for agreement stats: clean or worst severity. */
function verdictLabel(severities: string[]): string {
	if (severities.includes("critical")) return "critical";
	if (severities.includes("major")) return "major";
	if (severities.includes("minor")) return "minor";
	return "clean";
}

function sampleRowsByBudgetLocale(rows: RunRow[], samplePerGroup: number): RunRow[] {
	const groups = new Map<string, RunRow[]>();
	for (const row of rows) {
		const key = `${row.budget}|${row.targetLocale}`;
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
	}
	const sampled: RunRow[] = [];
	for (const group of groups.values()) {
		const sorted = [...group].sort(
			(a, b) =>
				a.cumulativeOutputTokensAtEmission - b.cumulativeOutputTokensAtEmission
		);
		sampled.push(...pickEvenly(sorted, Math.min(samplePerGroup, sorted.length)));
	}
	return sampled;
}

function pickEvenly<T>(items: T[], take: number): T[] {
	if (take <= 0 || items.length === 0) return [];
	if (take >= items.length) return [...items];
	const picked = new Set<number>();
	for (let i = 0; i < take; i++) {
		picked.add(Math.floor((i * (items.length - 1)) / Math.max(1, take - 1)));
	}
	return [...picked].sort((a, b) => a - b).map((index) => items[index]!);
}

function toQualityItem(row: RunRow): QualityItem {
	return {
		key: row.key,
		positionInBatch: row.positionInBatch,
		batchItemCount: row.batchItemCount,
		sourceText: row.sourceText,
		targetText: row.targetText,
		targetLocale: row.targetLocale,
		sourceChars: row.sourceChars,
	};
}

async function judgeAnchors(
	activeJudges: string[],
	reliabilityRows: RunRow[]
): Promise<AnchorGateInput[]> {
	const anchors = plantAnchors(reliabilityRows.map(toQualityItem), 13_371);
	const results: AnchorGateInput[] = [];
	for (const spec of activeJudges) {
		const judged: Array<{
			expected: (typeof anchors)[number]["expected"];
			flaggedCategories: ReturnType<typeof parseMqmResponse>[number]["category"][];
		}> = [];
		for (let i = 0; i < anchors.length; i += JUDGE_CONCURRENCY) {
			const chunk = anchors.slice(i, i + JUDGE_CONCURRENCY);
			await Promise.all(
				chunk.map(async (anchor) => {
					try {
						const errors = parseMqmResponse(
							await callJudge(buildMqmPrompt(anchor), spec)
						);
						judged.push({
							expected: anchor.expected,
							flaggedCategories: errors.map((error) => error.category),
						});
					} catch {
						judged.push({
							expected: anchor.expected,
							flaggedCategories: [],
						});
					}
				})
			);
		}
		const result = anchorRecall(judged);
		results.push({
			judge: spec,
			recall: result.recall,
			goodFalseAlarmRate: result.goodFalseAlarmRate,
			defectCount: result.defectCount,
		});
	}
	return results;
}

async function judgeSelfConsistency(
	activeJudges: string[],
	reliabilityRows: RunRow[],
	labelsByJudge: Map<string, Map<string, string>>
): Promise<SelfConsistencyGateInput[]> {
	const results: SelfConsistencyGateInput[] = [];
	for (const spec of activeJudges) {
		const originalLabels = labelsByJudge.get(spec) ?? new Map<string, string>();
		const pairs: Array<readonly [string, string]> = [];
		for (let i = 0; i < reliabilityRows.length; i += JUDGE_CONCURRENCY) {
			const chunk = reliabilityRows.slice(i, i + JUDGE_CONCURRENCY);
			await Promise.all(
				chunk.map(async (row) => {
					const first = originalLabels.get(rowId(row));
					if (first === undefined) return;
					try {
						const errors = parseMqmResponse(
							await callJudge(buildMqmPrompt(toQualityItem(row)), spec)
						);
						pairs.push([first, verdictLabel(errors.map((e) => e.severity))]);
					} catch {
						// Unparseable repeats are skipped and reflected in sampleCount.
					}
				})
			);
		}
		results.push({
			judge: spec,
			score: selfConsistency(pairs),
			sampleCount: pairs.length,
		});
	}
	return results;
}

async function judgePairwise(
	activeJudges: string[],
	rows: RunRow[]
): Promise<PairwiseGateInput[]> {
	const pairs = buildPairwiseRows(rows);
	const results: PairwiseGateInput[] = [];
	for (const spec of activeJudges) {
		const verdicts: PairwiseVerdict[] = [];
		for (let i = 0; i < pairs.length; i += JUDGE_CONCURRENCY) {
			const chunk = pairs.slice(i, i + JUDGE_CONCURRENCY);
			await Promise.all(
				chunk.map(async ({ head, tail, seed }) => {
					const built = buildPairwisePrompt(
						toQualityItem(head),
						toQualityItem(tail),
						seed
					);
					try {
						verdicts.push({
							verdict: parsePairwiseResponse(await callJudge(built.prompt, spec)),
							swapped: built.swapped,
						});
					} catch {
						// A malformed pairwise response loses one pair, not the run.
					}
				})
			);
		}
		results.push({ judge: spec, ...pairwiseWinRates(verdicts) });
	}
	return results;
}

function buildPairwiseRows(
	rows: RunRow[]
): Array<{ head: RunRow; tail: RunRow; seed: number }> {
	const groups = new Map<string, RunRow[]>();
	for (const row of rows) {
		const key = `${row.budget}|${row.targetLocale}`;
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
	}
	const pairs: Array<{ head: RunRow; tail: RunRow; seed: number }> = [];
	let seed = 91_001;
	for (const group of groups.values()) {
		const sorted = [...group].sort(
			(a, b) =>
				a.cumulativeOutputTokensAtEmission - b.cumulativeOutputTokensAtEmission
		);
		const take = Math.min(PAIRWISE_PAIRS_PER_GROUP, Math.floor(sorted.length / 2));
		for (let i = 0; i < take; i++) {
			pairs.push({
				head: sorted[i]!,
				tail: sorted[sorted.length - 1 - i]!,
				seed: seed++,
			});
		}
	}
	return pairs;
}

function runConfig(
	stamp: string,
	judgeRun: JudgeRunResult,
	gateEvaluation: GateEvaluation,
	metricOnsets: ReturnType<typeof collectMetricOnsets>,
	recommendation: ReturnType<typeof recommendDefault>
) {
	return {
		generated: stamp,
		mode: isDryRun() ? "dry-run" : "live",
		translatorModel: TRANSLATOR_MODEL,
		judgeModels: JUDGE_MODELS,
		activeJudges: judgeRun.activeJudges,
		skippedJudges: judgeRun.skippedJudges,
		judgeSamplePerGroup: JUDGE_SAMPLE,
		judgedRows: judgeRun.sampledRowCount,
		budgets: BUDGETS,
		targetLocales: TARGET_LOCALES,
		crossJudgeAgreement: judgeRun.agreements,
		anchorRecall: judgeRun.anchorResults,
		selfConsistency: judgeRun.selfConsistencyResults,
		pairwise: judgeRun.pairwiseResults,
		admissible: gateEvaluation.admissible,
		gates: gateEvaluation.gates,
		metricOnsets,
		recommendedDefaultByModel: recommendation,
	};
}

/**
 * Human-readable run provenance, prepended to the markdown report so every
 * result document records exactly which models produced and judged it.
 */
function renderRunMetadata(args: {
	stamp: string;
	rows: number;
	judgeRun: JudgeRunResult;
	gateEvaluation: GateEvaluation;
	recommendation: ReturnType<typeof recommendDefault>;
}): string {
	const { gateEvaluation, judgeRun, recommendation } = args;
	const lines = [
		"## Run metadata",
		"",
		`- generated: ${args.stamp}`,
		`- mode: ${isDryRun() ? "dry-run (no translator key — results are NOT meaningful)" : "live"}`,
		`- translator model: ${TRANSLATOR_MODEL}`,
		`- judge models: ${
			JUDGE_MODELS.map((spec) =>
				judgeRun.skippedJudges.includes(spec)
					? `${spec} (SKIPPED — no ${parseModelSpec(spec).provider} key)`
					: spec
			).join(", ") || "none"
		}`,
		`- judge sample: ${JUDGE_SAMPLE} rows per budget × locale (${judgeRun.sampledRowCount} judged)`,
		`- budgets swept: ${BUDGETS.join(", ")} (0 = budget disabled)`,
		`- target locales: ${TARGET_LOCALES.join(", ")}`,
		`- rows: ${args.rows}`,
		`- admissible: ${gateEvaluation.admissible}`,
		`- recommended default: ${
			recommendation.recommendedDefault === null
				? `none (${recommendation.reason})`
				: `${recommendation.recommendedDefault} output tokens`
		}`,
	];
	for (const [name, gate] of Object.entries(gateEvaluation.gates)) {
		lines.push(`- gate ${name}: ${gate.status} — ${gate.detail}`);
	}
	for (const { judges, agreement, kappa } of judgeRun.agreements) {
		lines.push(
			`- cross-judge agreement ${judges[0]} vs ${judges[1]}: ` +
				`${(agreement * 100).toFixed(1)}% raw, kappa ${kappa.toFixed(3)}`
		);
	}
	lines.push("");
	return lines.join("\n");
}
