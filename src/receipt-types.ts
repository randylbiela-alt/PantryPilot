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

export type ReceiptItem = z.infer<typeof receiptItemSchema>;
export type ReceiptExtraction = z.infer<typeof receiptExtractionSchema>;
