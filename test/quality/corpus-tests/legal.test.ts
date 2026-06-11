import { corpusFileSpec } from "./shared.js";

corpusFileSpec("legal", { minDistinctSourceUrls: 3, allowedHosts: ["www.federalregister.gov"] });
