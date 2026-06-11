import { corpusFileSpec } from "./shared.js";

corpusFileSpec("medical", { minDistinctSourceUrls: 3, allowedHosts: ["medlineplus.gov"] });
