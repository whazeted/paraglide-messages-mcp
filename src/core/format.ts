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

/** All patterns contained in a message value (1 for simple, n for variants). */
export function patternsOf(value: MessageValue): string[] {
	if (isComplexMessage(value)) {
		return Object.values(value[0]?.match ?? {});
	}
	return [value];
}

/**
 * The set of variable placeholders used anywhere in a message value,
 * including selector variables of complex messages.
 */
export function placeholdersOf(value: MessageValue): string[] {
	const result = new Set<string>();
	for (const pattern of patternsOf(value)) {
		for (const variable of extractPlaceholders(pattern).variables) {
			result.add(variable);
		}
	}
	if (isComplexMessage(value)) {
		for (const declaration of value[0]?.declarations ?? []) {
			if (declaration.startsWith("input ")) {
				result.add(declaration.slice("input ".length).trim());
			}
		}
	}
	return [...result].sort();
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
		return {
			errors: [
				"value must be a string or a single-element array of the form " +
					'[{ "declarations"?: string[], "selectors"?: string[], "match": { "<selector>=<value>": "<pattern>" } }]',
			],
			warnings,
		};
	}

	const sourceVariables = new Set(placeholdersOf(source));
	const sourceMarkup = new Set(
		patternsOf(source).flatMap((p) => extractPlaceholders(p).markup)
	);

	// selectors of a complex translation count as known variables
	const knownVariables = new Set(sourceVariables);
	if (isComplexMessage(translation)) {
		const spec = translation[0];
		if (!spec || typeof spec.match !== "object" || spec.match === null) {
			errors.push('complex message must contain a "match" object');
			return { errors, warnings };
		}
		if (Object.keys(spec.match).length === 0) {
			errors.push('"match" must contain at least one variant');
		}
		for (const declaration of spec.declarations ?? []) {
			const name = declarationName(declaration);
			if (name) knownVariables.add(name);
		}
		// selector keys used in match conditions must be declared somewhere
		for (const matchKey of Object.keys(spec.match)) {
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

	const usedVariables = new Set<string>();
	const usedMarkup = new Set<string>();
	for (const pattern of patternsOf(translation)) {
		const { variables, markup } = extractPlaceholders(pattern);
		for (const v of variables) usedVariables.add(v);
		for (const m of markup) usedMarkup.add(m);
	}

	for (const variable of usedVariables) {
		if (!knownVariables.has(variable)) {
			errors.push(
				`placeholder {${variable}} does not exist in the source message ` +
					`(source placeholders: ${[...sourceVariables].map((v) => `{${v}}`).join(", ") || "none"})`
			);
		}
	}

	for (const variable of sourceVariables) {
		if (!usedVariables.has(variable)) {
			warnings.push(
				`source placeholder {${variable}} is not used in the translation`
			);
		}
	}

	for (const tag of usedMarkup) {
		if (!sourceMarkup.has(tag)) {
			errors.push(`markup ${tag} does not exist in the source message`);
		}
	}
	for (const tag of sourceMarkup) {
		if (!usedMarkup.has(tag)) {
			warnings.push(`source markup ${tag} is not used in the translation`);
		}
	}

	return { errors, warnings };
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
	const match = value[0]?.match ?? {};
	const patterns = Object.values(match);
	return (
		patterns.length === 0 || patterns.every((p) => p.trim().length === 0)
	);
}
