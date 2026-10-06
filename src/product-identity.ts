const packageSuffixes = [
 /\b\d+(?:\.\d+)?\s*(?:count|ct)\b/gi,
 /\b\d+\s*(?:pack|pk)\b/gi,
 /\b(?:pack|box|bag|case)\s+of\s+\d+\b/gi,
 /\b\d+(?:\.\d+)?\s*(?:fl\s*)?(?:oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|kg|ml|l|liter|liters|gallon|gallons|gal)\b/gi
];

export function cleanProductName(value: string): string {
 return value
 .replace(/[Â | | ]/g, " ")
 .replace(/[()[\]_]/g, " ")
 .replace(/\s+/g, " ")
 .trim();
}

export function canonicalProductName(value: string): string {
 let result = cleanProductName(value);

 for (const pattern of packageSuffixes) {
 result = result.replace(pattern, " ");
 }

 result = result
 .replace(/\s+/g, " ")
 .trim();

 return result.toLocaleLowerCase("en-US");
}

export function normalizedUnit(value: string): string {
 return cleanProductName(value || "item")
 .toLocaleLowerCase("en-US");
}