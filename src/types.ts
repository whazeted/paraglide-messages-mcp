/**
 * Message values use the inlang message format file schema, i.e. exactly what
 * users see in their `messages/{locale}.json` files.
 *
 * A simple message is a plain string with `{placeholder}` expressions:
 *   "Hello {name}!"
 *
 * A complex (multi-variant) message is a single-element array:
 *   [{
 *     "declarations": ["input count", "local countPlural = count: plural"],
 *     "selectors": ["countPlural"],
 *     "match": {
 *       "countPlural=one": "{count} message",
 *       "countPlural=other": "{count} messages"
 *     }
 *   }]
 */
export type SimpleMessage = string;

export type ComplexMessage = [
	{
		declarations?: string[];
		selectors?: string[];
		match: Record<string, string>;
	},
];

export type MessageValue = SimpleMessage | ComplexMessage;

/** Flat map of message key -> value for a single locale. */
export type LocaleMessages = Record<string, MessageValue>;

/** Flat map of locale -> messages. */
export type MessagesSnapshot = Record<string, LocaleMessages>;

export interface ProjectInfo {
	projectPath: string;
	baseLocale: string;
	locales: string[];
	pluginKey: string;
	totalKeys: number;
	/** per locale: number of keys that have a non-empty message */
	translated: Record<string, number>;
	/** per locale: number of keys missing or empty */
	missing: Record<string, number>;
}

export interface TranslationItem {
	key: string;
	/** value in the source locale */
	source: MessageValue;
	/** existing value in the target locale, if any (e.g. empty or stale) */
	existingTarget?: MessageValue;
	/** placeholders that must be preserved in the translation */
	placeholders: string[];
}

export interface TranslationInput {
	key: string;
	/** the translated value — same shape as the source (string or variant object) */
	value: MessageValue;
}

export interface SaveResultItem {
	key: string;
	status: "saved" | "error";
	error?: string;
	warnings?: string[];
}
