import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranslationService } from "../src/core/service.js";
import { discoverProjectPath } from "../src/core/project.js";
import { createFixtureProject, removeFixture } from "./helpers.js";

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
