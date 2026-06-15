import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDirectProject } from "../../src/core/direct.js";
import { TranslationService } from "../../src/core/service.js";
import {
	createFixtureProject,
	removeFixture,
	type FixtureProject,
} from "../shared/helpers.js";

/**
 * Tests for the direct message-format file access (src/core/direct.ts):
 * which projects it accepts, that writes stay scoped to the files an
 * operation touches, and that unsupported projects fail with a clear error.
 */

const fixtures: FixtureProject[] = [];

function fixture(): FixtureProject {
	const f = createFixtureProject();
	fixtures.push(f);
	return f;
}

function patchSettings(
	f: FixtureProject,
	patch: (settings: Record<string, unknown>) => void
): void {
	const settingsPath = path.join(f.projectPath, "settings.json");
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	patch(settings);
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"));
}

afterEach(() => {
	while (fixtures.length > 0) {
		removeFixture(fixtures.pop()!.rootDir);
	}
});

describe("parseDirectProject", () => {
	it("resolves a plain message-format project", () => {
		const f = fixture();
		const direct = parseDirectProject(f.projectPath);
		expect(direct).not.toBeNull();
		expect(direct!.baseLocale).toBe("en");
		expect(direct!.locales).toEqual(["en", "de", "fr"]);
		expect(direct!.fileFor("de")).toBe(path.join(f.messagesDir, "de.json"));
	});

	it("rejects an array pathPattern (multiple files per locale)", () => {
		const f = fixture();
		patchSettings(f, (s) => {
			(s["plugin.inlang.messageFormat"] as Record<string, unknown>).pathPattern =
				["./messages/{locale}.json"];
		});
		expect(() => parseDirectProject(f.projectPath)).toThrow(
			/only supports inlang message-format projects/
		);
	});

	it("rejects a foreign import/export plugin module", () => {
		const f = fixture();
		patchSettings(f, (s) => {
			s.modules = [
				"https://cdn.jsdelivr.net/npm/@inlang/plugin-i18next@latest/dist/index.js",
			];
		});
		expect(() => parseDirectProject(f.projectPath)).toThrow(
			/only supports inlang message-format projects/
		);
	});

	it("tolerates the m-function-matcher companion plugin", () => {
		const f = fixture();
		patchSettings(f, (s) => {
			s.modules = [
				"https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4/dist/index.js",
				"https://cdn.jsdelivr.net/npm/@inlang/plugin-m-function-matcher@2/dist/index.js",
			];
		});
		expect(parseDirectProject(f.projectPath)).not.toBeNull();
	});

	it("tolerates lint-rule modules", () => {
		const f = fixture();
		patchSettings(f, (s) => {
			s.modules = [
				"https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4/dist/index.js",
				"https://cdn.jsdelivr.net/npm/@inlang/message-lint-rule-missing-translation@latest/dist/index.js",
			];
		});
		expect(parseDirectProject(f.projectPath)).not.toBeNull();
	});

});

describe("direct writes", () => {
	it("writes only the target locale file, in the plugin's format", async () => {
		const f = fixture();
		const before: Record<string, string> = {};
		for (const locale of ["en", "de", "fr"]) {
			before[locale] = fs.readFileSync(
				path.join(f.messagesDir, `${locale}.json`),
				"utf8"
			);
		}

		const service = new TranslationService(f.projectPath);
		const result = await service.saveTranslations({
			targetLocale: "fr",
			translations: [{ key: "greeting", value: "Bonjour {name}!" }],
		});
		expect(result.saved).toBe(1);

		// untouched locales keep their exact byte content
		for (const locale of ["en", "de"]) {
			expect(
				fs.readFileSync(path.join(f.messagesDir, `${locale}.json`), "utf8")
			).toBe(before[locale]);
		}

		const raw = fs.readFileSync(path.join(f.messagesDir, "fr.json"), "utf8");
		expect(Object.keys(JSON.parse(raw))[0]).toBe("$schema");
		expect(raw).toContain("\t"); // tab-indented like the plugin's export
		expect(f.readMessages("fr").greeting).toBe("Bonjour {name}!");
	});

	it("rewrites only the locale files a key mutation touches", async () => {
		const f = fixture();
		// fr is empty, so deleting/renaming en+de keys must not rewrite it
		const frBefore = fs.readFileSync(
			path.join(f.messagesDir, "fr.json"),
			"utf8"
		);

		const service = new TranslationService(f.projectPath);
		await service.deleteMessages({ keys: ["hello_world"] });
		await service.renameMessage({ key: "greeting", newKey: "welcome" });

		expect(
			fs.readFileSync(path.join(f.messagesDir, "fr.json"), "utf8")
		).toBe(frBefore);
		expect(f.readMessages("en").hello_world).toBeUndefined();
		expect(f.readMessages("de").welcome).toBe("Hallo {name}!");
	});

	it("translate-loop calls read only the source and target locale files", async () => {
		const f = fixture();
		// invalid JSON in fr: any operation that reads it must throw, so a
		// passing de translate loop proves fr was never read
		fs.writeFileSync(path.join(f.messagesDir, "fr.json"), "{ not json");

		const service = new TranslationService(f.projectPath);
		const batch = await service.getTranslationBatch({
			targetLocale: "de",
			batchSize: 10,
		});
		expect(batch.items.length).toBeGreaterThan(0);
		const result = await service.saveTranslations({
			targetLocale: "de",
			translations: batch.items.map((item) => ({
				key: item.key,
				value: typeof item.source === "string" ? `DE:${item.source}` : item.source,
			})),
		});
		expect(result.failed).toBe(0);

		// full-snapshot operations do read every locale and must surface the error
		expect(() => service.projectInfo()).toThrow(/invalid JSON/);
	});

	it("surfaces read errors for existing message paths instead of treating them as empty", () => {
		const f = fixture();
		const frPath = path.join(f.messagesDir, "fr.json");
		fs.rmSync(frPath);
		fs.mkdirSync(frPath);

		const service = new TranslationService(f.projectPath);
		expect(() => service.projectInfo()).toThrow(/cannot read message file/);
	});

	it("respects the plugin's sort setting", async () => {
		const f = fixture();
		patchSettings(f, (s) => {
			(s["plugin.inlang.messageFormat"] as Record<string, unknown>).sort =
				"asc";
		});

		const service = new TranslationService(f.projectPath);
		await service.saveTranslations({
			targetLocale: "de",
			translations: [
				{ key: "checkout_title", value: "Kasse" },
				{ key: "checkout_button_pay", value: "Jetzt zahlen" },
			],
		});

		const keys = Object.keys(f.readMessages("de")).filter(
			(k) => k !== "$schema"
		);
		expect(keys).toEqual([...keys].sort());
	});
});

describe("file cache", () => {
	it("shares writes across service instances and picks up external edits", () => {
		const f = fixture();
		const a = new TranslationService(f.projectPath);
		const b = new TranslationService(f.projectPath);

		// warm the cache via a, write through a — b must see the new value
		a.getTranslationBatch({ targetLocale: "fr", batchSize: 10 });
		a.saveTranslations({
			targetLocale: "fr",
			translations: [{ key: "hello_world", value: "Bonjour le monde!" }],
		});
		expect(
			b.getMessages({ keys: ["hello_world"], locales: ["fr"] }).messages[0]!
				.translations.fr
		).toBe("Bonjour le monde!");

		// external edit invalidates the cached entry via the stat check
		const enPath = path.join(f.messagesDir, "en.json");
		const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
		en.hello_world = "Hi there, world!";
		fs.writeFileSync(enPath, JSON.stringify(en, null, "\t"));
		expect(
			b.getMessages({ keys: ["hello_world"], locales: ["en"] }).messages[0]!
				.translations.en
		).toBe("Hi there, world!");
	});
});

describe("locale management file handling", () => {
	it("seeds and deletes message files", async () => {
		const f = fixture();
		const service = new TranslationService(f.projectPath);

		const added = await service.addLocale({ locale: "es" });
		expect(added.messageFileCreated).toBe(true);
		expect(fs.existsSync(path.join(f.messagesDir, "es.json"))).toBe(true);

		const removed = await service.removeLocale({ locale: "es" });
		expect(removed.messageFileDeleted).toBe(true);
		expect(fs.existsSync(path.join(f.messagesDir, "es.json"))).toBe(false);
	});

	it("rejects locale changes without touching settings when the project is unsupported", async () => {
		const f = fixture();
		// array pathPattern: multiple files per locale — unsupported
		patchSettings(f, (s) => {
			(s["plugin.inlang.messageFormat"] as Record<string, unknown>).pathPattern =
				["./messages/{locale}.json"];
		});
		const service = new TranslationService(f.projectPath);

		expect(() => service.addLocale({ locale: "es" })).toThrow(
			/only supports inlang message-format projects/
		);
		// settings must not be half-applied
		const settings = JSON.parse(
			fs.readFileSync(path.join(f.projectPath, "settings.json"), "utf8")
		);
		expect(settings.locales).not.toContain("es");
	});
});
