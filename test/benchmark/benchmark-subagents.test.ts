import fs from "node:fs";
import path from "node:path";
import { flatten } from "flat";
import { describe, it } from "vitest";
import { TranslationService } from "../../src/core/service.js";
import { removeFixture } from "../shared/helpers.js";
import {
	LARGE_FIXTURE_TARGET_LOCALES,
	createLargeFixtureProject,
	emptyNonBaseLocales,
	pseudoTranslate,
} from "../shared/large-fixture.js";
import type { MessageValue } from "../../src/core/types.js";

/**
 * Subagent-orchestration benchmark, not a regression test — excluded from
 * `pnpm test` and run explicitly with `pnpm bench:subagents`. Results are
 * documented in PERFORMANCE.md.
 *
 * Question under test: every locale lives in its own JSON file and
 * save_translations only writes the target locale's file, so a client agent
 * could fan out one subagent per locale and translate all locales
 * concurrently. Is that correct (no lost or cross-contaminated writes), and
 * how much wall-clock does it save?
 *
 * Topology: in Claude Code, subagents share the parent session's MCP server
 * connection, so concurrent per-locale loops hit the *same* server process.
 * That is what this benchmark models: N concurrent translate loops against
 * the same project, one TranslationService per "subagent".
 *
 * Two timing dimensions:
 * - thinkMs = 0: pure server cost (file reads/writes/validation only). The
 *   direct path uses synchronous fs, so in-process concurrency cannot reduce
 *   this — it shows the floor and any contention overhead.
 * - thinkMs > 0: a scaled-down stand-in for the time the agent itself spends
 *   producing translations (in reality seconds per batch, here 25 ms so the
 *   benchmark stays runnable). This is what subagents actually parallelize.
 *
 * Every run does full, real translation of all 10 target locales on an XL
 * project (5000 messages — 2.5x the "large" benchmark fixture), with
 * correctness verified afterwards: every target file must contain every key
 * with exactly the value pseudoTranslate produces for *that* locale, and the
 * base locale file must be byte-identical to before the run.
 */

const XL = 5000;
const THINK_MS = 25;
const TARGETS = [...LARGE_FIXTURE_TARGET_LOCALES];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One "agent" translating one locale to completion: the same
 * get_translation_batch -> save_translations loop the bundled prompts/skill
 * describe, with optional simulated agent latency between get and save.
 */
async function translateLocale(
	service: TranslationService,
	locale: string,
	thinkMs: number,
	batchSize: number
): Promise<number> {
	const maxCycles = Math.ceil(XL / batchSize) + 5;
	let cycles = 0;
	for (;;) {
		const batch = await service.getTranslationBatch({
			targetLocale: locale,
			batchSize,
		});
		if (batch.done) break;
		if (thinkMs > 0) await sleep(thinkMs);
		const summary = await service.saveTranslations({
			targetLocale: locale,
			translations: batch.items.map((item) => ({
				key: item.key,
				value: pseudoTranslate(item.source, locale),
			})),
		});
		if (summary.failed > 0) {
			throw new Error(
				`benchmark translations rejected for ${locale}: ${JSON.stringify(summary.results.filter((r) => r.status !== "saved").slice(0, 3))}`
			);
		}
		cycles++;
		if (cycles > maxCycles) {
			throw new Error(`translate loop for ${locale} did not converge`);
		}
	}
	return cycles;
}

function readFlat(filePath: string): Record<string, MessageValue> {
	const json = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
		string,
		unknown
	>;
	delete json.$schema;
	return flatten(json, { safe: true });
}

/**
 * Strict post-run check: each target file holds exactly the keys of the base
 * file, and every value deep-equals pseudoTranslate(source, locale) — which
 * catches lost writes and cross-locale contamination alike.
 */
function verifyRun(messagesDir: string, enBytesBefore: string): void {
	const enBytesAfter = fs.readFileSync(path.join(messagesDir, "en.json"), "utf8");
	if (enBytesAfter !== enBytesBefore) {
		throw new Error("base locale file was modified by the run");
	}
	const en = readFlat(path.join(messagesDir, "en.json"));
	const enKeys = Object.keys(en);
	for (const locale of TARGETS) {
		const got = readFlat(path.join(messagesDir, `${locale}.json`));
		const gotCount = Object.keys(got).length;
		if (gotCount !== enKeys.length) {
			throw new Error(
				`${locale}: expected ${enKeys.length} messages, found ${gotCount}`
			);
		}
		for (const key of enKeys) {
			const expected = JSON.stringify(pseudoTranslate(en[key]!, locale));
			const actual = JSON.stringify(got[key]);
			if (actual !== expected) {
				throw new Error(
					`${locale}: value mismatch for ${key}: expected ${expected}, got ${actual}`
				);
			}
		}
	}
}

interface RunResult {
	label: string;
	ms: number;
	cycles: number;
}

async function runScenario(args: {
	label: string;
	messagesDir: string;
	projectPath: string;
	concurrent: boolean;
	thinkMs: number;
	batchSize: number;
}): Promise<RunResult> {
	emptyNonBaseLocales({ messagesDir: args.messagesDir });
	const enBytes = fs.readFileSync(path.join(args.messagesDir, "en.json"), "utf8");

	const t0 = performance.now();
	let cycles = 0;
	if (args.concurrent) {
		// one service instance per "subagent", all against the same project
		const counts = await Promise.all(
			TARGETS.map((locale) =>
				translateLocale(
					new TranslationService(args.projectPath),
					locale,
					args.thinkMs,
					args.batchSize
				)
			)
		);
		cycles = counts.reduce((a, b) => a + b, 0);
	} else {
		const service = new TranslationService(args.projectPath);
		for (const locale of TARGETS) {
			cycles += await translateLocale(
				service,
				locale,
				args.thinkMs,
				args.batchSize
			);
		}
	}
	const ms = performance.now() - t0;

	verifyRun(args.messagesDir, enBytes);
	return { label: args.label, ms, cycles };
}

function printTable(title: string, results: RunResult[]): void {
	const fmt = (ms: number) =>
		ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`;
	const lines = [
		`\n### ${title}`,
		"| scenario | wall time | cycles |",
		"| --- | --- | --- |",
		...results.map((r) => `| ${r.label} | ${fmt(r.ms)} | ${r.cycles} |`),
	];
	console.log(lines.join("\n"));
}

describe("subagent orchestration benchmark", () => {
	it(`XL project: ${XL} messages x 11 locales, full run of all ${TARGETS.length} target locales`, async () => {
		const fixture = createLargeFixtureProject({ messageCount: XL });
		const results: RunResult[] = [];
		const scenarios = [
			// batch 25: like-for-like comparison with the pre-scoped-reads numbers
			{ label: "batch 25, sequential (1 agent, locale after locale)", concurrent: false, thinkMs: 0, batchSize: 25 },
			{ label: `batch 25, subagents (${TARGETS.length} concurrent locale loops)`, concurrent: true, thinkMs: 0, batchSize: 25 },
			{ label: `batch 25, sequential + ${THINK_MS} ms simulated agent latency/cycle`, concurrent: false, thinkMs: THINK_MS, batchSize: 25 },
			{ label: `batch 25, subagents + ${THINK_MS} ms simulated agent latency/cycle`, concurrent: true, thinkMs: THINK_MS, batchSize: 25 },
			// batch 200: the large-batch per-locale configuration
			{ label: "batch 200, sequential (1 agent, locale after locale)", concurrent: false, thinkMs: 0, batchSize: 200 },
			{ label: `batch 200, subagents (${TARGETS.length} concurrent locale loops)`, concurrent: true, thinkMs: 0, batchSize: 200 },
			{ label: `batch 200, subagents + ${THINK_MS} ms simulated agent latency/cycle`, concurrent: true, thinkMs: THINK_MS, batchSize: 200 },
		];
		for (const scenario of scenarios) {
			results.push(
				await runScenario({
					...scenario,
					messagesDir: fixture.messagesDir,
					projectPath: fixture.projectPath,
				})
			);
			printTable(`XL project (${XL} messages, 11 locales)`, results);
		}
		removeFixture(fixture.rootDir);
	}, 1_800_000);
});
