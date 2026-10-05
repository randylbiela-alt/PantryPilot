const packageSuffixes = [
  /\s+\d+(?:\.\d+)?\s*(?:count|ct)\.?$/i,
  /\s+(?:pack|box|bag|case)\s+of\s+\d+$/i,
  /\s+\d+\s*[- ]?(?:pack|pk)\.?$/i,
  /\s+\d+(?:\.\d+)?\s*(?:fl\s*)?(?:oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|kg|ml|l|liter|liters|gallon|gallons|gal)\.?$/i
];

export function cleanProductName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function canonicalProductName(value: string): string {
  let result = cleanProductName(value);
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of packageSuffixes) {
      const next = result.replace(pattern, "").trim();
      if (next !== result && next.length >= 2) {
        result = next;
        changed = true;
      }
    }
  }
  return result.toLocaleLowerCase("en-US");
}

export function normalizedUnit(value: string): string {
  return cleanProductName(value || "item").toLocaleLowerCase("en-US");
}
