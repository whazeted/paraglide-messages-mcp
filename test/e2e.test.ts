import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFixtureProject, removeFixture } from "./helpers.js";

/**
 * End-to-end: spawns the built CLI (dist/cli.js) exactly like an MCP client
 * launched via `npx paraglide-mcp` would, talks MCP over stdio, and verifies
 * the translations land in messages/de.json on disk.
 *
 * Requires `pnpm build` first (use `pnpm test:e2e` / `pnpm test:all`).
 */
const cliPath = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../dist/cli.js"
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

describe("paraglide-mcp end to end", () => {
	it("exposes the five tools", async () => {
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			"get_messages",
			"get_translation_batch",
			"list_message_keys",
			"project_info",
			"save_translations",
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

	it("exposes the three workflow prompts", async () => {
		const { prompts } = await client.listPrompts();
		expect(prompts.map((p) => p.name).sort()).toEqual([
			"review_locale",
			"translate_locale",
			"translate_prefix",
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
});
