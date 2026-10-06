import { z } from "zod";

export const recipeImportImageSchema = z.object({
 imageBase64: z.string().min(1),
 mimeType: z.enum(["image/jpeg", "image/png", "image/webp"])
}).strict();

export const recipeImportFileSchema = z.object({
 fileBase64: z.string().min(1),
 fileName: z.string().trim().min(1).max(255),
 mimeType: z.enum([
 "application/pdf",
 "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
 "text/html",
 "text/markdown",
 "text/plain",
 "application/rtf"
 ])
}).strict();

export const recipeImportRequestSchema = z.object({
 images: z.array(recipeImportImageSchema).max(4).default([]),
 files: z.array(recipeImportFileSchema).max(3).default([]),
 pastedText: z.string().trim().max(50000).optional()
}).strict().superRefine((value, context) => {
 if (value.images.length === 0 && value.files.length === 0 && !value.pastedText) {
 context.addIssue({
 code: z.ZodIssueCode.custom,
 message: "Provide at least one recipe image, document, or pasted recipe text."
 });
 }
});

export const importedRecipeIngredientSchema = z.object({
 name: z.string().trim().min(1).max(120),
 quantity: z.number().positive().max(100000),
 unit: z.string().trim().min(1).max(40)
});

export const recipeExtractionSchema = z.object({
 name: z.string().trim().min(1).max(160),
 description: z.string().trim().max(2000),
 instructions: z.string().trim().max(20000),
 servings: z.number().int().min(1).max(50),
 prepMinutes: z.number().int().min(0).max(1440),
 cookMinutes: z.number().int().min(0).max(1440),
 tags: z.array(z.string().trim().min(1).max(40)).max(20),
 ingredients: z.array(importedRecipeIngredientSchema).min(1).max(100),
 warnings: z.array(z.string().trim().min(1).max(300)).max(20)
});

export type RecipeExtraction = z.infer<typeof recipeExtractionSchema>;
export type RecipeImportRequest = z.infer<typeof recipeImportRequestSchema>;
