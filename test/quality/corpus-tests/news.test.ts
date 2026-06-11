import { corpusFileSpec } from "./shared.js";

corpusFileSpec("news", { minDistinctSourceUrls: 4, allowedHosts: ["en.wikinews.org"] });
