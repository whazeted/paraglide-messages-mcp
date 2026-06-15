export { createServer, SERVER_VERSION, type ServerOptions } from "./server.js";
export { TranslationService } from "./core/service.js";
export { discoverProjectPath } from "./core/project.js";
export {
	extractPlaceholders,
	placeholdersOf,
	validateTranslation,
	isComplexMessage,
	isEmptyValue,
	isValidMessageValue,
} from "./core/format.js";
export type * from "./core/types.js";
