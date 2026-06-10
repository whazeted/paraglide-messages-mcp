import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDirectProject } from "../src/core/direct.js";
import { TranslationService } from "../src/core/service.js";
import {
	createFixtureProject,
	removeFixture,
	type FixtureProject,
} from "./helpers.js";

/**
 * Tests for the direct message-format file access (src/core/direct.ts):
 * when it applies, that its output matches the SDK path, and that the SDK
 * fallback still works (the other tests all run through the fast path).
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
	delete process.env.PARAGLIDE_MCP_FORCE_SDK;
	while (fixtures.length > 0) {
		removeFixture(fixtures.pop()!.rootDir);
	}
});

describe("resolveDirectProject", () => {
	it("resolves a plain message-format project", () => {
		const f = fixture();
		const direct = resolveDirectProject(f.projectPath);
		expect(direct).not.toBeNull();
		expect(direct!.baseLocale).toBe("en");
		expect(direct!.locales).toEqual(["en", "de", "fr"]);
		expect(direct!.fileFor("de")).toBe(path.join(f.messagesDir, "de.json"));
	});

	it("returns null for an array pathPattern", () => {
		const f = fixture();
		patchSettings(f, (s) => {
			(s["plugin.inlang.messageFormat"] as Record<string, unknown>).pathPattern =
				["./messages/{locale}.json"];
		});
		expect(resolveDirectProject(f.projectPath)).toBeNull();
	});

	it("returns null when a foreign import/export plugin module is configured", () => {
		const f = fixture();
		patchSettings(f, (s) => {
			s.modules = [
				"https://cdn.jsdelivr.net/npm/@inlang/plugin-i18next@latest/dist/index.js",
			];
		});
		expect(resolveDirectProject(f.projectPath)).toBeNull();
	});

	it("tolerates lint-rule modules", () => {
		const f = fixture();
		patchSettings(f, (s) => {
			s.modules = [
				"https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4/dist/index.js",
				"https://cdn.jsdelivr.net/npm/@inlang/message-lint-rule-missing-translation@latest/dist/index.js",
			];
		});
		expect(resolveDirectProject(f.projectPath)).not.toBeNull();
	});

	it("returns null when PARAGLIDE_MCP_FORCE_SDK is set", () => {
		const f = fixture();
		process.env.PARAGLIDE_MCP_FORCE_SDK = "1";
		expect(resolveDirectProject(f.projectPath)).toBeNull();
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

describe("SDK fallback (PARAGLIDE_MCP_FORCE_SDK)", () => {
	it("produces the same results as the fast path", async () => {
		const run = async () => {
			const f = fixture();
			const service = new TranslationService(f.projectPath);
			const info = await service.projectInfo();
			const batch = await service.getTranslationBatch({ targetLocale: "fr" });
			const save = await service.saveTranslations({
				targetLocale: "fr",
				translations: [{ key: "greeting", value: "Bonjour {name}!" }],
			});
			return {
				info: { ...info, projectPath: "<varies>" },
				batchKeys: batch.items.map((i) => i.key),
				remaining: batch.remaining,
				save,
				frFile: f.readMessages("fr"),
			};
		};

		const fast = await run();
		process.env.PARAGLIDE_MCP_FORCE_SDK = "1";
		const sdk = await run();

		expect(fast).toEqual(sdk);
	});

	it("deletes and renames identically to the fast path", async () => {
		const run = async () => {
			const f = fixture();
			const service = new TranslationService(f.projectPath);
			const deletion = await service.deleteMessages({
				keys: ["hello_world", "does_not_exist"],
			});
			const rename = await service.renameMessage({
				key: "greeting",
				newKey: "welcome",
			});
			return {
				deletion,
				rename,
				enFile: f.readMessages("en"),
				deFile: f.readMessages("de"),
			};
		};

		const fast = await run();
		process.env.PARAGLIDE_MCP_FORCE_SDK = "1";
		const sdk = await run();

		expect(fast.deletion).toEqual(sdk.deletion);
		expect(fast.rename).toEqual(sdk.rename);
		for (const locale of ["enFile", "deFile"] as const) {
			expect(fast[locale].hello_world).toBeUndefined();
			expect(sdk[locale].hello_world).toBeUndefined();
			expect(fast[locale].greeting).toBeUndefined();
			expect(sdk[locale].greeting).toBeUndefined();
			expect(sdk[locale].welcome).toEqual(fast[locale].welcome);
		}
		expect(fast.enFile.welcome).toBe("Hello {name}!");
	});
});

describe("locale management file handling", () => {
	it("seeds and deletes message files even when the fast path is disabled", async () => {
		const f = fixture();
		process.env.PARAGLIDE_MCP_FORCE_SDK = "1";
		const service = new TranslationService(f.projectPath);

		const added = await service.addLocale({ locale: "es" });
		expect(added.messageFileCreated).toBe(true);
		expect(fs.existsSync(path.join(f.messagesDir, "es.json"))).toBe(true);

		const removed = await service.removeLocale({ locale: "es" });
		expect(removed.messageFileDeleted).toBe(true);
		expect(fs.existsSync(path.join(f.messagesDir, "es.json"))).toBe(false);
	});

	it("skips file handling when the message file location is not resolvable", async () => {
		const f = fixture();
		// array pathPattern: multiple files per locale — location not resolvable
		patchSettings(f, (s) => {
			(s["plugin.inlang.messageFormat"] as Record<string, unknown>).pathPattern =
				["./messages/{locale}.json"];
		});
		const service = new TranslationService(f.projectPath);

		const added = await service.addLocale({ locale: "es" });
		expect(added.messageFileCreated).toBe(false);
		expect(added.locales).toContain("es");
		expect(fs.existsSync(path.join(f.messagesDir, "es.json"))).toBe(false);
	});
});
