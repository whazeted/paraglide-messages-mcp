import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { z } from "zod";
import { COMPLETION_SUGGESTION_LIMIT } from "../core/constants.js";
import type { TranslationService } from "../core/service.js";

/**
 * Registers the workflow prompts. Each renders a single user message that
 * walks the agent through the corresponding tool loop, so clients with prompt
 * support can launch a translation/review session without the bundled skill.
 */
export function registerPrompts(
	server: McpServer,
	service: TranslationService,
	options: PromptOptions = {}
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
				limit: COMPLETION_SUGGESTION_LIMIT,
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
			messages: userMessage(
				translateWorkflow({ targetLocale, sourceLocale }, options)
			),
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
				translateWorkflow({ targetLocale, sourceLocale, prefix }, options)
			),
		})
	);

	server.registerPrompt(
		"translate_project",
		{
			title: "Translate the whole project (one subagent per locale)",
			description:
				"Translate all missing messages of every target locale by fanning out one subagent " +
				"per locale. The main agent uses the startup translation style brief (or asks the " +
				"user for one) and hands it to every subagent, so all locales share tone, formality " +
				"choices, and terminology.",
			argsSchema: {
				locales: optionalLocaleArg(
					"comma-separated target locales (default: every locale with missing messages)"
				),
				prefix: optionalPrefixArg(
					"optional key prefix to scope the run, e.g. 'checkout_'"
				),
			},
		},
		({ locales, prefix }) => ({
			messages: userMessage(orchestrateWorkflow({ locales, prefix }, options)),
		})
	);

	server.registerPrompt(
		"retranslate",
		{
			title: "Retranslate messages (one subagent per locale)",
			description:
				"Retranslate messages — including ones that already have a translation — to refresh " +
				"stale entries, e.g. after source copy or terminology changed. Scope with a key prefix; " +
				"covers every target locale by default (one subagent per locale, in parallel) so no " +
				"locale is left with a stale entry.",
			argsSchema: {
				prefix: optionalPrefixArg(
					"key prefix to retranslate, e.g. 'checkout_' (default: every message — expensive on large projects)"
				),
				locales: optionalLocaleArg(
					"comma-separated target locales (default: every target locale, so no stale entries remain)"
				),
			},
		},
		({ prefix, locales }) => ({
			messages: userMessage(retranslateWorkflow({ locales, prefix }, options)),
		})
	);

	server.registerPrompt(
		"review_locale",
		{
			title: "Review a locale",
			description:
				"Review the existing translations of one locale against the base locale and fix " +
				"problems (broken placeholders, wrong plural cases, untranslated text, style inconsistencies).",
			argsSchema: {
				locale: localeArg("locale whose translations to review, e.g. 'de'"),
				prefix: optionalPrefixArg(
					"optional key prefix to limit the review, e.g. 'checkout_'"
				),
			},
		},
		({ locale, prefix }) => ({
			messages: userMessage(reviewWorkflow({ locale, prefix }, options)),
		})
	);
}

interface PromptOptions {
	translationStyle?: string;
}

function translationRules(options: PromptOptions): string {
	return `Translation style:
${styleInstruction(options)}

Translation rules:
- Preserve every {placeholder} exactly as written — same name, same braces. Never translate, rename, or drop placeholders.
- Preserve markup tags like {#bold}/{/bold} and their nesting.
- Variant messages are a single-element array: translate only the pattern strings in "match". Keep "declarations" and "selectors" as-is, but add or remove match cases to fit the target language's plural rules.
- Use the settled style brief for tone, formality level (e.g. formal vs. informal address), and key terminology. Do not infer linguistic style from existing translations.
- Keep translations roughly the source's length and prefer the conventional terms of the platform/language over literal translations.
- When a source string is ambiguous, use the message key and sibling keys (get_messages with a prefix) for context. If still ambiguous, make the safest choice and mention it in your summary.
- Never edit message files directly — always save through save_translations so validation applies.`;
}

function styleInstruction(options: PromptOptions): string {
	if (options.translationStyle) {
		return `Use this server startup translation style brief verbatim unless the user overrides it:
${options.translationStyle}`;
	}

	return "No server startup translation style brief was configured. Ask the user for tone, formality/address choices, and terminology before translating; if the user explicitly leaves the choices to you, state the brief you will use. Do not derive style from existing translations.";
}

function translateWorkflow(args: {
	targetLocale: string;
	sourceLocale?: string;
	prefix?: string;
}, options: PromptOptions): string {
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

	return `Translate ${scope} into "${args.targetLocale}" using the paraglide-messages-mcp tools. You are the translator; the server provides the messages and validates + writes your translations.

Workflow:
1. Call project_info to confirm the locale and see how many messages are missing.
2. Loop until \`done\` is true:
   a. Call get_translation_batch with { ${batchArgs} }. Omit batchSize to use the default; raise it for short UI strings (fewer round-trips), or lower it for long, nuanced prose so each item gets full attention.
   b. Translate each item's \`source\` into the target locale, preserving every placeholder listed in \`placeholders\`.
   c. Call save_translations with the same keys. Check \`results\` for per-item errors, fix only the failed items, and re-save them before moving on.
3. When \`remaining\` is 0, report a short summary (how many messages, which scope) and suggest running the Paraglide compile step (usually part of dev/build).

${translationRules(options)}`;
}

function orchestrateWorkflow(args: {
	locales?: string;
	prefix?: string;
}, options: PromptOptions): string {
	const targets = args.locales
		? `the target locales ${args.locales}`
		: "every target locale that has missing messages";
	const scope = args.prefix
		? ` (only keys starting with "${args.prefix}")`
		: "";
	const subagentBatchArgs = [
		'targetLocale: "<locale>"',
		args.prefix ? `prefix: "${args.prefix}"` : null,
	]
		.filter(Boolean)
		.join(", ");

	return `Translate all missing messages${scope} into ${targets} using the paraglide-messages-mcp tools, with one subagent per locale running in parallel. You are the orchestrator: establish the translation style once, delegate the translation, and verify the result. Locales live in separate files and the translate tools only read/write the source and target locale, so per-locale subagents cannot interfere with each other.

Workflow:
1. Call project_info for the base locale, target locales, and per-locale missing counts. Skip locales with 0 missing messages.
2. Establish the style brief BEFORE delegating. Use project_info.translationStyle when present; otherwise ask the user for a brief covering tone and voice, formality/address per target language where the language forces a choice, recurring product terms, and terms that stay untranslated. Do not infer style from existing translations.
3. Spawn one subagent per target locale, all in parallel. Give each subagent: the style brief verbatim, its single target locale, and these instructions — loop until \`done\` is true: call get_translation_batch with { ${subagentBatchArgs} } (omit batchSize for the default; lower it for long, nuanced prose, raise it for short UI strings), translate every item preserving its \`placeholders\`, save with save_translations, fix per-item errors from \`results\` and re-save only those before continuing. Translate only your own locale; never touch others.
4. When all subagents are done, call project_info again and confirm \`missing\` is 0 for every target locale${args.prefix ? " (within the prefix, via list_message_keys)" : ""}. Re-dispatch a subagent for any locale that still has missing messages.
5. Report a summary: the style brief you used, per-locale message counts, anything subagents flagged as ambiguous, and suggest running the Paraglide compile step (usually part of dev/build).

${translationRules(options)}`;
}

function retranslateWorkflow(args: {
	locales?: string;
	prefix?: string;
}, options: PromptOptions): string {
	const targets = args.locales
		? `the target locales ${args.locales}`
		: "every target locale";
	const scope = args.prefix
		? `the messages whose keys start with "${args.prefix}"`
		: "all messages";
	const subagentBatchArgs = [
		'targetLocale: "<locale>"',
		args.prefix ? `prefix: "${args.prefix}"` : null,
		'after: "<nextCursor from the previous call, omit on the first>"',
	]
		.filter(Boolean)
		.join(", ");

	return `Retranslate ${scope} in ${targets} using the paraglide-messages-mcp tools, with one subagent per locale running in parallel. Unlike a normal translation run this REPLACES existing translations — the goal is a fresh, consistent pass over the scope (e.g. after the source copy or terminology changed), leaving no stale entries in any locale. You are the orchestrator: establish the translation style once, delegate the retranslation, and verify the result. Locales live in separate files and the translate tools only read/write the source and target locale, so per-locale subagents cannot interfere with each other.

Workflow:
1. Call project_info for the base locale and target locales. Retranslate every target locale unless the user narrowed the set — a partial run leaves the other locales stale, which defeats the point.
2. Establish the style brief BEFORE delegating. Use project_info.translationStyle when present; otherwise ask the user for a brief covering tone and voice, formality/address choices, recurring product terms, and terms that stay untranslated. Do not infer style from existing translations. If the retranslation was prompted by a specific change (new terminology, reworded source copy), state it in the brief so every subagent applies it.
3. Spawn one subagent per target locale, all in parallel. Give each subagent: the style brief verbatim, its single target locale, and these instructions — loop until \`hasMore\` is false: call get_retranslation_batch with { ${subagentBatchArgs} }, produce a fresh translation for every item per the brief (each item's \`existingTarget\` shows the current value; when it already fits the brief you may keep it by skipping the item — skipped items don't stall the loop, the cursor moves regardless), save the rest with save_translations (it overwrites existing values), fix per-item errors from \`results\` and re-save only those before continuing with \`after: nextCursor\`. Translate only your own locale; never touch others.
4. When all subagents are done, confirm coverage: each subagent's first batch reports \`total\` (the keys in its scope) — check every subagent walked its full scope (last call had \`hasMore: false\`). Re-dispatch a subagent for any locale that stopped early.
5. Report a summary: the style brief you used, per-locale counts of retranslated vs. kept-as-is messages, anything subagents flagged as ambiguous, and suggest running the Paraglide compile step (usually part of dev/build).

${translationRules(options)}`;
}

function reviewWorkflow(
	args: { locale: string; prefix?: string },
	options: PromptOptions
): string {
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
   - the text is actually translated (not copied source text), is roughly the source's length, and is stylistically consistent (one tone, formality level, and terminology across the locale).
4. Fix problems with save_translations in small batches and check \`results\` for per-item errors.
5. Report a summary: how many messages you reviewed, how many you fixed and why, and anything ambiguous you left unchanged.

${translationRules(options)}`;
}

function userMessage(text: string) {
	return [
		{
			role: "user" as const,
			content: { type: "text" as const, text },
		},
	];
}
