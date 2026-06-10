import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Creates a realistic Paraglide-style fixture on disk:
 *
 *   <tmp>/project.inlang/settings.json
 *   <tmp>/messages/en.json   (fully translated source)
 *   <tmp>/messages/de.json   (partially translated)
 *   <tmp>/messages/fr.json   (empty)
 *
 * `modules` is left empty so tests never touch the network — the server's
 * bundled message-format plugin fallback kicks in (the same path an offline
 * user without a plugin cache hits).
 */
export function createFixtureProject(): {
	rootDir: string;
	projectPath: string;
	messagesDir: string;
	readMessages: (locale: string) => Record<string, unknown>;
} {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "paraglide-mcp-test-"));
	const projectPath = path.join(rootDir, "project.inlang");
	const messagesDir = path.join(rootDir, "messages");
	fs.mkdirSync(projectPath);
	fs.mkdirSync(messagesDir);

	fs.writeFileSync(
		path.join(projectPath, "settings.json"),
		JSON.stringify(
			{
				$schema: "https://inlang.com/schema/project-settings",
				baseLocale: "en",
				locales: ["en", "de", "fr"],
				modules: [],
				"plugin.inlang.messageFormat": {
					pathPattern: "./messages/{locale}.json",
				},
			},
			null,
			"\t"
		)
	);

	const en = {
		$schema: "https://inlang.com/schema/inlang-message-format",
		hello_world: "Hello world!",
		greeting: "Hello {name}!",
		checkout_title: "Checkout",
		checkout_button_pay: "Pay now",
		checkout_button_cancel: "Cancel",
		inbox_count: [
			{
				declarations: ["input count", "local countPlural = count: plural"],
				selectors: ["countPlural"],
				match: {
					"countPlural=one": "You have {count} message",
					"countPlural=other": "You have {count} messages",
				},
			},
		],
	};

	const de = {
		$schema: "https://inlang.com/schema/inlang-message-format",
		hello_world: "Hallo Welt!",
		greeting: "Hallo {name}!",
	};

	const fr = {
		$schema: "https://inlang.com/schema/inlang-message-format",
	};

	for (const [locale, content] of Object.entries({ en, de, fr })) {
		fs.writeFileSync(
			path.join(messagesDir, `${locale}.json`),
			JSON.stringify(content, null, "\t")
		);
	}

	return {
		rootDir,
		projectPath,
		messagesDir,
		readMessages: (locale: string) =>
			JSON.parse(
				fs.readFileSync(path.join(messagesDir, `${locale}.json`), "utf8")
			),
	};
}

export function removeFixture(rootDir: string): void {
	fs.rmSync(rootDir, { recursive: true, force: true });
}
