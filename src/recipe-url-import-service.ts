import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import { extractRecipe } from "./recipe-import-service.js";

const MAX_REDIRECTS = 4;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12000;

function isPrivateIpv4(address: string): boolean {
 const parts = address.split(".").map(Number);
 if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return true;
 const a = parts[0] ?? -1;
 const b = parts[1] ?? -1;
 return a === 0 || a === 10 || a === 127 ||
 (a === 169 && b === 254) ||
 (a === 172 && b >= 16 && b <= 31) ||
 (a === 192 && b === 168) ||
 (a === 100 && b >= 64 && b <= 127) ||
 a >= 224;
}

function isPrivateIp(address: string): boolean {
 if (isIP(address) === 4) return isPrivateIpv4(address);
 if (isIP(address) === 6) {
 const value = address.toLowerCase();
 return value === "::" || value === "::1" || value.startsWith("fc") ||
 value.startsWith("fd") || value.startsWith("fe8") ||
 value.startsWith("fe9") || value.startsWith("fea") ||
 value.startsWith("feb") || value.startsWith("ff") ||
 value.startsWith("::ffff:127.") || value.startsWith("::ffff:10.") ||
 value.startsWith("::ffff:192.168.");
 }
 return true;
}

async function validatePublicUrl(value: string): Promise<URL> {
 let url: URL;
 try { url = new URL(value); }
 catch { throw new AppError(400, "INVALID_RECIPE_URL", "Enter a valid public recipe URL."); }
 if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
 throw new AppError(400, "INVALID_RECIPE_URL", "Only public HTTP and HTTPS recipe URLs are supported.");
 }
 if (["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())) {
 throw new AppError(400, "UNSAFE_RECIPE_URL", "Private and local URLs are not allowed.");
 }
 const addresses = await lookup(url.hostname, { all: true, verbatim: true });
 if (!addresses.length || addresses.some(result => isPrivateIp(result.address))) {
 throw new AppError(400, "UNSAFE_RECIPE_URL", "The recipe URL resolves to a private or restricted network address.");
 }
 return url;
}

function decodeEntities(value: string): string {
 return value
 .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
 .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
 .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function htmlToText(html: string): string {
 const jsonLd = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
 .map(match => match[1]).join("\n");
 const body = html
 .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
 .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
 .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
 .replace(/<!--([\s\S]*?)-->/g, " ")
 .replace(/<(br|\/p|\/li|\/h[1-6]|\/section|\/article)>/gi, "\n")
 .replace(/<[^>]+>/g, " ");
 return decodeEntities(`${jsonLd}\n${body}`)
 .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n")
 .trim().slice(0, 100000);
}

async function fetchHtml(initialUrl: string): Promise<{ finalUrl: string; text: string }> {
 let current = await validatePublicUrl(initialUrl);
 for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
 const response = await fetch(current, {
 redirect: "manual",
 signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
 headers: {
 Accept: "text/html,application/xhtml+xml",
 "User-Agent": "PantryPilot-RecipeImporter/1.0"
 }
 });
 if (response.status >= 300 && response.status < 400) {
 const location = response.headers.get("location");
 if (!location || redirect === MAX_REDIRECTS) {
 throw new AppError(422, "RECIPE_URL_REDIRECT_FAILED", "The recipe page redirected too many times.");
 }
 current = await validatePublicUrl(new URL(location, current).toString());
 continue;
 }
 if (!response.ok) throw new AppError(422, "RECIPE_URL_FETCH_FAILED", `The recipe page returned HTTP ${response.status}.`);
 const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
 if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
 throw new AppError(415, "RECIPE_URL_NOT_HTML", "The URL does not point to an HTML recipe page.");
 }
 const declaredLength = Number(response.headers.get("content-length") ?? 0);
 if (declaredLength > MAX_HTML_BYTES) throw new AppError(413, "RECIPE_URL_TOO_LARGE", "The recipe page is too large to import.");
 const html = await response.text();
 if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) throw new AppError(413, "RECIPE_URL_TOO_LARGE", "The recipe page is too large to import.");
 return { finalUrl: current.toString(), text: htmlToText(html) };
 }
 throw new AppError(422, "RECIPE_URL_FETCH_FAILED", "The recipe page could not be fetched.");
}

export async function extractRecipeFromUrl(config: Config, sourceUrl: string) {
 const page = await fetchHtml(sourceUrl);
 if (page.text.length < 100) throw new AppError(422, "RECIPE_URL_EMPTY", "The page did not contain enough readable recipe content.");
 const draft = await extractRecipe(config, { images: [], files: [], pastedText: `Source URL: ${page.finalUrl}\n\n${page.text}` });
 return { ...draft, sourceUrl: page.finalUrl };
}

