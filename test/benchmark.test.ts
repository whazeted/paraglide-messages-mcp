import { describe, it } from "vitest";
import { TranslationService } from "../src/core/service.js";
import { removeFixture } from "./helpers.js";
import {
	createLargeFixtureProject,
	pseudoTranslate,
} from "./large-fixture.js";

/**
 * Performance benchmark, not a regression test — excluded from `pnpm test`
 * and run explicitly with `pnpm bench`. Results are documented in
 * PERFORMANCE.md.
 *
 * The workload mirrors what an MCP agent actually does (the workflows from
 * the bundled prompts/skill), measured at the service layer where all
 * project I/O happens (MCP transport overhead is constant and tiny):
 *
 * - one-off reads: project_info, list_message_keys, get_messages
 * - the translate loop: get_translation_batch(5) -> save_translations(5)
 *   repeated until the locale is done (the default batch size the prompts
 *   recommend)
 *
 * Two project sizes, both 11 locales (en + 10 targets) with realistic
 * message shapes (plain strings, placeholders, paragraphs, plural variants):
 * - small: 250 messages (early-stage app) — full translation run
 * - large: 2000 messages (mature app) — 20-cycle partial run, extrapolated
 */

const SMALL = 250;
const LARGE = 2000;
const BATCH_SIZE = 5;
const LARGE_RUN_CYCLES = 20;

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

/** Median of 3 runs, to smooth out fs/jit jitter on cheap ops. */
async function timeOp(fn: () => unknown): Promise<number> {
	const samples: number[] = [];
	for (let i = 0; i < 3; i++) {
		const t0 = performance.now();
		await fn();
		samples.push(performance.now() - t0);
	}
	return median(samples);
}

interface BenchResult {
	label: string;
	ms: number;
}

async function benchProject(messageCount: number): Promise<BenchResult[]> {
	const fixture = createLargeFixtureProject({ messageCount });
	const service = new TranslationService(fixture.projectPath);
	const results: BenchResult[] = [];

	results.push({
		label: "project_info",
		ms: await timeOp(() => service.projectInfo()),
	});
	results.push({
		label: "list_message_keys (missing in de, limit 100)",
		ms: await timeOp(() =>
			service.listKeys({ locale: "de", status: "missing", limit: 100 })
		),
	});
	results.push({
		label: 'get_messages (prefix "checkout_", en+de)',
		ms: await timeOp(() =>
			service.getMessages({ prefix: "checkout_", locales: ["en", "de"] })
		),
	});

	// translate loop: batch -> pseudo-translate -> save, like a real agent run
	const cycleTimes: number[] = [];
	const maxCycles =
		messageCount <= SMALL ? Number.POSITIVE_INFINITY : LARGE_RUN_CYCLES;
	const runStart = performance.now();
	let cycles = 0;
	let translatedMessages = 0;
	for (;;) {
		const t0 = performance.now();
		const batch = await service.getTranslationBatch({
			targetLocale: "de",
			batchSize: BATCH_SIZE,
		});
		if (batch.done) break;
		await service.saveTranslations({
			targetLocale: "de",
			translations: batch.items.map((item) => ({
				key: item.key,
				value: pseudoTranslate(item.source, "de"),
			})),
		});
		cycleTimes.push(performance.now() - t0);
		translatedMessages += batch.items.length;
		cycles++;
		if (cycles >= maxCycles) break;
	}
	const runMs = performance.now() - runStart;
	const medianCycle = median(cycleTimes);
	const totalCycles = Math.ceil(messageCount / BATCH_SIZE);

	results.push({
		label: `translate cycle (batch ${BATCH_SIZE}: get_translation_batch + save_translations), median of ${cycles}`,
		ms: medianCycle,
	});
	if (translatedMessages >= messageCount) {
		results.push({
			label: `full "de" run, measured (${cycles} cycles, ${translatedMessages} messages)`,
			ms: runMs,
		});
	} else {
		results.push({
			label: `full "de" run, extrapolated (${totalCycles} cycles x median cycle)`,
			ms: medianCycle * totalCycles,
		});
	}

	removeFixture(fixture.rootDir);
	return results;
}

function printTable(title: string, results: BenchResult[]): void {
	const lines = [
		`\n### ${title}`,
		"| operation | time |",
		"| --- | --- |",
		...results.map((r) => {
			const time =
				r.ms >= 10_000 ? `${(r.ms / 1000).toFixed(1)} s` : `${r.ms.toFixed(0)} ms`;
			return `| ${r.label} | ${time} |`;
		}),
	];
	console.log(lines.join("\n"));
}

describe("benchmark", () => {
	it(`small project: ${SMALL} messages x 11 locales`, async () => {
		printTable(
			`Small project (${SMALL} messages, 11 locales)`,
			await benchProject(SMALL)
		);
	}, 600_000);

	it(`large project: ${LARGE} messages x 11 locales`, async () => {
		printTable(
			`Large project (${LARGE} messages, 11 locales)`,
			await benchProject(LARGE)
		);
	}, 600_000);
});
