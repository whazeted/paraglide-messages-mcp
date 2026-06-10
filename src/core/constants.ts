/**
 * Central limits and defaults for batching and pagination. Tool schemas,
 * service validation, the workflow prompt texts source from here.
 * 
 * The SKILL could drift from these constants so keep that in mind.
 */

/** Default translate batch size — small on purpose: accuracy beats batch size. */
export const DEFAULT_BATCH_SIZE = 5;

/** Max messages per get_translation_batch call. */
export const MAX_BATCH_SIZE = 25;

/** Max translations per save_translations call. */
export const MAX_SAVE_BATCH = 25;

/** Default/max page size for list_message_keys. */
export const DEFAULT_KEYS_LIMIT = 100;
export const MAX_KEYS_LIMIT = 500;

/** Default/max number of messages per get_messages call. */
export const DEFAULT_MESSAGES_LIMIT = 50;
export const MAX_MESSAGES_LIMIT = 200;

/** Default/max number of results per search_messages call. */
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

/** Max suggestions returned for prompt/resource argument completion. */
export const COMPLETION_LIMIT = 50;
