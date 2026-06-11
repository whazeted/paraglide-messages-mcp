/**
 * Defaults for batching and pagination. Tool schemas, service validation,
 * and the workflow prompt texts source from here. These are defaults only —
 * callers may pass any positive value; nothing is capped.
 *
 * The SKILL could drift from these constants so keep that in mind.
 */

/**
 * Default translate batch size. Sized for per-locale throughput (one agent —
 * or subagent — owns a whole locale): validation is per-item, so a bad
 * translation in a large batch is rejected individually instead of sinking
 * the call. Raising it means fewer round-trips (good for short UI strings);
 * lowering it gives each item more of the agent's attention (good for long,
 * tricky prose).
 */
export const DEFAULT_TRANSLATION_BATCH_SIZE = 50;

/** Default page size for list_message_keys. */
export const DEFAULT_LIST_KEYS_PAGE_SIZE = 100;

/** Default number of messages per get_messages call. */
export const DEFAULT_GET_MESSAGES_LIMIT = 50;

/** Default number of results per search_messages call. */
export const DEFAULT_SEARCH_MESSAGES_LIMIT = 20;

/** Max suggestions returned for prompt/resource argument completion. */
export const COMPLETION_SUGGESTION_LIMIT = 50;
