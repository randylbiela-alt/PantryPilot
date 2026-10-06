import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import { receiptExtractionSchema, type ReceiptExtraction } from "./receipt-types.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function cleanBase64(value: string): string {
 const marker = value.indexOf("base64,");
 return (marker >= 0 ? value.slice(marker + 7) : value).replace(/\s+/g, "");
}

function validateImage(imageBase64: string): string {
 const clean = cleanBase64(imageBase64);
 if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
 throw new AppError(400, "INVALID_RECEIPT_IMAGE", "The receipt image is not valid base64 data.");
 }
 const bytes = Buffer.byteLength(clean, "base64");
 if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) {
 throw new AppError(413, "RECEIPT_IMAGE_TOO_LARGE", "Receipt images must be 8 MB or smaller.");
 }
 return clean;
}

function normalize(result: ReceiptExtraction): ReceiptExtraction {
 const seen = new Map<string, ReceiptExtraction["items"][number]>();
 for (const item of result.items) {
 const name = item.name.replace(/\s+/g, " ").trim();
 if (!name) continue;
 const key = `${name.toLocaleLowerCase("en-US")}|${item.unit.toLocaleLowerCase("en-US")}`;
 const current = seen.get(key);
 if (current) current.quantity += item.quantity;
 else seen.set(key, { ...item, name });
 }
 return { ...result, items: [...seen.values()] };
}

export async function extractReceipt(
 config: Config,
 imageBase64: string,
 mimeType: "image/jpeg" | "image/png" | "image/webp"
): Promise<ReceiptExtraction> {
 const clean = validateImage(imageBase64);
 const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
 try {
 const response = await client.responses.parse({
 model: config.OPENAI_VISION_MODEL,
 store: false,
 input: [{
 role: "user",
 content: [
 {
 type: "input_text",
 text: "Extract purchased grocery and household consumable line items from this receipt. Exclude store details, payment data, discounts, taxes, subtotals, totals, loyalty lines, and non-item lines. Expand common abbreviations when reasonably clear. Use quantity 1 when quantity is not shown. Use an empty string when unit, category, merchant name, or purchase date is unknown. Do not invent products that are not visible."
 },
 {
 type: "input_image",
 image_url: `data:${mimeType};base64,${clean}`,
 detail: "high"
 }
 ]
 }],
 text: {
 format: zodTextFormat(receiptExtractionSchema, "receipt_extraction")
 }
 });
 if (!response.output_parsed) {
 throw new AppError(422, "RECEIPT_NOT_READABLE", "No structured receipt items could be extracted from the image.");
 }
 return normalize(response.output_parsed);
 } catch (error) {
 if (error instanceof AppError) throw error;
 const status = typeof error === "object" && error !== null && "status" in error
 ? Number((error as { status?: unknown }).status)
 : 0;
 if (status === 401 || status === 403) {
 throw new AppError(502, "OCR_CONFIGURATION_ERROR", "The receipt analysis service is not configured correctly.");
 }
 if (status === 429) {
 throw new AppError(429, "OCR_RATE_LIMITED", "Receipt analysis is temporarily rate limited. Try again shortly.");
 }
 throw new AppError(502, "OCR_SERVICE_UNAVAILABLE", "Receipt analysis is temporarily unavailable.");
 }
}
