import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MESSAGE_FILE_SCHEMA =
	"https://inlang.com/schema/inlang-message-format";

export interface FixtureProject {
	rootDir: string;
	projectPath: string;
	messagesDir: string;
	readMessages: (locale: string) => Record<string, unknown>;
}

/**
 * Writes a Paraglide-style project to a temp directory:
 *
 *   <tmp>/project.inlang/settings.json
 *   <tmp>/messages/<locale>.json        (one per locale, $schema added)
 *
 * `modules` is left empty — the server resolves the message file locations
 * from the `plugin.inlang.messageFormat` settings alone and never touches
 * the network.
 */
export function scaffoldProject(args: {
	baseLocale: string;
	locales: string[];
	messages: Record<string, Record<string, unknown>>;
}): FixtureProject {
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
				baseLocale: args.baseLocale,
				locales: args.locales,
				modules: [],
				"plugin.inlang.messageFormat": {
					pathPattern: "./messages/{locale}.json",
				},
			},
			null,
			"\t"
		)
	);

	for (const locale of args.locales) {
		fs.writeFileSync(
			path.join(messagesDir, `${locale}.json`),
			JSON.stringify(
				{ $schema: MESSAGE_FILE_SCHEMA, ...args.messages[locale] },
				null,
				"\t"
			)
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

/**
 * Small handwritten fixture: en fully translated, de partial, fr empty.
 * Used by the unit and e2e tests where exact contents matter.
 */
export function createFixtureProject(): FixtureProject {
	return scaffoldProject({
		baseLocale: "en",
		locales: ["en", "de", "fr"],
		messages: {
			en: {
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
			},
			de: {
				hello_world: "Hallo Welt!",
				greeting: "Hallo {name}!",
			},
			fr: {},
		},
	});
}

export function removeFixture(rootDir: string): void {
	fs.rmSync(rootDir, { recursive: true, force: true });
}
