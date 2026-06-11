import { corpusFileSpec } from "./shared.js";

corpusFileSpec("engineering", {
	minDistinctSourceUrls: 3,
	allowedHosts: ["www.nasa.gov", "science.nasa.gov", "www.nist.gov", "en.wikipedia.org"],
});
