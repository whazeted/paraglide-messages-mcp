import type { ComplexMessage, MessageValue } from "./types.js";

/**
 * Utilities for working with the inlang message format's compact pattern
 * syntax ("Hello {name}", escapes via backslash, markup via {#tag}/{/tag}).
 */

export function isComplexMessage(value: MessageValue): value is ComplexMessage {
	return Array.isArray(value);
}

/**
 * Extracts the placeholders of a compact pattern string.
 *
 * Returns variable placeholders like `{name}` as "name" and markup
 * placeholders like `{#bold}` / `{/bold}` / `{#br/}` verbatim including
 * braces, so that mismatching markup is also caught by validation.
 */
export function extractPlaceholders(pattern: string): {
	variables: string[];
	markup: string[];
} {
	const variables: string[] = [];
	const markup: string[] = [];

	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "\\") {
			// skip escaped character
			i += 1;
			continue;
		}
		if (char !== "{") continue;

		const closing = findClosingBrace(pattern, i);
		if (closing === -1) continue;

		const body = pattern.slice(i + 1, closing);
		if (body.startsWith("#") || body.startsWith("/")) {
			markup.push(`{${body}}`);
		} else if (body.length > 0) {
			variables.push(body);
		}
		i = closing;
	}

	return { variables, markup };
}

function findClosingBrace(value: string, openingIndex: number): number {
	let inQuotedLiteral = false;
	for (let cursor = openingIndex + 1; cursor < value.length; cursor++) {
		const current = value[cursor];
		if (inQuotedLiteral && current === "\\") {
			cursor += 1;
			continue;
		}
		if (current === "|") {
			inQuotedLiteral = !inQuotedLiteral;
			continue;
		}
		if (current === "}" && !inQuotedLiteral) {
			return cursor;
		}
	}
	return -1;
}

/**
 * All patterns contained in a message value (1 for simple, n for variants).
 * Values read from disk may carry multiple array elements (legacy or
 * hand-written files) — every element's patterns count.
 */
export function patternsOf(value: MessageValue): string[] {
	if (isComplexMessage(value)) {
		return value.flatMap((spec) => Object.values(spec?.match ?? {}));
	}
	return [value];
}

/**
 * The set of variable placeholders used anywhere in a message value,
 * including selector variables of complex messages.
 */
export function placeholdersOf(value: MessageValue): string[] {
	return [
		...messageReferencesOf(value, { includeInputDeclarations: true }).variables,
	].sort();
}

function messageReferencesOf(
	value: MessageValue,
	options?: { includeInputDeclarations?: boolean }
): {
	variables: Set<string>;
	markup: Set<string>;
} {
	const variables = new Set<string>();
	const markup = new Set<string>();

	for (const pattern of patternsOf(value)) {
		const placeholders = extractPlaceholders(pattern);
		for (const variable of placeholders.variables) variables.add(variable);
		for (const tag of placeholders.markup) markup.add(tag);
	}

	if (options?.includeInputDeclarations !== false && isComplexMessage(value)) {
		for (const spec of value) {
			for (const declaration of spec?.declarations ?? []) {
				if (declaration.startsWith("input ")) {
					variables.add(declaration.slice("input ".length).trim());
				}
			}
		}
	}

	return { variables, markup };
}

export interface ValidationResult {
	errors: string[];
	warnings: string[];
}

/**
 * Validates a translation against its source message.
 *
 * Rules (designed to catch the common agent failure modes):
 * - the translation must be a string or a single-element variant array
 * - variable placeholders in the translation must exist in the source
 *   (a typo'd `{nmae}` would otherwise silently become a new input variable)
 * - source placeholders missing from the translation are warnings, not
 *   errors — languages legitimately drop variables in some variants
 * - markup tags must match the source's markup set
 * - complex translations must have at least one variant, and their selectors
 *   must be declared (or exist in the source)
 */
export function validateTranslation(
	source: MessageValue,
	translation: unknown
): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!isValidMessageValue(translation)) {
		return { errors: [messageValueError(translation)], warnings };
	}

	const sourceReferences = messageReferencesOf(source, {
		includeInputDeclarations: true,
	});
	const sourceVariables = sourceReferences.variables;
	const sourceMarkup = sourceReferences.markup;
	const sourcePlaceholders =
		[...sourceVariables].sort().map((v) => `{${v}}`).join(", ") || "none";

	// selectors of a complex translation count as known variables
	const knownVariables = new Set(sourceVariables);
	if (isComplexMessage(translation)) {
		const spec = translation[0];
		if (!spec || typeof spec.match !== "object" || spec.match === null) {
			errors.push('complex message must contain a "match" object');
			return { errors, warnings };
		}
		const matchKeys = Object.keys(spec.match);
		if (matchKeys.length === 0) {
			errors.push('"match" must contain at least one variant');
		}
		for (const declaration of spec.declarations ?? []) {
			const name = declarationName(declaration);
			if (name) knownVariables.add(name);
		}
		// selector keys used in match conditions must be declared somewhere
		for (const matchKey of matchKeys) {
			for (const condition of matchKey.split(",")) {
				const selector = condition.split("=")[0]?.trim();
				if (selector && !knownVariables.has(selector)) {
					errors.push(
						`match condition "${condition.trim()}" uses undeclared selector "${selector}" — ` +
							`declare it (e.g. "input ${selector}" or a local variable) or use a selector from the source`
					);
				}
			}
		}
	}

	const usedReferences = messageReferencesOf(translation, {
		includeInputDeclarations: false,
	});
	const usedVariables = usedReferences.variables;
	const usedMarkup = usedReferences.markup;

	validateReferences({
		used: usedVariables,
		known: knownVariables,
		required: sourceVariables,
		errors,
		warnings,
		unknownMessage: (variable) =>
			`placeholder {${variable}} does not exist in the source message ` +
			`(source placeholders: ${sourcePlaceholders})`,
		missingMessage: (variable) =>
			`source placeholder {${variable}} is not used in the translation`,
	});

	validateReferences({
		used: usedMarkup,
		known: sourceMarkup,
		required: sourceMarkup,
		errors,
		warnings,
		unknownMessage: (tag) => `markup ${tag} does not exist in the source message`,
		missingMessage: (tag) => `source markup ${tag} is not used in the translation`,
	});

	return { errors, warnings };
}

function validateReferences(options: {
	used: ReadonlySet<string>;
	known: ReadonlySet<string>;
	required: ReadonlySet<string>;
	errors: string[];
	warnings: string[];
	unknownMessage: (value: string) => string;
	missingMessage: (value: string) => string;
}): void {
	for (const value of options.used) {
		if (!options.known.has(value)) {
			options.errors.push(options.unknownMessage(value));
		}
	}

	for (const value of options.required) {
		if (!options.used.has(value)) {
			options.warnings.push(options.missingMessage(value));
		}
	}
}

export function isValidMessageValue(value: unknown): value is MessageValue {
	if (typeof value === "string") return true;
	if (Array.isArray(value)) {
		if (value.length !== 1) return false;
		const spec = value[0];
		return (
			typeof spec === "object" &&
			spec !== null &&
			typeof (spec as Record<string, unknown>).match === "object" &&
			(spec as Record<string, unknown>).match !== null &&
			Object.values((spec as { match: Record<string, unknown> }).match).every(
				(p) => typeof p === "string"
			)
		);
	}
	return false;
}

/**
 * The structural-rejection message for a value that failed
 * isValidMessageValue. Multi-element variant arrays get a specific
 * explanation: the file schema allows them, but the message-format plugin
 * (and thus the Paraglide compiler) only reads the first element, so saving
 * them would write content the toolchain silently ignores. The fix is to
 * consolidate, which this message walks the agent through.
 */
export function messageValueError(value: unknown): string {
	if (Array.isArray(value) && value.length > 1) {
		return (
			`the variant array has ${value.length} elements, but the toolchain only reads the first — ` +
			"consolidate all variants into ONE array element by merging every element's " +
			'"match" entries (and "declarations"/"selectors") into a single ' +
			'{ "declarations": [...], "selectors": [...], "match": {...} } object'
		);
	}
	return (
		"value must be a string or a single-element array of the form " +
		'[{ "declarations"?: string[], "selectors"?: string[], "match": { "<selector>=<value>": "<pattern>" } }]'
	);
}

function declarationName(declaration: string): string | undefined {
	if (declaration.startsWith("input ")) {
		return declaration.slice("input ".length).trim();
	}
	if (declaration.startsWith("local ")) {
		return declaration
			.slice("local ".length)
			.split("=")[0]
			?.trim();
	}
	return undefined;
}

/** True if a message value is effectively empty (untranslated). */
export function isEmptyValue(value: MessageValue | undefined): boolean {
	if (value === undefined) return true;
	if (typeof value === "string") return value.trim().length === 0;
	const patterns = patternsOf(value);
	return (
		patterns.length === 0 || patterns.every((p) => p.trim().length === 0)
	);
}
