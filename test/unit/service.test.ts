import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranslationService } from "../../src/core/service.js";
import { discoverProjectPath } from "../../src/core/project.js";
import {
	createFixtureProject,
	removeFixture,
	scaffoldProject,
} from "../shared/helpers.js";
import type { ComplexMessage } from "../../src/core/types.js";

let fixture: ReturnType<typeof createFixtureProject>;
let service: TranslationService;

beforeEach(() => {
	fixture = createFixtureProject();
	service = new TranslationService(fixture.projectPath);
});

afterEach(() => {
	removeFixture(fixture.rootDir);
});

describe("discoverProjectPath", () => {
	it("finds project.inlang in the cwd", () => {
		expect(discoverProjectPath({ cwd: fixture.rootDir })).toBe(
			fixture.projectPath
		);
	});

	it("resolves an explicit relative path", () => {
		expect(
			discoverProjectPath({
				cwd: fixture.rootDir,
				explicitPath: "./project.inlang",
			})
		).toBe(fixture.projectPath);
	});

	it("normalizes an explicit settings file path to the project directory", () => {
		expect(
			discoverProjectPath({
				cwd: fixture.rootDir,
				explicitPath: "./project.inlang/settings.json",
			})
		).toBe(fixture.projectPath);
	});

	it("throws for a missing explicit path", () => {
		expect(() =>
			discoverProjectPath({ cwd: fixture.rootDir, explicitPath: "./nope" })
		).toThrow(/not found/);
	});
});

describe("projectInfo", () => {
	it("reports locales and per-locale counts", async () => {
		const info = await service.projectInfo();
		expect(info.baseLocale).toBe("en");
		expect(info.locales).toEqual(["en", "de", "fr"]);
		expect(info.totalKeys).toBe(6);
		expect(info.translatableKeys).toBe(6);
		expect(info.translated.en).toBe(6);
		expect(info.translated.de).toBe(2);
		expect(info.translated.fr).toBe(0);
		expect(info.missing.de).toBe(4);
		expect(info.missing.fr).toBe(6);
		expect(info.extraKeys).toEqual({ en: 0, de: 0, fr: 0 });
		expect(info.pluginKey).toBe("plugin.inlang.messageFormat");
	});

	it("counts missing only for non-empty base-locale keys", async () => {
		const mixed = scaffoldProject({
			baseLocale: "en",
			locales: ["en", "de"],
			messages: {
				en: { filled: "Hello", base_empty: "" },
				de: {
					base_empty: "Nicht aus Quelltext",
					target_only: "Nur im Ziel",
				},
			},
		});
		try {
			const local = new TranslationService(mixed.projectPath);

			const before = await local.projectInfo();
			expect(before.totalKeys).toBe(3);
			expect(before.translatableKeys).toBe(1);
			expect(before.translated.en).toBe(1);
			expect(before.translated.de).toBe(2);
			expect(before.missing.de).toBe(1);
			expect(before.extraKeys.de).toBe(2);

			const batch = await local.getTranslationBatch({
				targetLocale: "de",
				batchSize: 10,
			});
			expect(batch.remaining).toBe(1);
			expect(batch.items.map((item) => item.key)).toEqual(["filled"]);
			expect(
				local.listKeys({ locale: "de", status: "missing" }).keys
			).toEqual(["filled"]);
			expect(
				local.listKeys({ locale: "de", status: "translated" }).keys
			).toEqual([]);

			await local.saveTranslations({
				targetLocale: "de",
				translations: [{ key: "filled", value: "Hallo" }],
			});

			const after = await local.projectInfo();
			expect(after.totalKeys).toBe(3);
			expect(after.translatableKeys).toBe(1);
			expect(after.missing.de).toBe(0);
			expect(after.extraKeys.de).toBe(2);
			expect(
				local.listKeys({ locale: "de", status: "missing" }).keys
			).toEqual([]);
			expect(
				local.listKeys({ locale: "de", status: "translated" }).keys
			).toEqual(["filled"]);
		} finally {
			removeFixture(mixed.rootDir);
		}
	});
});

describe("listKeys", () => {
	it("lists all keys sorted", async () => {
		const result = await service.listKeys({});
		expect(result.keys).toEqual([
			"checkout_button_cancel",
			"checkout_button_pay",
			"checkout_title",
			"greeting",
			"hello_world",
			"inbox_count",
		]);
		expect(result.total).toBe(6);
		expect(result.hasMore).toBe(false);
	});

	it("filters by prefix (startsWith)", async () => {
		const result = await service.listKeys({ prefix: "checkout_" });
		expect(result.keys).toEqual([
			"checkout_button_cancel",
			"checkout_button_pay",
			"checkout_title",
		]);
	});

	it("filters by missing status in a locale", async () => {
		const result = await service.listKeys({ locale: "de", status: "missing" });
		expect(result.keys).toEqual([
			"checkout_button_cancel",
			"checkout_button_pay",
			"checkout_title",
			"inbox_count",
		]);
	});

	it("filters by translated status in a locale", async () => {
		const result = await service.listKeys({
			locale: "de",
			status: "translated",
		});
		expect(result.keys).toEqual(["greeting", "hello_world"]);
	});

	it("combines prefix and status filters", async () => {
		const result = await service.listKeys({
			prefix: "checkout_",
			locale: "de",
			status: "missing",
		});
		expect(result.keys).toHaveLength(3);
	});

	it("paginates with limit and cursor", async () => {
		const page1 = await service.listKeys({ limit: 2 });
		expect(page1.keys).toEqual(["checkout_button_cancel", "checkout_button_pay"]);
		expect(page1.hasMore).toBe(true);
		expect(page1.nextCursor).toBe("checkout_button_pay");

		const page2 = await service.listKeys({ limit: 2, after: page1.nextCursor });
		expect(page2.keys).toEqual(["checkout_title", "greeting"]);
	});

	it("rejects unknown locales", async () => {
		expect(() => service.listKeys({ locale: "xx", status: "missing" })).toThrow(/unknown locale/);
	});
});

describe("getMessages", () => {
	it("fetches messages by exact keys across locales", async () => {
		const result = await service.getMessages({ keys: ["greeting"] });
		expect(result.messages).toEqual([
			{
				key: "greeting",
				translations: {
					en: "Hello {name}!",
					de: "Hallo {name}!",
					fr: null,
				},
			},
		]);
	});

	it("fetches by prefix and restricts locales", async () => {
		const result = await service.getMessages({
			prefix: "checkout_",
			locales: ["en"],
		});
		expect(result.messages.map((m) => m.key)).toEqual([
			"checkout_button_cancel",
			"checkout_button_pay",
			"checkout_title",
		]);
		expect(result.messages[0]?.translations).toEqual({
			en: "Cancel",
		});
	});

	it("returns variant messages in message-format shape", async () => {
		const result = await service.getMessages({
			keys: ["inbox_count"],
			locales: ["en"],
		});
		const value = result.messages[0]?.translations.en as Array<{
			match: Record<string, string>;
		}>;
		expect(value[0]?.match["countPlural=one"]).toBe("You have {count} message");
		expect(value[0]?.match["countPlural=other"]).toBe(
			"You have {count} messages"
		);
	});

	it("requires keys or prefix", async () => {
		expect(() => service.getMessages({})).toThrow(/keys or a prefix/);
	});
});

describe("searchMessages", () => {
	it("finds messages by text content, case-insensitively", async () => {
		const result = await service.searchMessages({ query: "hello" });
		expect(result.results).toEqual([
			{
				key: "greeting",
				keyMatched: false,
				matches: [{ locale: "en", value: "Hello {name}!" }],
			},
			{
				key: "hello_world",
				keyMatched: true,
				matches: [{ locale: "en", value: "Hello world!" }],
			},
		]);
		expect(result.total).toBe(2);
		expect(result.truncated).toBe(false);
	});

	it("finds messages by key substring even without a text match", async () => {
		const result = await service.searchMessages({ query: "button_pay" });
		expect(result.results).toEqual([
			{ key: "checkout_button_pay", keyMatched: true, matches: [] },
		]);
	});

	it("searches inside variant patterns", async () => {
		const result = await service.searchMessages({
			query: "{count} messages",
		});
		expect(result.results.map((r) => r.key)).toEqual(["inbox_count"]);
		expect(result.results[0]?.matches.map((m) => m.locale)).toEqual(["en"]);
	});

	it("restricts the content search to the given locales", async () => {
		const all = await service.searchMessages({ query: "hallo" });
		expect(all.results.map((r) => r.key)).toEqual([
			"greeting",
			"hello_world",
		]);

		const enOnly = await service.searchMessages({
			query: "hallo",
			locales: ["en"],
		});
		expect(enOnly.results).toEqual([]);
	});

	it("truncates at limit and reports the total", async () => {
		const result = await service.searchMessages({
			query: "checkout",
			limit: 2,
		});
		expect(result.results).toHaveLength(2);
		expect(result.total).toBe(3);
		expect(result.truncated).toBe(true);
	});

	it("rejects an empty query and unknown locales", async () => {
		expect(() => service.searchMessages({ query: "  " })).toThrow(
			/query must not be empty/
		);
		expect(() => service.searchMessages({ query: "x", locales: ["nl"] })).toThrow(/unknown locale/);
	});
});

describe("getTranslationBatch", () => {
	it("returns only untranslated messages with placeholder info", async () => {
		const batch = await service.getTranslationBatch({
			targetLocale: "de",
			batchSize: 10,
		});
		expect(batch.sourceLocale).toBe("en");
		expect(batch.remaining).toBe(4);
		expect(batch.done).toBe(false);
		expect(batch.items.map((i) => i.key)).toEqual([
			"checkout_button_cancel",
			"checkout_button_pay",
			"checkout_title",
			"inbox_count",
		]);
		const inbox = batch.items.find((i) => i.key === "inbox_count");
		expect(inbox?.placeholders).toEqual(["count"]);
	});

	it("respects batchSize while reporting full remaining count", async () => {
		const batch = await service.getTranslationBatch({
			targetLocale: "de",
			batchSize: 2,
		});
		expect(batch.items).toHaveLength(2);
		expect(batch.remaining).toBe(4);
	});

	it("supports prefix scoping", async () => {
		const batch = await service.getTranslationBatch({
			targetLocale: "de",
			prefix: "checkout_",
			batchSize: 10,
		});
		expect(batch.items.map((i) => i.key)).toEqual([
			"checkout_button_cancel",
			"checkout_button_pay",
			"checkout_title",
		]);
		expect(batch.remaining).toBe(3);
	});

	it("rejects equal source and target locales", async () => {
		expect(() => service.getTranslationBatch({ targetLocale: "en" })).toThrow(/must differ/);
	});

	it("hints to call again while messages remain, and drops the hint when done", async () => {
		const more = await service.getTranslationBatch({
			targetLocale: "de",
			batchSize: 2,
		});
		expect(more.done).toBe(false);
		expect(more.nextStep).toMatch(/call get_translation_batch again/);

		const done = await service.getTranslationBatch({
			targetLocale: "de",
			prefix: "no_such_prefix_",
		});
		expect(done.done).toBe(true);
		expect(done.nextStep).toBeUndefined();
	});

	describe("autosave (fused save + fetch)", () => {
		it("saves the submitted batch and returns the next one from post-save state", async () => {
			const first = await service.getTranslationBatch({
				targetLocale: "de",
				batchSize: 2,
			});
			expect(first.items.map((i) => i.key)).toEqual([
				"checkout_button_cancel",
				"checkout_button_pay",
			]);
			expect(first.saved).toBeUndefined(); // priming call did not save

			const second = await service.getTranslationBatch({
				targetLocale: "de",
				batchSize: 2,
				translations: first.items.map((i) => ({
					key: i.key,
					value: `DE:${i.source as string}`,
				})),
			});
			// the two just-saved keys are persisted...
			expect(second.saved).toBe(2);
			expect(second.failed).toBe(0);
			expect(second.allSaved).toBe(true);
			expect(fixture.readMessages("de").checkout_button_cancel).toBe(
				"DE:Cancel"
			);
			// ...and excluded from the next batch / remaining count
			expect(second.items.map((i) => i.key)).toEqual([
				"checkout_title",
				"inbox_count",
			]);
			expect(second.remaining).toBe(2);
		});

		it("autosaves the final batch in the same call that reports done", async () => {
			const batch = await service.getTranslationBatch({
				targetLocale: "de",
				prefix: "checkout_",
				batchSize: 10,
			});
			const done = await service.getTranslationBatch({
				targetLocale: "de",
				prefix: "checkout_",
				batchSize: 10,
				translations: batch.items.map((i) => ({
					key: i.key,
					value: `DE:${i.source as string}`,
				})),
			});
			expect(done.saved).toBe(3);
			expect(done.allSaved).toBe(true);
			expect(done.done).toBe(true);
			expect(done.items).toEqual([]);
			expect(fixture.readMessages("de").checkout_title).toBe("DE:Checkout");
		});

		it("flags allSaved=false when an item is rejected, keeping it in the next batch", async () => {
			const next = await service.getTranslationBatch({
				targetLocale: "de",
				batchSize: 10,
				translations: [
					{ key: "checkout_button_cancel", value: "Abbrechen" },
					// invented placeholder -> rejected, never written
					{ key: "checkout_button_pay", value: "Zahle {amount}" },
				],
			});
			expect(next.saved).toBe(1);
			expect(next.failed).toBe(1);
			expect(next.allSaved).toBe(false);
			expect(
				next.saveResults?.find((r) => r.key === "checkout_button_pay")?.status
			).toBe("error");
			expect(fixture.readMessages("de").checkout_button_cancel).toBe(
				"Abbrechen"
			);
			expect(fixture.readMessages("de").checkout_button_pay).toBeUndefined();
			// the rejected key was not saved, so it resurfaces for another attempt
			expect(next.items.map((i) => i.key)).toContain("checkout_button_pay");
		});

		it("drives the whole loop with one call per iteration", async () => {
			let batch = await service.getTranslationBatch({
				targetLocale: "de",
				batchSize: 2,
			});
			let guard = 0;
			while (!batch.done) {
				if (++guard > 10) throw new Error("loop did not converge");
				batch = await service.getTranslationBatch({
					targetLocale: "de",
					batchSize: 2,
					translations: batch.items.map((item) => ({
						key: item.key,
						value:
							typeof item.source === "string"
								? `DE:${item.source}`
								: item.source,
					})),
				});
				expect(batch.allSaved).toBe(true);
			}
			const info = await service.projectInfo();
			expect(info.missing.de).toBe(0);
		});
	});
});

describe("getRetranslationBatch", () => {
	it("includes already-translated keys with their current value", async () => {
		const batch = await service.getRetranslationBatch({
			targetLocale: "de",
			batchSize: 10,
		});
		expect(batch.sourceLocale).toBe("en");
		// every key with a non-empty source, translated or not
		expect(batch.items.map((i) => i.key)).toEqual([
			"checkout_button_cancel",
			"checkout_button_pay",
			"checkout_title",
			"greeting",
			"hello_world",
			"inbox_count",
		]);
		expect(batch.total).toBe(6);
		expect(batch.hasMore).toBe(false);
		expect(batch.nextCursor).toBeUndefined();

		const greeting = batch.items.find((i) => i.key === "greeting");
		expect(greeting?.existingTarget).toBe("Hallo {name}!");
		expect(greeting?.placeholders).toEqual(["name"]);
		// untranslated keys carry no existingTarget
		const title = batch.items.find((i) => i.key === "checkout_title");
		expect(title?.existingTarget).toBeUndefined();
	});

	it("supports prefix scoping", async () => {
		const batch = await service.getRetranslationBatch({
			targetLocale: "de",
			prefix: "checkout_",
			batchSize: 10,
		});
		expect(batch.items.map((i) => i.key)).toEqual([
			"checkout_button_cancel",
			"checkout_button_pay",
			"checkout_title",
		]);
		expect(batch.total).toBe(3);
		expect(batch.hasMore).toBe(false);
	});

	it("pages with a cursor while total stays stable", async () => {
		const first = await service.getRetranslationBatch({
			targetLocale: "de",
			batchSize: 4,
		});
		expect(first.items).toHaveLength(4);
		expect(first.total).toBe(6);
		expect(first.hasMore).toBe(true);
		expect(first.nextCursor).toBe("greeting");

		const second = await service.getRetranslationBatch({
			targetLocale: "de",
			batchSize: 4,
			after: first.nextCursor,
		});
		expect(second.items.map((i) => i.key)).toEqual([
			"hello_world",
			"inbox_count",
		]);
		expect(second.total).toBe(6);
		expect(second.hasMore).toBe(false);
		expect(second.nextCursor).toBeUndefined();
	});

	it("keeps saved keys in scope (the cursor, not the data, drives progress)", async () => {
		await service.saveTranslations({
			targetLocale: "de",
			translations: [{ key: "checkout_title", value: "Kasse" }],
		});
		const batch = await service.getRetranslationBatch({
			targetLocale: "de",
			prefix: "checkout_",
			batchSize: 10,
		});
		expect(batch.total).toBe(3);
		const title = batch.items.find((i) => i.key === "checkout_title");
		expect(title?.existingTarget).toBe("Kasse");
	});

	it("excludes keys whose source is empty", async () => {
		const empty = scaffoldProject({
			baseLocale: "en",
			locales: ["en", "de"],
			messages: {
				en: { filled: "Hello", blank: "" },
				de: { blank: "Stale" },
			},
		});
		try {
			const local = new TranslationService(empty.projectPath);
			const batch = await local.getRetranslationBatch({
				targetLocale: "de",
				batchSize: 10,
			});
			expect(batch.items.map((i) => i.key)).toEqual(["filled"]);
			expect(batch.total).toBe(1);
		} finally {
			removeFixture(empty.rootDir);
		}
	});

	it("supports the full cursor loop with overwriting saves", async () => {
		let after: string | undefined;
		let guard = 0;
		for (;;) {
			const batch = await service.getRetranslationBatch({
				targetLocale: "de",
				batchSize: 2,
				...(after !== undefined && { after }),
			});
			if (++guard > 10) throw new Error("loop did not converge");

			const save = await service.saveTranslations({
				targetLocale: "de",
				translations: batch.items.map((item) => ({
					key: item.key,
					value:
						typeof item.source === "string"
							? `DE:${item.source}`
							: item.source,
				})),
			});
			expect(save.failed).toBe(0);

			if (!batch.hasMore) break;
			after = batch.nextCursor;
		}

		const deFile = fixture.readMessages("de");
		// previously translated values were overwritten
		expect(deFile.greeting).toBe("DE:Hello {name}!");
		expect(deFile.hello_world).toBe("DE:Hello world!");
		// previously missing values were filled in the same pass
		expect(deFile.checkout_title).toBe("DE:Checkout");

		const info = await service.projectInfo();
		expect(info.missing.de).toBe(0);
	});

	it("rejects unknown locales and equal source/target", async () => {
		expect(() =>
			service.getRetranslationBatch({ targetLocale: "xx" })
		).toThrow(/unknown locale/);
		expect(() =>
			service.getRetranslationBatch({ targetLocale: "en" })
		).toThrow(/must differ/);
	});

	it("hints to page on while more pages remain, and drops the hint on the last page", async () => {
		const more = await service.getRetranslationBatch({
			targetLocale: "de",
			batchSize: 4,
		});
		expect(more.hasMore).toBe(true);
		expect(more.nextStep).toMatch(/get_retranslation_batch again with after: "greeting"/);

		const last = await service.getRetranslationBatch({
			targetLocale: "de",
			batchSize: 10,
		});
		expect(last.hasMore).toBe(false);
		expect(last.nextStep).toBeUndefined();
	});

	it("autosaves the submitted page while advancing the cursor (one call per iteration)", async () => {
		let batch = await service.getRetranslationBatch({
			targetLocale: "de",
			batchSize: 2,
		});
		let after: string | undefined = batch.nextCursor;
		let guard = 0;
		for (;;) {
			if (++guard > 10) throw new Error("loop did not converge");
			const translations = batch.items.map((item) => ({
				key: item.key,
				value:
					typeof item.source === "string" ? `DE:${item.source}` : item.source,
			}));
			const hadMore = batch.hasMore;
			batch = await service.getRetranslationBatch({
				targetLocale: "de",
				batchSize: 2,
				...(after !== undefined && { after }),
				translations,
			});
			expect(batch.allSaved).toBe(true);
			if (!hadMore) break;
			after = batch.nextCursor;
		}

		const deFile = fixture.readMessages("de");
		// existing values overwritten and gaps filled in the fused pass
		expect(deFile.greeting).toBe("DE:Hello {name}!");
		expect(deFile.checkout_title).toBe("DE:Checkout");
		const info = await service.projectInfo();
		expect(info.missing.de).toBe(0);
	});
});

describe("saveTranslations", () => {
	it("saves valid translations and persists them to the message file", async () => {
		const result = await service.saveTranslations({
			targetLocale: "de",
			translations: [
				{ key: "checkout_title", value: "Kasse" },
				{ key: "checkout_button_pay", value: "Jetzt bezahlen" },
			],
		});
		expect(result.saved).toBe(2);
		expect(result.failed).toBe(0);
		expect(result.remainingForLocale).toBe(2);

		const deFile = fixture.readMessages("de");
		expect(deFile.checkout_title).toBe("Kasse");
		expect(deFile.checkout_button_pay).toBe("Jetzt bezahlen");
		// pre-existing translations are untouched
		expect(deFile.hello_world).toBe("Hallo Welt!");
	});

	it("saves variant translations", async () => {
		const result = await service.saveTranslations({
			targetLocale: "de",
			translations: [
				{
					key: "inbox_count",
					value: [
						{
							declarations: [
								"input count",
								"local countPlural = count: plural",
							],
							selectors: ["countPlural"],
							match: {
								"countPlural=one": "Du hast {count} Nachricht",
								"countPlural=other": "Du hast {count} Nachrichten",
							},
						},
					],
				},
			],
		});
		expect(result.saved).toBe(1);

		const deFile = fixture.readMessages("de") as Record<string, unknown>;
		const inbox = deFile.inbox_count as Array<{
			match: Record<string, string>;
		}>;
		expect(inbox[0]?.match["countPlural=one"]).toBe(
			"Du hast {count} Nachricht"
		);
	});

	it("rejects translations with invented placeholders, saving the rest", async () => {
		const result = await service.saveTranslations({
			targetLocale: "de",
			translations: [
				{ key: "checkout_title", value: "Kasse" },
				{ key: "checkout_button_pay", value: "Bezahl {amount}" },
			],
		});
		expect(result.saved).toBe(1);
		expect(result.failed).toBe(1);
		const failure = result.results.find(
			(r) => r.key === "checkout_button_pay"
		);
		expect(failure?.status).toBe("error");
		expect(failure?.error).toContain("{amount}");

		const deFile = fixture.readMessages("de");
		expect(deFile.checkout_title).toBe("Kasse");
		expect(deFile.checkout_button_pay).toBeUndefined();
	});

	it("rejects unknown keys unless allowNewKeys is set", async () => {
		const rejected = await service.saveTranslations({
			targetLocale: "de",
			translations: [{ key: "checkout_titel", value: "Kasse" }],
		});
		expect(rejected.failed).toBe(1);
		expect(rejected.results[0]?.error).toContain("unknown message key");

		const allowed = await service.saveTranslations({
			targetLocale: "en",
			translations: [{ key: "brand_new_key", value: "Brand new" }],
			allowNewKeys: true,
		});
		expect(allowed.saved).toBe(1);
		expect(fixture.readMessages("en").brand_new_key).toBe("Brand new");
	});

	it("warns when a source placeholder is dropped but still saves", async () => {
		const result = await service.saveTranslations({
			targetLocale: "de",
			translations: [{ key: "inbox_count", value: "Du hast Post" }],
		});
		expect(result.saved).toBe(1);
		expect(result.results[0]?.warnings?.[0]).toContain("{count}");
	});

	it("rejects duplicate keys within one call", async () => {
		const result = await service.saveTranslations({
			targetLocale: "de",
			translations: [
				{ key: "checkout_title", value: "Kasse" },
				{ key: "checkout_title", value: "Zur Kasse" },
			],
		});
		expect(result.saved).toBe(1);
		expect(result.results[1]?.error).toContain("duplicate");
	});

	it("saves source-diverging translations with skipValidation", async () => {
		// without the flag this is rejected ({amount} is not in the source)
		const rejected = await service.saveTranslations({
			targetLocale: "de",
			translations: [{ key: "checkout_button_pay", value: "Bezahl {amount}" }],
		});
		expect(rejected.failed).toBe(1);

		const result = await service.saveTranslations({
			targetLocale: "de",
			translations: [{ key: "checkout_button_pay", value: "Bezahl {amount}" }],
			skipValidation: true,
		});
		expect(result.saved).toBe(1);
		expect(result.results[0]?.warnings).toBeUndefined();
		expect(fixture.readMessages("de").checkout_button_pay).toBe(
			"Bezahl {amount}"
		);
	});

	it("still rejects structurally invalid values with skipValidation", async () => {
		const result = await service.saveTranslations({
			targetLocale: "de",
			translations: [
				{ key: "checkout_title", value: [] as unknown as string },
			],
			skipValidation: true,
		});
		expect(result.failed).toBe(1);
		expect(result.results[0]?.error).toContain(
			"string or a single-element array"
		);
	});

	it("still rejects unknown keys with skipValidation", async () => {
		const result = await service.saveTranslations({
			targetLocale: "de",
			translations: [{ key: "checkout_titel", value: "Kasse" }],
			skipValidation: true,
		});
		expect(result.failed).toBe(1);
		expect(result.results[0]?.error).toContain("unknown message key");
	});

	it("validates and counts remaining messages against a non-base sourceLocale", async () => {
		const nonBase = scaffoldProject({
			baseLocale: "en",
			locales: ["en", "de", "fr"],
			messages: {
				en: {
					checkout_button_pay: "Pay {amount}",
					profile_greeting: "Hello {firstName}",
					base_only: "Base-only {id}",
				},
				de: {
					checkout_button_pay: "Zahle {betrag}",
					profile_greeting: "Hallo {name}",
					de_only: "Nur Deutsch {code}",
				},
				fr: {},
			},
		});
		try {
			const local = new TranslationService(nonBase.projectPath);
			const batch = await local.getTranslationBatch({
				targetLocale: "fr",
				sourceLocale: "de",
				batchSize: 10,
			});
			expect(batch.sourceLocale).toBe("de");
			expect(batch.remaining).toBe(3);
			expect(batch.items.find((i) => i.key === "checkout_button_pay")?.placeholders).toEqual(["betrag"]);

			const result = await local.saveTranslations({
				targetLocale: "fr",
				sourceLocale: "de",
				translations: [
					{ key: "checkout_button_pay", value: "Payer {betrag}" },
					{ key: "profile_greeting", value: "Bonjour {name}" },
				],
			});
			expect(result.saved).toBe(2);
			expect(result.failed).toBe(0);
			expect(result.remainingForLocale).toBe(1);

			const frFile = nonBase.readMessages("fr");
			expect(frFile.checkout_button_pay).toBe("Payer {betrag}");
			expect(frFile.profile_greeting).toBe("Bonjour {name}");
			expect(frFile.base_only).toBeUndefined();

			const baseOnly = await local.saveTranslations({
				targetLocale: "fr",
				sourceLocale: "de",
				translations: [{ key: "base_only", value: "Base seulement {id}" }],
			});
			expect(baseOnly.failed).toBe(1);
			expect(baseOnly.results[0]?.error).toContain("unknown message key");
		} finally {
			removeFixture(nonBase.rootDir);
		}
	});

	it("supports the full iterate-until-done loop", async () => {
		// translate everything for "de" the way an agent would
		let guard = 0;
		for (;;) {
			const batch = await service.getTranslationBatch({
				targetLocale: "de",
				batchSize: 2,
			});
			if (batch.done) break;
			if (++guard > 10) throw new Error("loop did not converge");

			const save = await service.saveTranslations({
				targetLocale: "de",
				translations: batch.items.map((item) => ({
					key: item.key,
					value:
						typeof item.source === "string"
							? `DE:${item.source}`
							: item.source,
				})),
			});
			expect(save.failed).toBe(0);
		}

		const info = await service.projectInfo();
		expect(info.missing.de).toBe(0);
	});
});

describe("deleteMessages", () => {
	it("deletes keys from every locale file", async () => {
		const result = await service.deleteMessages({
			keys: ["hello_world", "greeting"],
		});
		expect(result.deleted).toBe(2);
		expect(result.failed).toBe(0);
		expect(result.results).toEqual([
			{ key: "hello_world", status: "deleted" },
			{ key: "greeting", status: "deleted" },
		]);

		for (const locale of ["en", "de"]) {
			const file = fixture.readMessages(locale);
			expect(file.hello_world).toBeUndefined();
			expect(file.greeting).toBeUndefined();
		}
		// other messages are untouched
		expect(fixture.readMessages("en").checkout_title).toBe("Checkout");

		const info = await service.projectInfo();
		expect(info.totalKeys).toBe(4);
	});

	it("deletes variant messages", async () => {
		const result = await service.deleteMessages({ keys: ["inbox_count"] });
		expect(result.deleted).toBe(1);
		expect(fixture.readMessages("en").inbox_count).toBeUndefined();
	});

	it("rejects unknown keys individually while deleting the rest", async () => {
		const result = await service.deleteMessages({
			keys: ["hello_world", "does_not_exist"],
		});
		expect(result.deleted).toBe(1);
		expect(result.failed).toBe(1);
		const failure = result.results.find((r) => r.key === "does_not_exist");
		expect(failure?.status).toBe("error");
		expect(failure?.error).toContain("unknown message key");
		expect(fixture.readMessages("en").hello_world).toBeUndefined();
	});

	it("rejects duplicate keys within one call", async () => {
		const result = await service.deleteMessages({
			keys: ["hello_world", "hello_world"],
		});
		expect(result.deleted).toBe(1);
		expect(result.results[1]?.error).toContain("duplicate");
	});

	it("requires a non-empty batch", async () => {
		expect(() => service.deleteMessages({ keys: [] })).toThrow(
			/must not be empty/
		);
	});
});

describe("removeOrphanMessages", () => {
	it("removes target keys that are absent from the base locale", async () => {
		const orphaned = scaffoldProject({
			baseLocale: "en",
			locales: ["en", "de", "fr"],
			messages: {
				en: {
					kept: "Keep me",
					base_empty: "",
				},
				de: {
					kept: "Behalte mich",
					base_empty: "Exists in source even though blank",
					orphan: "Nur Deutsch",
					checkout_orphan: "Alte Kasse",
				},
				fr: {
					orphan: "Seulement français",
				},
			},
		});
		try {
			const local = new TranslationService(orphaned.projectPath);
			const result = await local.removeOrphanMessages({});

			expect(result).toEqual({
				sourceLocale: "en",
				targetLocales: ["de", "fr"],
				results: [
					{ locale: "de", deleted: 2, keys: ["checkout_orphan", "orphan"] },
					{ locale: "fr", deleted: 1, keys: ["orphan"] },
				],
				deleted: 3,
			});
			expect(orphaned.readMessages("de").kept).toBe("Behalte mich");
			expect(orphaned.readMessages("de").base_empty).toBe(
				"Exists in source even though blank"
			);
			expect(orphaned.readMessages("de").orphan).toBeUndefined();
			expect(orphaned.readMessages("fr").orphan).toBeUndefined();
			expect(orphaned.readMessages("en").kept).toBe("Keep me");
		} finally {
			removeFixture(orphaned.rootDir);
		}
	});

	it("supports prefix and target locale scoping", async () => {
		const orphaned = scaffoldProject({
			baseLocale: "en",
			locales: ["en", "de", "fr"],
			messages: {
				en: { kept: "Keep me" },
				de: {
					kept: "Behalte mich",
					checkout_old: "Alte Kasse",
					settings_old: "Alte Einstellungen",
				},
				fr: {
					checkout_old: "Ancien paiement",
				},
			},
		});
		try {
			const local = new TranslationService(orphaned.projectPath);
			const result = await local.removeOrphanMessages({
				targetLocales: ["de"],
				prefix: "checkout_",
			});

			expect(result.deleted).toBe(1);
			expect(result.results).toEqual([
				{ locale: "de", deleted: 1, keys: ["checkout_old"] },
			]);
			expect(orphaned.readMessages("de").checkout_old).toBeUndefined();
			expect(orphaned.readMessages("de").settings_old).toBe(
				"Alte Einstellungen"
			);
			expect(orphaned.readMessages("fr").checkout_old).toBe(
				"Ancien paiement"
			);
		} finally {
			removeFixture(orphaned.rootDir);
		}
	});

	it("cleans relative to a non-base source locale without deleting source keys", async () => {
		const orphaned = scaffoldProject({
			baseLocale: "en",
			locales: ["en", "de", "fr"],
			messages: {
				en: {
					base_only: "Base only",
					shared: "Shared",
				},
				de: {
					shared: "Geteilt",
				},
				fr: {
					base_only: "Base seulement",
					shared: "Partagé",
					fr_only: "Seulement français",
				},
			},
		});
		try {
			const local = new TranslationService(orphaned.projectPath);
			const result = await local.removeOrphanMessages({
				sourceLocale: "de",
				targetLocales: ["fr"],
			});

			expect(result).toEqual({
				sourceLocale: "de",
				targetLocales: ["fr"],
				results: [
					{ locale: "fr", deleted: 2, keys: ["base_only", "fr_only"] },
				],
				deleted: 2,
			});
			expect(orphaned.readMessages("en").base_only).toBe("Base only");
			expect(orphaned.readMessages("de").shared).toBe("Geteilt");
			expect(orphaned.readMessages("fr").base_only).toBeUndefined();
			expect(orphaned.readMessages("fr").shared).toBe("Partagé");
		} finally {
			removeFixture(orphaned.rootDir);
		}
	});

	it("rejects sourceLocale in targetLocales", async () => {
		expect(() =>
			service.removeOrphanMessages({
				sourceLocale: "en",
				targetLocales: ["de", "en"],
			})
		).toThrow(/must not include sourceLocale/);
	});
});

describe("renameMessage", () => {
	it("renames a key across all locales, keeping the values", async () => {
		const result = await service.renameMessage({
			key: "greeting",
			newKey: "welcome_greeting",
		});
		expect(result).toEqual({
			key: "greeting",
			newKey: "welcome_greeting",
			updatedLocales: ["en", "de"],
		});

		expect(fixture.readMessages("en").greeting).toBeUndefined();
		expect(fixture.readMessages("en").welcome_greeting).toBe("Hello {name}!");
		expect(fixture.readMessages("de").greeting).toBeUndefined();
		expect(fixture.readMessages("de").welcome_greeting).toBe("Hallo {name}!");
		// fr never had the key and stays empty
		expect(fixture.readMessages("fr").welcome_greeting).toBeUndefined();

		const info = await service.projectInfo();
		expect(info.totalKeys).toBe(6);
	});

	it("renames variant messages intact", async () => {
		await service.renameMessage({
			key: "inbox_count",
			newKey: "inbox_unread_count",
		});
		const value = fixture.readMessages("en").inbox_unread_count as Array<{
			match: Record<string, string>;
		}>;
		expect(value[0]?.match["countPlural=one"]).toBe("You have {count} message");
	});

	it("rejects an unknown source key", async () => {
		expect(() => service.renameMessage({ key: "does_not_exist", newKey: "whatever" })).toThrow(/unknown message key/);
	});

	it("rejects a new key that already exists", async () => {
		expect(() => service.renameMessage({ key: "greeting", newKey: "hello_world" })).toThrow(/already exists/);
		// nothing was changed
		expect(fixture.readMessages("en").greeting).toBe("Hello {name}!");
	});

	it("rejects identical and empty new keys", async () => {
		expect(() => service.renameMessage({ key: "greeting", newKey: "greeting" })).toThrow(/must differ/);
		expect(() => service.renameMessage({ key: "greeting", newKey: "" })).toThrow(/must not be empty/);
	});
});

describe("multi-element variant messages (legacy/hand-written files)", () => {
	// such files are schema-valid but the toolchain only reads element [0] —
	// the review workflow must be able to fetch them AND save the fix
	// (a consolidated single-element value)
	let legacy: ReturnType<typeof scaffoldProject>;
	let legacyService: TranslationService;

	const multiElementSource: ComplexMessage = [
		{
			declarations: ["input count"],
			selectors: ["count"],
			match: { "count=one": "{count} item" },
		},
		{
			declarations: ["input name"],
			match: { "count=other": "{count} items for {name}" },
		},
	];

	beforeEach(() => {
		legacy = scaffoldProject({
			baseLocale: "en",
			locales: ["en", "de"],
			messages: {
				en: { legacy_count: multiElementSource },
				de: {},
			},
		});
		legacyService = new TranslationService(legacy.projectPath);
	});

	afterEach(() => {
		removeFixture(legacy.rootDir);
	});

	it("round-trips: fetches the multi-element value and reports all placeholders", async () => {
		const { messages } = await legacyService.getMessages({
			keys: ["legacy_count"],
		});
		expect(messages[0]?.translations.en).toEqual(multiElementSource);

		const batch = await legacyService.getTranslationBatch({
			targetLocale: "de",
		});
		expect(batch.items[0]?.key).toBe("legacy_count");
		expect(batch.items[0]?.placeholders).toEqual(["count", "name"]);
	});

	it("saves a consolidated single-element fix against a multi-element source", async () => {
		const result = await legacyService.saveTranslations({
			targetLocale: "de",
			translations: [
				{
					key: "legacy_count",
					value: [
						{
							declarations: ["input count", "input name"],
							selectors: ["count"],
							match: {
								"count=one": "{count} Artikel",
								"count=other": "{count} Artikel für {name}",
							},
						},
					],
				},
			],
		});
		expect(result.results[0]).toEqual({ key: "legacy_count", status: "saved" });
		expect(result.remainingForLocale).toBe(0);
	});

	it("rejects saving a multi-element value with a consolidation hint", async () => {
		const result = await legacyService.saveTranslations({
			targetLocale: "de",
			translations: [{ key: "legacy_count", value: multiElementSource }],
		});
		expect(result.results[0]?.status).toBe("error");
		expect(result.results[0]?.error).toMatch(/2 elements/);
		expect(result.results[0]?.error).toMatch(/consolidate/i);
	});

	it("rejects multi-element values even with skipValidation (structural rule)", async () => {
		const result = await legacyService.saveTranslations({
			targetLocale: "de",
			skipValidation: true,
			translations: [{ key: "legacy_count", value: multiElementSource }],
		});
		expect(result.results[0]?.status).toBe("error");
		expect(result.results[0]?.error).toMatch(/consolidate/i);
	});
});

describe("addLocale", () => {
	const readSettings = () =>
		JSON.parse(
			fs.readFileSync(path.join(fixture.projectPath, "settings.json"), "utf8")
		);

	it("adds the locale to settings and seeds an empty message file", async () => {
		const result = await service.addLocale({ locale: "es" });
		expect(result).toEqual({
			locale: "es",
			locales: ["en", "de", "fr", "es"],
			messageFileCreated: true,
		});

		expect(readSettings().locales).toEqual(["en", "de", "fr", "es"]);
		const esFile = path.join(fixture.messagesDir, "es.json");
		expect(fs.existsSync(esFile)).toBe(true);
		expect(Object.keys(JSON.parse(fs.readFileSync(esFile, "utf8")))).toEqual([
			"$schema",
		]);

		// the new locale is immediately usable by the translation loop
		const batch = await service.getTranslationBatch({ targetLocale: "es" });
		expect(batch.remaining).toBe(6);
		const save = await service.saveTranslations({
			targetLocale: "es",
			translations: [{ key: "greeting", value: "¡Hola {name}!" }],
		});
		expect(save.saved).toBe(1);
		expect(fixture.readMessages("es").greeting).toBe("¡Hola {name}!");
	});

	it("stores the tag as-is apart from trimming (not opinionated on format)", async () => {
		const result = await service.addLocale({ locale: " pt-BR " });
		expect(result.locale).toBe("pt-BR");
		expect(readSettings().locales).toContain("pt-BR");

		const odd = await service.addLocale({ locale: "klingon_TLH" });
		expect(odd.locale).toBe("klingon_TLH");
	});

	it("does not overwrite an existing message file", async () => {
		const esFile = path.join(fixture.messagesDir, "es.json");
		fs.writeFileSync(esFile, JSON.stringify({ greeting: "Hola" }));

		const result = await service.addLocale({ locale: "es" });
		expect(result.messageFileCreated).toBe(false);
		expect(JSON.parse(fs.readFileSync(esFile, "utf8")).greeting).toBe("Hola");
	});

	it("rejects duplicates and empty tags", async () => {
		expect(() => service.addLocale({ locale: "de" })).toThrow(
			/already in the project/
		);
		expect(() => service.addLocale({ locale: "  " })).toThrow(
			/must not be empty/
		);
	});
});

describe("removeLocale", () => {
	const readSettings = () =>
		JSON.parse(
			fs.readFileSync(path.join(fixture.projectPath, "settings.json"), "utf8")
		);

	it("removes the locale from settings and deletes its message file", async () => {
		const result = await service.removeLocale({ locale: "de" });
		expect(result).toEqual({
			locale: "de",
			locales: ["en", "fr"],
			discardedTranslations: 2,
			messageFileDeleted: true,
		});

		expect(readSettings().locales).toEqual(["en", "fr"]);
		expect(fs.existsSync(path.join(fixture.messagesDir, "de.json"))).toBe(
			false
		);

		const info = await service.projectInfo();
		expect(info.locales).toEqual(["en", "fr"]);
	});

	it("reports zero discarded translations for an empty locale", async () => {
		const result = await service.removeLocale({ locale: "fr" });
		expect(result.discardedTranslations).toBe(0);
		expect(result.messageFileDeleted).toBe(true);
	});

	it("refuses to remove the base locale", async () => {
		expect(() => service.removeLocale({ locale: "en" })).toThrow(
			/base locale/
		);
		expect(readSettings().locales).toEqual(["en", "de", "fr"]);
		expect(fs.existsSync(path.join(fixture.messagesDir, "en.json"))).toBe(
			true
		);
	});

	it("rejects unknown locales", async () => {
		expect(() => service.removeLocale({ locale: "nl" })).toThrow(
			/unknown locale/
		);
	});
});
