import { z } from "zod";

export const receiptImageRequest = z.object({
 imageBase64: z.string().min(1),
 mimeType: z.enum(["image/jpeg", "image/png", "image/webp"])
}).strict();

export const receiptItemSchema = z.object({
 name: z.string().trim().min(1).max(120),
 quantity: z.number().positive().max(1000),
 unit: z.string().trim().max(40),
 category: z.string().trim().max(60)
});

export const receiptExtractionSchema = z.object({
 merchantName: z.string().trim().max(160),
 purchaseDate: z.string().trim().max(30),
 items: z.array(receiptItemSchema).max(250)
});

export const receiptImportItemSchema = z.object({
 name: z.string().trim().min(1).max(120),
 quantity: z.number().positive().max(1000),
 unit: z.string().trim().min(1).max(40).default("item"),
 category: z.string().trim().max(60).nullable().optional(),
 expirationDate: z.string().date().nullable().optional()
}).strict();

export const receiptImportRequestSchema = z.object({
 items: z.array(receiptImportItemSchema).min(1).max(250)
}).strict();

export type ReceiptItem = z.infer<typeof receiptItemSchema>;
export type ReceiptExtraction = z.infer<typeof receiptExtractionSchema>;
export type ReceiptImportItem = z.infer<typeof receiptImportItemSchema>;
