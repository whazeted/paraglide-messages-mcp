import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TranslationService } from "../src/core/service.js";
import type { MessageValue } from "../src/core/types.js";
import { removeFixture } from "./helpers.js";
import {
	createLargeFixtureProject,
	emptyNonBaseLocales,
	LARGE_FIXTURE_TARGET_LOCALES,
	pseudoTranslate,
} from "./large-fixture.js";

/**
 * Integration test against a realistic Paraglide project on disk: a few
 * hundred varied English messages (single words, phrases, placeholder
 * sentences, paragraphs, plural variants) plus 10 empty target locales
 * (fr, de, nl, es, it, zh-CN, ja, ko, pt-BR, ru).
 *
 * Runs as one sequential scenario over a shared fixture — loading an inlang
 * project of this size is expensive, so tests build on each other in order
 * instead of recreating the project per test.
 */
let fixture: ReturnType<typeof createLargeFixtureProject>;
let service: TranslationService;
let en: Record<string, MessageValue>;

beforeAll(() => {
	fixture = createLargeFixtureProject();
	service = new TranslationService(fixture.projectPath);
	const { $schema: _, ...messages } = fixture.readMessages("en");
	en = messages as Record<string, MessageValue>;
});

afterAll(() => {
	removeFixture(fixture.rootDir);
});

const placeholdersIn = (value: string): Set<string> =>
	new Set([...value.matchAll(/\{(\w+)\}/g)].map(([, name]) => name!));

describe("large paraglide project", () => {
	it("generates varied English source messages", () => {
		const strings = Object.values(en).filter(
			(value): value is string => typeof value === "string"
		);

		// single words
		expect(strings.some((s) => /^\w+$/.test(s))).toBe(true);
		// sentences with exactly one placeholder
		expect(strings.some((s) => placeholdersIn(s).size === 1)).toBe(true);
		// sentences with multiple distinct placeholders
		expect(strings.some((s) => placeholdersIn(s).size >= 2)).toBe(true);
		// multi-sentence paragraphs
		expect(
			strings.some((s) => (s.match(/\./g) ?? []).length >= 2)
		).toBe(true);
		// plural variant arrays
		expect(Object.values(en).some((value) => Array.isArray(value))).toBe(true);
	});

	it("reports 11 locales with all target messages untranslated", async () => {
		const info = await service.projectInfo();
		expect(info.baseLocale).toBe("en");
		expect(info.locales).toEqual(["en", ...LARGE_FIXTURE_TARGET_LOCALES]);
		expect(info.totalKeys).toBe(fixture.messageCount);
		expect(info.translated.en).toBe(fixture.messageCount);
		for (const locale of LARGE_FIXTURE_TARGET_LOCALES) {
			expect(info.missing[locale]).toBe(fixture.messageCount);
		}
	});

	it("pages through all keys with the cursor", async () => {
		const seen: string[] = [];
		let after: string | undefined;
		for (;;) {
			const page = await service.listKeys({ limit: 100, after });
			seen.push(...page.keys);
			expect(page.total).toBe(fixture.messageCount);
			if (!page.hasMore) break;
			after = page.nextCursor;
		}
		expect(seen).toHaveLength(fixture.messageCount);
		expect(new Set(seen).size).toBe(fixture.messageCount);
	});

	it(
		"serves and persists a 25-message batch for each of the 10 target locales",
		async () => {
			for (const locale of LARGE_FIXTURE_TARGET_LOCALES) {
				const batch = await service.getTranslationBatch({
					targetLocale: locale,
					batchSize: 25,
				});
				expect(batch.sourceLocale).toBe("en");
				expect(batch.remaining).toBe(fixture.messageCount);
				expect(batch.items).toHaveLength(25);

				const save = await service.saveTranslations({
					targetLocale: locale,
					translations: batch.items.map((item) => ({
						key: item.key,
						value: pseudoTranslate(item.source, locale),
					})),
				});
				expect(save.failed).toBe(0);
				expect(save.saved).toBe(25);
				expect(save.remainingForLocale).toBe(fixture.messageCount - 25);
			}

			// non-ASCII translations survive the disk round-trip intact
			const { $schema: _, ...zh } = fixture.readMessages("zh-CN");
			expect(Object.keys(zh)).toHaveLength(25);
			for (const [key, value] of Object.entries(zh)) {
				expect(value).toEqual(pseudoTranslate(en[key]!, "zh-CN"));
			}
		},
		180_000
	);

	it(
		"fully translates the checkout namespace into Japanese via the batch loop",
		async () => {
			const checkoutKeys = Object.keys(en).filter((key) =>
				key.startsWith("checkout_")
			);
			expect(checkoutKeys.length).toBeGreaterThan(0);

			let iterations = 0;
			for (;;) {
				const batch = await service.getTranslationBatch({
					targetLocale: "ja",
					prefix: "checkout_",
					batchSize: 25,
				});
				if (batch.done) break;
				if (++iterations > 20) throw new Error("loop did not converge");

				const save = await service.saveTranslations({
					targetLocale: "ja",
					translations: batch.items.map((item) => ({
						key: item.key,
						value: pseudoTranslate(item.source, "ja"),
					})),
				});
				expect(save.failed).toBe(0);
			}
			expect(iterations).toBe(Math.ceil(checkoutKeys.length / 25));

			const ja = fixture.readMessages("ja") as Record<string, MessageValue>;
			for (const key of checkoutKeys) {
				expect(ja[key]).toEqual(pseudoTranslate(en[key]!, "ja"));
			}
		},
		180_000
	);

	it("still validates placeholders at scale", async () => {
		const [key] = Object.entries(en).find(
			([, value]) => typeof value === "string"
		)!;
		const result = await service.saveTranslations({
			targetLocale: "ru",
			translations: [{ key, value: "РУ:Привет {имя}!" }],
		});
		expect(result.failed).toBe(1);
		expect(result.results[0]?.error).toContain("{имя}");
	});

	it("empties all non-base message files so the project can be re-run", async () => {
		const emptied = emptyNonBaseLocales({ messagesDir: fixture.messagesDir });
		expect(emptied.sort()).toEqual([...LARGE_FIXTURE_TARGET_LOCALES].sort());

		for (const locale of LARGE_FIXTURE_TARGET_LOCALES) {
			expect(Object.keys(fixture.readMessages(locale))).toEqual(["$schema"]);
		}

		// the stateless server picks the reset up immediately
		const info = await service.projectInfo();
		expect(info.translated.en).toBe(fixture.messageCount);
		for (const locale of LARGE_FIXTURE_TARGET_LOCALES) {
			expect(info.missing[locale]).toBe(fixture.messageCount);
			expect(info.translated[locale]).toBe(0);
		}
	});
});
