import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { z } from "zod";
import type { TranslationService } from "../core/service.js";

/**
 * Registers the workflow prompts. Each renders a single user message that
 * walks the agent through the corresponding tool loop, so clients with prompt
 * support can launch a translation/review session without the bundled skill.
 */
export function registerPrompts(
	server: McpServer,
	service: TranslationService
): void {
	// Argument completion: locales come from the project settings, prefixes
	// from the actual message keys. Completion failures (e.g. project not
	// readable yet) degrade to "no suggestions" rather than erroring.
	// `completable` must wrap the outermost schema — the SDK looks up the
	// completer on the shape field itself and does not unwrap ZodOptional.
	const completeLocale = async (value: string | undefined) => {
		try {
			const info = await service.projectInfo();
			return info.locales.filter((l) => l.startsWith(value ?? ""));
		} catch {
			return [];
		}
	};

	const completePrefix = async (value: string | undefined) => {
		try {
			const { keys } = await service.listKeys({
				prefix: value || undefined,
				limit: 50,
			});
			return keys;
		} catch {
			return [];
		}
	};

	const localeArg = (description: string) =>
		completable(z.string().describe(description), completeLocale);
	const optionalLocaleArg = (description: string) =>
		completable(z.string().optional().describe(description), completeLocale);
	const prefixArg = (description: string) =>
		completable(z.string().describe(description), completePrefix);
	const optionalPrefixArg = (description: string) =>
		completable(z.string().optional().describe(description), completePrefix);

	server.registerPrompt(
		"translate_locale",
		{
			title: "Translate a locale",
			description:
				"Translate all missing messages into one target locale using the batch workflow " +
				"(get_translation_batch → translate → save_translations until done).",
			argsSchema: {
				targetLocale: localeArg("locale to translate into, e.g. 'de'"),
				sourceLocale: optionalLocaleArg(
					"locale to translate from (default: project base locale)"
				),
			},
		},
		({ targetLocale, sourceLocale }) => ({
			messages: userMessage(translateWorkflow({ targetLocale, sourceLocale })),
		})
	);

	server.registerPrompt(
		"translate_prefix",
		{
			title: "Translate a key prefix",
			description:
				"Translate the missing messages whose keys start with a given prefix " +
				"(e.g. 'checkout_') into one target locale.",
			argsSchema: {
				prefix: prefixArg("key prefix to scope to, e.g. 'checkout_'"),
				targetLocale: localeArg("locale to translate into, e.g. 'de'"),
				sourceLocale: optionalLocaleArg(
					"locale to translate from (default: project base locale)"
				),
			},
		},
		({ prefix, targetLocale, sourceLocale }) => ({
			messages: userMessage(
				translateWorkflow({ targetLocale, sourceLocale, prefix })
			),
		})
	);

	server.registerPrompt(
		"review_locale",
		{
			title: "Review a locale",
			description:
				"Review the existing translations of one locale against the base locale and fix " +
				"problems (broken placeholders, wrong plural cases, untranslated text, tone).",
			argsSchema: {
				locale: localeArg("locale whose translations to review, e.g. 'de'"),
				prefix: optionalPrefixArg(
					"optional key prefix to limit the review, e.g. 'checkout_'"
				),
			},
		},
		({ locale, prefix }) => ({
			messages: userMessage(reviewWorkflow({ locale, prefix })),
		})
	);
}

const TRANSLATION_RULES = `Translation rules:
- Preserve every {placeholder} exactly as written — same name, same braces. Never translate, rename, or drop placeholders.
- Preserve markup tags like {#bold}/{/bold} and their nesting.
- Variant messages are a single-element array: translate only the pattern strings in "match". Keep "declarations" and "selectors" as-is, but add or remove match cases to fit the target language's plural rules.
- Match the source's tone, formality, and rough length. Prefer the conventional terms of the platform/language over literal translations.
- When a source string is ambiguous, use the message key and sibling keys (get_messages with a prefix) for context. If still ambiguous, make the safest choice and mention it in your summary.
- Never edit message files directly — always save through save_translations so validation applies.`;

function translateWorkflow(args: {
	targetLocale: string;
	sourceLocale?: string;
	prefix?: string;
}): string {
	const scope = args.prefix
		? `messages whose keys start with "${args.prefix}"`
		: "all missing messages";
	const batchArgs = [
		`targetLocale: "${args.targetLocale}"`,
		args.sourceLocale ? `sourceLocale: "${args.sourceLocale}"` : null,
		args.prefix ? `prefix: "${args.prefix}"` : null,
	]
		.filter(Boolean)
		.join(", ");

	return `Translate ${scope} into "${args.targetLocale}" using the paraglide-mcp tools. You are the translator; the server provides the messages and validates + writes your translations.

Workflow:
1. Call project_info to confirm the locale and see how many messages are missing.
2. Loop until \`done\` is true:
   a. Call get_translation_batch with { ${batchArgs} }. Keep the default batchSize of 5; use up to 10 only for very short UI strings.
   b. Translate each item's \`source\` into the target locale, preserving every placeholder listed in \`placeholders\`.
   c. Call save_translations with the same keys. Check \`results\` for per-item errors, fix only the failed items, and re-save them before moving on.
3. When \`remaining\` is 0, report a short summary (how many messages, which scope) and suggest running the Paraglide compile step (usually part of dev/build).

${TRANSLATION_RULES}`;
}

function reviewWorkflow(args: { locale: string; prefix?: string }): string {
	const scope = args.prefix ? ` for keys starting with "${args.prefix}"` : "";
	const listArgs = [
		`locale: "${args.locale}"`,
		`status: "translated"`,
		args.prefix ? `prefix: "${args.prefix}"` : null,
	]
		.filter(Boolean)
		.join(", ");

	return `Review the existing "${args.locale}" translations${scope} in this inlang/Paraglide project against the base locale, and fix any problems you find.

Workflow:
1. Call project_info to learn the base locale and translation counts.
2. Page through the translated keys with list_message_keys { ${listArgs} }, then fetch their content in chunks of ~20 keys with get_messages, requesting both the base locale and "${args.locale}".
3. For each message, compare the translation to the base-locale source and check:
   - every {placeholder} is intact (same names, none added or dropped),
   - markup tags like {#bold}/{/bold} are preserved and correctly nested,
   - variant messages cover the right plural cases for the language,
   - the text is actually translated (not copied source text) and matches the source's tone and rough length.
4. Fix problems with save_translations in small batches (max 25 per call) and check \`results\` for per-item errors.
5. Report a summary: how many messages you reviewed, how many you fixed and why, and anything ambiguous you left unchanged.

${TRANSLATION_RULES}`;
}

function userMessage(text: string) {
	return [
		{
			role: "user" as const,
			content: { type: "text" as const, text },
		},
	];
}
