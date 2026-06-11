import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFixtureProject, removeFixture } from "../shared/helpers.js";

/**
 * End-to-end: spawns the built CLI (dist/cli.js) exactly like an MCP client
 * launched via `npx paraglide-messages-mcp` would, talks MCP over stdio, and verifies
 * the translations land in messages/de.json on disk.
 *
 * Requires `pnpm build` first (use `pnpm test:e2e` / `pnpm test:all`).
 */
const cliPath = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../dist/cli.js"
);

let fixture: ReturnType<typeof createFixtureProject>;
let client: Client;

beforeAll(async () => {
	fixture = createFixtureProject();
	client = new Client({ name: "e2e-test", version: "0.0.0" });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cliPath, "--project", fixture.projectPath],
			stderr: "pipe",
		})
	);
});

afterAll(async () => {
	await client.close();
	removeFixture(fixture.rootDir);
});

async function readJsonResource<T>(uri: string): Promise<T> {
	const result = await client.readResource({ uri });
	const first = result.contents[0];
	expect(first?.mimeType).toBe("application/json");
	if (!first || !("text" in first)) throw new Error("expected text contents");
	return JSON.parse(first.text as string) as T;
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const result = await client.callTool({ name, arguments: args });
	expect(result.isError ?? false).toBe(false);
	expect(result.structuredContent).toBeDefined();
	return result.structuredContent as T;
}

describe("paraglide-messages-mcp end to end", () => {
	it("exposes the eleven tools", async () => {
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			"add_locale",
			"delete_messages",
			"get_messages",
			"get_retranslation_batch",
			"get_translation_batch",
			"list_message_keys",
			"project_info",
			"remove_locale",
			"rename_message",
			"save_translations",
			"search_messages",
		]);
		for (const tool of tools) {
			expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
			expect(tool.outputSchema?.type).toBe("object");
		}
	});

	it("reports project info", async () => {
		const info = await callTool<{
			baseLocale: string;
			locales: string[];
			missing: Record<string, number>;
		}>("project_info", {});
		expect(info.baseLocale).toBe("en");
		expect(info.locales).toEqual(["en", "de", "fr"]);
		expect(info.missing.de).toBe(4);
	});

	it("lists keys with a prefix filter", async () => {
		const result = await callTool<{ keys: string[] }>("list_message_keys", {
			prefix: "checkout_",
		});
		expect(result.keys).toEqual([
			"checkout_button_cancel",
			"checkout_button_pay",
			"checkout_title",
		]);
	});

	it("retrieves messages for specific locales", async () => {
		const result = await callTool<{
			messages: Array<{ key: string; translations: Record<string, unknown> }>;
		}>("get_messages", { keys: ["greeting"], locales: ["en", "de"] });
		expect(result.messages[0]?.translations).toEqual({
			en: "Hello {name}!",
			de: "Hallo {name}!",
		});
	});

	it("translates a full locale via batch iterations and writes to disk", async () => {
		let iterations = 0;
		for (;;) {
			const batch = await callTool<{
				done: boolean;
				items: Array<{ key: string; source: unknown }>;
			}>("get_translation_batch", { targetLocale: "de", batchSize: 2 });
			if (batch.done) break;
			if (++iterations > 10) throw new Error("loop did not converge");

			const save = await callTool<{ failed: number; saved: number }>(
				"save_translations",
				{
					targetLocale: "de",
					translations: batch.items.map((item) => ({
						key: item.key,
						value:
							typeof item.source === "string"
								? `DE:${item.source}`
								: item.source,
					})),
				}
			);
			expect(save.failed).toBe(0);
		}

		expect(iterations).toBeGreaterThan(1);

		const deFile = fixture.readMessages("de") as Record<string, unknown>;
		expect(deFile.checkout_title).toBe("DE:Checkout");
		const inbox = deFile.inbox_count as Array<{ match: Record<string, string> }>;
		expect(inbox[0]?.match["countPlural=other"]).toBe(
			"You have {count} messages"
		);

		const info = await callTool<{ missing: Record<string, number> }>(
			"project_info",
			{}
		);
		expect(info.missing.de).toBe(0);
	});

	it("retranslates an already-translated prefix via cursor pages", async () => {
		// the previous test filled "de" completely; redo the checkout_ keys
		let after: string | undefined;
		let pages = 0;
		const seen: string[] = [];
		for (;;) {
			const batch = await callTool<{
				items: Array<{ key: string; source: unknown; existingTarget?: unknown }>;
				total: number;
				hasMore: boolean;
				nextCursor?: string;
			}>("get_retranslation_batch", {
				targetLocale: "de",
				prefix: "checkout_",
				batchSize: 2,
				...(after !== undefined && { after }),
			});
			if (++pages > 10) throw new Error("loop did not converge");
			expect(batch.total).toBe(3);
			for (const item of batch.items) {
				// everything in scope is already translated, so the current
				// value is exposed for the agent to judge
				expect(item.existingTarget).toBeDefined();
				seen.push(item.key);
			}

			const save = await callTool<{ failed: number }>("save_translations", {
				targetLocale: "de",
				translations: batch.items.map((item) => ({
					key: item.key,
					value:
						typeof item.source === "string"
							? `DE2:${item.source}`
							: item.source,
				})),
			});
			expect(save.failed).toBe(0);

			if (!batch.hasMore) break;
			after = batch.nextCursor;
		}

		expect(pages).toBe(2);
		expect(seen).toEqual([
			"checkout_button_cancel",
			"checkout_button_pay",
			"checkout_title",
		]);

		const deFile = fixture.readMessages("de") as Record<string, unknown>;
		expect(deFile.checkout_title).toBe("DE2:Checkout");
		// keys outside the prefix were not touched
		expect(deFile.greeting).toBe("Hallo {name}!");
	});

	it("surfaces validation errors through the tool result", async () => {
		const result = await callTool<{
			failed: number;
			results: Array<{ status: string; error?: string }>;
		}>("save_translations", {
			targetLocale: "fr",
			translations: [{ key: "greeting", value: "Bonjour {nom} !" }],
		});
		expect(result.failed).toBe(1);
		expect(result.results[0]?.error).toContain("{nom}");
	});

	it("rejects unknown locales as tool errors", async () => {
		const result = await client.callTool({
			name: "get_translation_batch",
			arguments: { targetLocale: "xx" },
		});
		expect(result.isError).toBe(true);
	});

	it("exposes the five workflow prompts", async () => {
		const { prompts } = await client.listPrompts();
		expect(prompts.map((p) => p.name).sort()).toEqual([
			"retranslate",
			"review_locale",
			"translate_locale",
			"translate_prefix",
			"translate_project",
		]);
		const translatePrefix = prompts.find((p) => p.name === "translate_prefix");
		expect(
			translatePrefix?.arguments?.find((a) => a.name === "targetLocale")
				?.required
		).toBe(true);
		expect(
			translatePrefix?.arguments?.find((a) => a.name === "sourceLocale")
				?.required
		).toBeFalsy();
	});

	it("renders translate_prefix with the given arguments", async () => {
		const result = await client.getPrompt({
			name: "translate_prefix",
			arguments: { prefix: "checkout_", targetLocale: "fr" },
		});
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]?.role).toBe("user");
		const text =
			result.messages[0]?.content.type === "text"
				? result.messages[0].content.text
				: "";
		expect(text).toContain('prefix: "checkout_"');
		expect(text).toContain('targetLocale: "fr"');
		expect(text).toContain("get_translation_batch");
		expect(text).toContain("save_translations");
	});

	it("lists the static and per-locale resources", async () => {
		const { resources } = await client.listResources();
		const uris = resources.map((r) => r.uri);
		expect(uris).toContain("paraglide://project/info");
		// one missing-keys resource per project locale, from the template's list callback
		expect(uris).toContain("paraglide://locales/en/missing");
		expect(uris).toContain("paraglide://locales/de/missing");
		expect(uris).toContain("paraglide://locales/fr/missing");
	});

	it("lists the resource templates", async () => {
		const { resourceTemplates } = await client.listResourceTemplates();
		expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
			"paraglide://locales/{locale}/missing",
			"paraglide://messages/{locale}/{key}",
		]);
	});

	it("reads project info as a resource", async () => {
		const info = await readJsonResource<{
			baseLocale: string;
			locales: string[];
		}>("paraglide://project/info");
		expect(info.baseLocale).toBe("en");
		expect(info.locales).toEqual(["en", "de", "fr"]);
	});

	it("reads the missing keys for a locale", async () => {
		// fr is still fully untranslated (the earlier fr save was rejected)
		const fr = await readJsonResource<{
			locale: string;
			missing: number;
			keys: string[];
		}>("paraglide://locales/fr/missing");
		expect(fr.locale).toBe("fr");
		expect(fr.missing).toBe(6);
		expect(fr.keys).toContain("greeting");

		// de was fully translated by the batch-loop test above
		const de = await readJsonResource<{ missing: number }>(
			"paraglide://locales/de/missing"
		);
		expect(de.missing).toBe(0);
	});

	it("reads a single message value", async () => {
		const data = await readJsonResource<unknown>(
			"paraglide://messages/en/greeting"
		);
		expect(data).toEqual({
			key: "greeting",
			locale: "en",
			value: "Hello {name}!",
		});
	});

	it("errors on an unknown message key resource", async () => {
		await expect(
			client.readResource({ uri: "paraglide://messages/en/nope_does_not_exist" })
		).rejects.toThrow(/unknown message key/);
	});

	it("completes resource template variables from the project", async () => {
		const locales = await client.complete({
			ref: {
				type: "ref/resource",
				uri: "paraglide://messages/{locale}/{key}",
			},
			argument: { name: "locale", value: "d" },
		});
		expect(locales.completion.values).toEqual(["de"]);

		const keys = await client.complete({
			ref: {
				type: "ref/resource",
				uri: "paraglide://messages/{locale}/{key}",
			},
			argument: { name: "key", value: "checkout_" },
		});
		expect(keys.completion.values).toContain("checkout_title");
	});

	it("completes locale and prefix prompt arguments from the project", async () => {
		const locales = await client.complete({
			ref: { type: "ref/prompt", name: "translate_locale" },
			argument: { name: "targetLocale", value: "d" },
		});
		expect(locales.completion.values).toEqual(["de"]);

		const prefixes = await client.complete({
			ref: { type: "ref/prompt", name: "review_locale" },
			argument: { name: "prefix", value: "checkout_" },
		});
		expect(prefixes.completion.values).toContain("checkout_title");
	});

	// the mutation tests run last so the fixture state the tests above rely on
	// (key set, missing counts) is not disturbed

	it("renames a message across locales and writes to disk", async () => {
		const result = await callTool<{
			key: string;
			newKey: string;
			updatedLocales: string[];
		}>("rename_message", { key: "checkout_title", newKey: "checkout_heading" });
		expect(result.updatedLocales).toContain("en");
		expect(result.updatedLocales).toContain("de");

		const enFile = fixture.readMessages("en") as Record<string, unknown>;
		expect(enFile.checkout_title).toBeUndefined();
		expect(enFile.checkout_heading).toBe("Checkout");
		const deFile = fixture.readMessages("de") as Record<string, unknown>;
		// "DE2:" — the value last written by the retranslation test above
		expect(deFile.checkout_heading).toBe("DE2:Checkout");
	});

	it("rejects a rename onto an existing key as a tool error", async () => {
		const result = await client.callTool({
			name: "rename_message",
			arguments: { key: "greeting", newKey: "hello_world" },
		});
		expect(result.isError).toBe(true);
	});

	it("deletes messages from all locale files on disk", async () => {
		const result = await callTool<{
			deleted: number;
			failed: number;
			results: Array<{ key: string; status: string; error?: string }>;
		}>("delete_messages", {
			keys: ["checkout_button_cancel", "nope_does_not_exist"],
		});
		expect(result.deleted).toBe(1);
		expect(result.failed).toBe(1);
		expect(
			result.results.find((r) => r.key === "nope_does_not_exist")?.error
		).toContain("unknown message key");

		for (const locale of ["en", "de"]) {
			const file = fixture.readMessages(locale) as Record<string, unknown>;
			expect(file.checkout_button_cancel).toBeUndefined();
		}

		const info = await callTool<{ totalKeys: number }>("project_info", {});
		expect(info.totalKeys).toBe(5);
	});

	it("saves a source-diverging translation with skipValidation", async () => {
		// the same value was rejected without the flag in the validation test above
		const result = await callTool<{ saved: number; failed: number }>(
			"save_translations",
			{
				targetLocale: "fr",
				translations: [{ key: "greeting", value: "Bonjour {nom} !" }],
				skipValidation: true,
			}
		);
		expect(result.saved).toBe(1);
		expect(result.failed).toBe(0);
		expect(
			(fixture.readMessages("fr") as Record<string, unknown>).greeting
		).toBe("Bonjour {nom} !");
	});

	it("adds a locale, translates into it, and removes it again", async () => {
		const added = await callTool<{
			locale: string;
			locales: string[];
			messageFileCreated: boolean;
		}>("add_locale", { locale: "es" });
		expect(added.locales).toEqual(["en", "de", "fr", "es"]);
		expect(added.messageFileCreated).toBe(true);

		const save = await callTool<{ saved: number }>("save_translations", {
			targetLocale: "es",
			translations: [{ key: "greeting", value: "¡Hola {name}!" }],
		});
		expect(save.saved).toBe(1);
		expect(
			(fixture.readMessages("es") as Record<string, unknown>).greeting
		).toBe("¡Hola {name}!");

		const removed = await callTool<{
			locales: string[];
			discardedTranslations: number;
			messageFileDeleted: boolean;
		}>("remove_locale", { locale: "es" });
		expect(removed.locales).toEqual(["en", "de", "fr"]);
		expect(removed.discardedTranslations).toBe(1);
		expect(removed.messageFileDeleted).toBe(true);

		const info = await callTool<{ locales: string[] }>("project_info", {});
		expect(info.locales).toEqual(["en", "de", "fr"]);
	});

	it("refuses to remove the base locale as a tool error", async () => {
		const result = await client.callTool({
			name: "remove_locale",
			arguments: { locale: "en" },
		});
		expect(result.isError).toBe(true);
	});
});
