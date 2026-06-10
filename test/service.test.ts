import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranslationService } from "../src/core/service.js";
import { discoverProjectPath } from "../src/core/project.js";
import {
	createFixtureProject,
	removeFixture,
	scaffoldProject,
} from "./helpers.js";
import type { ComplexMessage } from "../src/core/types.js";

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
		expect(info.translated.en).toBe(6);
		expect(info.translated.de).toBe(2);
		expect(info.translated.fr).toBe(0);
		expect(info.missing.de).toBe(4);
		expect(info.missing.fr).toBe(6);
		expect(info.pluginKey).toBe("plugin.inlang.messageFormat");
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
		await expect(
			service.listKeys({ locale: "xx", status: "missing" })
		).rejects.toThrow(/unknown locale/);
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
		await expect(service.getMessages({})).rejects.toThrow(/keys or a prefix/);
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
		await expect(service.searchMessages({ query: "  " })).rejects.toThrow(
			/query must not be empty/
		);
		await expect(
			service.searchMessages({ query: "x", locales: ["nl"] })
		).rejects.toThrow(/unknown locale/);
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
		await expect(
			service.getTranslationBatch({ targetLocale: "en" })
		).rejects.toThrow(/must differ/);
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
		await expect(service.deleteMessages({ keys: [] })).rejects.toThrow(
			/must not be empty/
		);
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
		await expect(
			service.renameMessage({ key: "does_not_exist", newKey: "whatever" })
		).rejects.toThrow(/unknown message key/);
	});

	it("rejects a new key that already exists", async () => {
		await expect(
			service.renameMessage({ key: "greeting", newKey: "hello_world" })
		).rejects.toThrow(/already exists/);
		// nothing was changed
		expect(fixture.readMessages("en").greeting).toBe("Hello {name}!");
	});

	it("rejects identical and empty new keys", async () => {
		await expect(
			service.renameMessage({ key: "greeting", newKey: "greeting" })
		).rejects.toThrow(/must differ/);
		await expect(
			service.renameMessage({ key: "greeting", newKey: "" })
		).rejects.toThrow(/must not be empty/);
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
		await expect(service.addLocale({ locale: "de" })).rejects.toThrow(
			/already in the project/
		);
		await expect(service.addLocale({ locale: "  " })).rejects.toThrow(
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
		await expect(service.removeLocale({ locale: "en" })).rejects.toThrow(
			/base locale/
		);
		expect(readSettings().locales).toEqual(["en", "de", "fr"]);
		expect(fs.existsSync(path.join(fixture.messagesDir, "en.json"))).toBe(
			true
		);
	});

	it("rejects unknown locales", async () => {
		await expect(service.removeLocale({ locale: "nl" })).rejects.toThrow(
			/unknown locale/
		);
	});
});
