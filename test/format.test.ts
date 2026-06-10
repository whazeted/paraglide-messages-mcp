import { describe, expect, it } from "vitest";
import {
	extractPlaceholders,
	isEmptyValue,
	isValidMessageValue,
	placeholdersOf,
	validateTranslation,
} from "../src/format.js";
import type { ComplexMessage } from "../src/types.js";

describe("extractPlaceholders", () => {
	it("extracts variable placeholders", () => {
		expect(extractPlaceholders("Hello {name}, you have {count}!")).toEqual({
			variables: ["name", "count"],
			markup: [],
		});
	});

	it("returns nothing for plain text", () => {
		expect(extractPlaceholders("Hello world")).toEqual({
			variables: [],
			markup: [],
		});
	});

	it("ignores escaped braces", () => {
		expect(extractPlaceholders("literal \\{braces\\} and {real}")).toEqual({
			variables: ["real"],
			markup: [],
		});
	});

	it("extracts markup placeholders verbatim", () => {
		expect(extractPlaceholders("click {#bold}here{/bold}{#br/}")).toEqual({
			variables: [],
			markup: ["{#bold}", "{/bold}", "{#br/}"],
		});
	});

	it("ignores an unclosed brace", () => {
		expect(extractPlaceholders("oops {name")).toEqual({
			variables: [],
			markup: [],
		});
	});
});

describe("placeholdersOf", () => {
	it("collects placeholders from all variants and declarations", () => {
		const value: ComplexMessage = [
			{
				declarations: ["input count", "local countPlural = count: plural"],
				selectors: ["countPlural"],
				match: {
					"countPlural=one": "You have {count} message",
					"countPlural=other": "You have {count} messages",
				},
			},
		];
		expect(placeholdersOf(value)).toEqual(["count"]);
	});

	it("works for simple messages", () => {
		expect(placeholdersOf("Hi {name}")).toEqual(["name"]);
	});
});

describe("validateTranslation", () => {
	it("accepts a faithful simple translation", () => {
		const result = validateTranslation("Hello {name}!", "Hallo {name}!");
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it("rejects placeholders that do not exist in the source (typo guard)", () => {
		const result = validateTranslation("Hello {name}!", "Hallo {nmae}!");
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("{nmae}");
	});

	it("warns (not errors) when a source placeholder is dropped", () => {
		const result = validateTranslation("Hello {name}!", "Hallo!");
		expect(result.errors).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("{name}");
	});

	it("rejects mismatched markup", () => {
		const result = validateTranslation(
			"click {#bold}here{/bold}",
			"klick {#italic}hier{/italic}"
		);
		expect(result.errors.some((e) => e.includes("{#italic}"))).toBe(true);
	});

	it("rejects values that are neither string nor variant array", () => {
		const result = validateTranslation("Hello", 42);
		expect(result.errors).toHaveLength(1);
	});

	it("accepts a complex translation reusing source selectors", () => {
		const source: ComplexMessage = [
			{
				declarations: ["input count", "local countPlural = count: plural"],
				selectors: ["countPlural"],
				match: {
					"countPlural=one": "{count} message",
					"countPlural=other": "{count} messages",
				},
			},
		];
		const translation: ComplexMessage = [
			{
				declarations: ["input count", "local countPlural = count: plural"],
				selectors: ["countPlural"],
				match: {
					"countPlural=one": "{count} Nachricht",
					"countPlural=other": "{count} Nachrichten",
				},
			},
		];
		const result = validateTranslation(source, translation);
		expect(result.errors).toEqual([]);
	});

	it("allows a translation to add variants for its own language", () => {
		// e.g. translating a simple English message into a language that
		// needs plural variants — selectors must be declared though
		const translation = [
			{
				declarations: ["input count", "local countPlural = count: plural"],
				selectors: ["countPlural"],
				match: {
					"countPlural=one": "{count} zpráva",
					"countPlural=few": "{count} zprávy",
					"countPlural=other": "{count} zpráv",
				},
			},
		];
		const result = validateTranslation("{count} messages", translation);
		expect(result.errors).toEqual([]);
	});

	it("rejects match conditions with undeclared selectors", () => {
		const translation = [
			{
				match: {
					"gender=male": "Er",
					"gender=female": "Sie",
				},
			},
		];
		const result = validateTranslation("They", translation);
		expect(result.errors.some((e) => e.includes("gender"))).toBe(true);
	});

	it("rejects a complex message without variants", () => {
		const result = validateTranslation("Hello", [{ match: {} }]);
		expect(result.errors.some((e) => e.includes("at least one variant"))).toBe(
			true
		);
	});
});

describe("isValidMessageValue", () => {
	it("accepts strings", () => {
		expect(isValidMessageValue("hi")).toBe(true);
	});
	it("accepts single-element variant arrays", () => {
		expect(isValidMessageValue([{ match: { "x=*": "hi" } }])).toBe(true);
	});
	it("rejects multi-element arrays", () => {
		expect(
			isValidMessageValue([{ match: { "x=*": "a" } }, { match: { "x=*": "b" } }])
		).toBe(false);
	});
	it("rejects non-string patterns", () => {
		expect(isValidMessageValue([{ match: { "x=*": 1 } }])).toBe(false);
	});
	it("rejects objects and numbers", () => {
		expect(isValidMessageValue({ match: {} })).toBe(false);
		expect(isValidMessageValue(7)).toBe(false);
	});
});

describe("isEmptyValue", () => {
	it("treats undefined and blank strings as empty", () => {
		expect(isEmptyValue(undefined)).toBe(true);
		expect(isEmptyValue("")).toBe(true);
		expect(isEmptyValue("   ")).toBe(true);
	});
	it("treats text and non-empty variants as translated", () => {
		expect(isEmptyValue("hi")).toBe(false);
		expect(isEmptyValue([{ match: { "x=*": "hi" } }])).toBe(false);
	});
	it("treats variant maps with only blank patterns as empty", () => {
		expect(isEmptyValue([{ match: { "x=*": "" } }])).toBe(true);
	});
});
