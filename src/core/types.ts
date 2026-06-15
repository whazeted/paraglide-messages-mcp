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
 *
 * The file schema permits more than one array element, and hand-written or
 * legacy files may contain them — but the message-format plugin (and thus the
 * Paraglide compiler) only honors the first element. The server therefore
 * reads all elements (so such messages are fully understood) but only accepts
 * the single-element form on save; fixing a multi-element message means
 * consolidating its variants into one element's `match`.
 */
export type SimpleMessage = string;

export interface VariantSpec {
	declarations?: string[];
	selectors?: string[];
	match: Record<string, string>;
}

export type ComplexMessage = VariantSpec[];

export type MessageValue = SimpleMessage | ComplexMessage;

/** Flat map of message key -> value for a single locale. */
export type LocaleMessages = Record<string, MessageValue>;

/** Flat map of locale -> messages. */
export type MessagesSnapshot = Record<string, LocaleMessages>;

// type alias (not interface) so it satisfies the MCP SDK's
// Record<string, unknown> constraint on structuredContent
export type ProjectInfo = {
	projectPath: string;
	baseLocale: string;
	locales: string[];
	pluginKey: string;
	/** count of keys present in any locale, including non-source/orphan keys */
	totalKeys: number;
	/** count of non-empty base-locale keys eligible for translation */
	translatableKeys: number;
	/** Linguistic style brief configured at server startup, if any. */
	translationStyle?: string;
	/** per locale: number of keys that have a non-empty message */
	translated: Record<string, number>;
	/** per locale: translatable base-locale keys missing or empty in this locale */
	missing: Record<string, number>;
	/** per locale: non-empty keys ignored by the translate loop because the base value is empty/missing */
	extraKeys: Record<string, number>;
};

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

export interface DeleteResultItem {
	key: string;
	status: "deleted" | "error";
	error?: string;
}
