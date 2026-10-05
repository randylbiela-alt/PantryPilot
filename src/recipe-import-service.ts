import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import {
  recipeExtractionSchema,
  type RecipeExtraction,
  type RecipeImportRequest
} from "./recipe-import-types.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

type RecipeContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "high" };

function cleanBase64(value: string): string {
  const marker = value.indexOf("base64,");
  return (marker >= 0 ? value.slice(marker + 7) : value).replace(/\s+/g, "");
}

function validateImage(imageBase64: string): string {
  const clean = cleanBase64(imageBase64);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    throw new AppError(400, "INVALID_RECIPE_IMAGE", "A recipe image is not valid base64 data.");
  }
  const bytes = Buffer.byteLength(clean, "base64");
  if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) {
    throw new AppError(413, "RECIPE_IMAGE_TOO_LARGE", "Each recipe image must be 8 MB or smaller.");
  }
  return clean;
}

function normalize(result: RecipeExtraction): RecipeExtraction {
  const ingredients = result.ingredients
    .map(item => ({
      ...item,
      name: item.name.replace(/\s+/g, " ").trim(),
      unit: item.unit.replace(/\s+/g, " ").trim() || "item"
    }))
    .filter(item => item.name.length > 0);

  return {
    ...result,
    name: result.name.replace(/\s+/g, " ").trim(),
    tags: [...new Set(result.tags.map(tag => tag.trim()).filter(Boolean))],
    ingredients
  };
}

export async function extractRecipe(
  config: Config,
  input: RecipeImportRequest
): Promise<RecipeExtraction> {
  const content: RecipeContent[] = [
    {
      type: "input_text",
      text: `Extract exactly one cooking recipe from the supplied images and/or text. Return a concise recipe name, a short description, complete cooking instructions in step order, servings, preparation minutes, cooking minutes, useful tags, and structured ingredients. Convert common fractions to decimal numbers. Use unit \"item\" when no unit is shown. Use zero for unknown preparation or cooking time and 4 for unknown servings. Add warnings for uncertain, unreadable, contradictory, or missing information. Ignore advertisements, navigation, comments, ratings, nutrition marketing, unrelated blog text, and copyright notices. Do not invent ingredients or steps that are not present.${input.pastedText ? `\n\nRecipe text:\n${input.pastedText}` : ""}`
    }
  ];

  for (const image of input.images) {
    const clean = validateImage(image.imageBase64);
    content.push({
      type: "input_image",
      image_url: `data:${image.mimeType};base64,${clean}`,
      detail: "high"
    });
  }

  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

  try {
    const response = await client.responses.parse({
      model: config.OPENAI_VISION_MODEL,
      store: false,
      input: [{ role: "user", content }],
      text: {
        format: zodTextFormat(recipeExtractionSchema, "recipe_extraction")
      }
    });

    if (!response.output_parsed) {
      throw new AppError(422, "RECIPE_NOT_READABLE", "No structured recipe could be extracted.");
    }

    return normalize(response.output_parsed);
  } catch (error) {
    if (error instanceof AppError) throw error;
    const status = typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : 0;
    if (status === 401 || status === 403) {
      throw new AppError(502, "OCR_CONFIGURATION_ERROR", "The recipe analysis service is not configured correctly.");
    }
    if (status === 429) {
      throw new AppError(429, "OCR_RATE_LIMITED", "Recipe analysis is temporarily rate limited. Try again shortly.");
    }
    throw new AppError(502, "OCR_SERVICE_UNAVAILABLE", "Recipe analysis is temporarily unavailable.");
  }
}
