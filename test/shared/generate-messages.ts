import type { MessageValue } from "../../src/core/types.js";

/**
 * Deterministic generator for varied English source messages: single words,
 * short phrases, sentences with one or several placeholders, multi-sentence
 * paragraphs, and plural variant arrays — all composed from small word pools
 * via a seeded PRNG, so the same seed always yields the same messages.
 */
const ADJECTIVES = [
	"new",
	"pending",
	"archived",
	"secure",
	"shared",
	"recent",
	"primary",
	"hidden",
	"verified",
	"draft",
];

const NOUNS = [
	"order",
	"invoice",
	"account",
	"message",
	"report",
	"payment",
	"profile",
	"document",
	"subscription",
	"device",
	"folder",
	"receipt",
];

const VERBS = [
	"create",
	"update",
	"delete",
	"export",
	"review",
	"submit",
	"cancel",
	"approve",
	"restore",
	"download",
];

const PAST_TENSE: Record<string, string> = {
	create: "created",
	update: "updated",
	delete: "deleted",
	export: "exported",
	review: "reviewed",
	submit: "submitted",
	cancel: "cancelled",
	approve: "approved",
	restore: "restored",
	download: "downloaded",
};

const PLACEHOLDER_NAMES = ["name", "count", "date", "email", "amount", "plan"];

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rng: () => number, items: readonly T[]): T {
	return items[Math.floor(rng() * items.length)]!;
}

function capitalize(word: string): string {
	return word[0]!.toUpperCase() + word.slice(1);
}

/** A readable, unique message key like `checkout_create_subscription_001`. */
export function generateKey(
	rng: () => number,
	namespace: string,
	uniqueSuffix: string
): string {
	return `${namespace}_${pick(rng, VERBS)}_${pick(rng, NOUNS)}_${uniqueSuffix}`;
}

function plainSentence(rng: () => number): string {
	const templates = [
		() => `${capitalize(pick(rng, VERBS))} the ${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS)}.`,
		() => `Your ${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS)} is ready.`,
		() => `The ${pick(rng, NOUNS)} could not be ${PAST_TENSE[pick(rng, VERBS)]}.`,
		() => `${capitalize(pick(rng, ADJECTIVES))} ${pick(rng, NOUNS)}s are listed below.`,
	];
	return pick(rng, templates)();
}

function placeholderSentence(rng: () => number, placeholders: string[]): string {
	const [first, second, third] = placeholders;
	if (placeholders.length === 1) {
		const templates = [
			() => `Hello {${first}}, your ${pick(rng, NOUNS)} is ready.`,
			() => `We sent a ${pick(rng, NOUNS)} to {${first}}.`,
			() => `{${first}} ${pick(rng, NOUNS)}s require your attention.`,
		];
		return pick(rng, templates)();
	}
	if (placeholders.length === 2) {
		return `Hi {${first}}, your ${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS)} expires on {${second}}.`;
	}
	return `Hi {${first}}, we billed {${second}} to {${third}} for your ${pick(rng, NOUNS)}.`;
}

function paragraph(rng: () => number): string {
	const sentences = Array.from(
		{ length: 2 + Math.floor(rng() * 3) },
		() => plainSentence(rng)
	);
	if (rng() < 0.5) {
		sentences.push(placeholderSentence(rng, [pick(rng, PLACEHOLDER_NAMES)]));
	}
	if (sentences.length >= 4 && rng() < 0.5) {
		const half = Math.ceil(sentences.length / 2);
		return `${sentences.slice(0, half).join(" ")}\n\n${sentences.slice(half).join(" ")}`;
	}
	return sentences.join(" ");
}

function pluralVariant(rng: () => number): MessageValue {
	const noun = pick(rng, NOUNS);
	const adjective = pick(rng, ADJECTIVES);
	return [
		{
			declarations: ["input count", "local countPlural = count: plural"],
			selectors: ["countPlural"],
			match: {
				"countPlural=one": `You have {count} ${adjective} ${noun}`,
				"countPlural=other": `You have {count} ${adjective} ${noun}s`,
			},
		},
	];
}

/** Builds one English message; the roll decides the shape. */
export function generateMessage(rng: () => number): MessageValue {
	const roll = rng();

	// single word ("Cancel", "Invoice")
	if (roll < 0.15) {
		return capitalize(pick(rng, [...VERBS, ...NOUNS, ...ADJECTIVES]));
	}

	// short phrase without punctuation ("Export pending invoices")
	if (roll < 0.4) {
		return `${capitalize(pick(rng, VERBS))} ${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS)}s`;
	}

	// sentence with a single placeholder
	if (roll < 0.62) {
		return placeholderSentence(rng, [pick(rng, PLACEHOLDER_NAMES)]);
	}

	// sentence with multiple distinct placeholders
	if (roll < 0.75) {
		const count = rng() < 0.5 ? 2 : 3;
		const placeholders = [...PLACEHOLDER_NAMES]
			.sort(() => rng() - 0.5)
			.slice(0, count);
		return placeholderSentence(rng, placeholders);
	}

	// multi-sentence paragraph
	if (roll < 0.9) {
		return paragraph(rng);
	}

	return pluralVariant(rng);
}
