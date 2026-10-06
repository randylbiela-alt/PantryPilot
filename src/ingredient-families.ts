import { Prisma } from "@prisma/client";

export type IngredientSubstitution = {
  requestedName: string;
  pantryName: string;
  family: string;
};

type PantryValue = {
  name: string;
  normalizedName: string;
  quantity: Prisma.Decimal;
  unit: string;
  category?: string | null;
};

const normalize = (value: string) => value
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[‐‑‒–—]/g, "-")
  .replace(/[’‘]/g, "'")
  .replace(/\s+/g, " ")
  .trim();

const leadingPreparation = /^(?:finely|roughly|coarsely|thinly|thickly|freshly)\s+(?:chopped|diced|minced|sliced|grated|shredded|crushed|ground|torn)\s+/;
const trailingPreparation = /\s+(?:finely|roughly|coarsely|thinly|thickly|freshly)?\s*(?:chopped|diced|minced|sliced|grated|shredded|crushed|ground|torn|julienned|peeled|seeded|cored|trimmed|softened|melted|drained|rinsed|divided|beaten|whisked|cubed|halved|quartered)$/;
const trailingRecipeNote = /\s+(?:to taste|as needed|for serving|for garnish|plus more|optional)$/;

export function cleanIngredientName(value: string) {
  let cleaned = normalize(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .split(/[;,]/)[0]!
    .replace(/\s+/g, " ")
    .trim();

  let previous = "";
  while (cleaned !== previous) {
    previous = cleaned;
    cleaned = cleaned
      .replace(leadingPreparation, "")
      .replace(trailingPreparation, "")
      .replace(trailingRecipeNote, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return cleaned;
}

const canonicalNames = new Map<string, string>([
  ["sweet paprika", "paprika"], ["smoked paprika", "paprika"], ["hungarian paprika", "paprika"],
  ["fresh thyme", "thyme"], ["dried thyme", "thyme"],
  ["kosher salt", "salt"], ["sea salt", "salt"], ["table salt", "salt"],
  ["ground black pepper", "black pepper"], ["freshly ground black pepper", "black pepper"],
  ["garlic clove", "garlic"], ["garlic cloves", "garlic"], ["fresh garlic", "garlic"], ["whole garlic", "garlic"],
  ["yellow onion", "onion"], ["white onion", "onion"], ["onions", "onion"],
  ["green onion", "green onions"], ["scallion", "green onions"], ["scallions", "green onions"], ["spring onion", "green onions"], ["spring onions", "green onions"],
  ["bell peppers", "bell pepper"], ["carrots", "carrot"], ["celery stalk", "celery"], ["celery stalks", "celery"],
  ["tomatoes", "tomato"], ["potatoes", "potato"], ["mushrooms", "mushroom"],
  ["eggs", "egg"], ["lemons", "lemon"], ["limes", "lime"],
  ["bay leaf", "bay leaves"], ["chilli powder", "chili powder"], ["cayenne", "cayenne pepper"],
  ["all-purpose flour", "all purpose flour"], ["plain flour", "all purpose flour"],
  ["confectioners sugar", "powdered sugar"], ["confectioner's sugar", "powdered sugar"], ["icing sugar", "powdered sugar"],
  ["caster sugar", "granulated sugar"], ["bread crumb", "breadcrumbs"], ["bread crumbs", "breadcrumbs"]
]);

const presenceOnlyNames = new Set([
  "allspice", "basil", "bay leaves", "black pepper", "cayenne pepper", "cayenne powder", "chili powder",
  "cinnamon", "cloves", "coriander", "cumin", "curry powder", "dill", "garlic powder",
  "ginger", "italian seasoning", "nutmeg", "onion powder", "oregano", "paprika", "parsley",
  "red pepper flakes", "rosemary", "sage", "seasoning salt", "thyme", "turmeric",
  "all purpose flour", "baking powder", "baking soda", "breadcrumbs", "brown sugar", "cornmeal",
  "cornstarch", "flour", "granulated sugar", "oats", "olive oil", "powdered sugar", "rolled oats",
  "salt", "sugar", "vegetable oil", "yeast",
  "garlic", "onion", "green onions", "shallot", "ginger", "lemon", "lime",
  "butter", "soy sauce", "worcestershire sauce", "hot sauce", "vinegar",
  "apple cider vinegar", "balsamic vinegar", "red wine vinegar", "white vinegar", "rice vinegar"
]);

const families: Array<{ name: string; members: string[] }> = [
  { name: "long-grain rice", members: ["long grain rice", "jasmine rice", "basmati rice", "white rice"] },
  { name: "short-grain rice", members: ["short grain rice", "sushi rice", "calrose rice"] },
  { name: "risotto rice", members: ["arborio rice", "carnaroli rice", "vialone nano rice"] },
  { name: "tube pasta", members: ["rigatoni", "penne", "ziti", "mostaccioli"] },
  { name: "long pasta", members: ["spaghetti", "linguine", "fettuccine", "bucatini", "angel hair"] },
  { name: "small pasta", members: ["pastina", "orzo", "ditalini", "acini di pepe"] },
  { name: "chicken cuts", members: ["chicken breast", "chicken thigh", "boneless chicken breast", "boneless chicken thigh"] },
  { name: "broth", members: ["chicken broth", "chicken stock", "vegetable broth", "vegetable stock", "beef broth", "beef stock"] }
];

export function canonicalIngredientName(value: string) {
  const base = cleanIngredientName(value)
    .replace(/\s+(?:uncooked|raw)$/g, "")
    .trim();
  return canonicalNames.get(base) ?? base;
}

export function usesPresenceOnly(value: string, category?: string | null) {
  const normalizedCategory = normalize(category ?? "");
  return normalizedCategory === "seasoning" || normalizedCategory === "pantry staple" || presenceOnlyNames.has(canonicalIngredientName(value));
}

function familyFor(value: string) {
  const canonical = canonicalIngredientName(value);
  return families.find(family => family.members.includes(canonical));
}

export function findSubstitution(requestedName: string, pantryItems: PantryValue[]): IngredientSubstitution | null {
  const requestedFamily = familyFor(requestedName);
  if (!requestedFamily) return null;
  const requestedCanonical = canonicalIngredientName(requestedName);
  const pantryItem = pantryItems.find(item => {
    const candidate = canonicalIngredientName(item.normalizedName || item.name);
    return candidate !== requestedCanonical && requestedFamily.members.includes(candidate) && new Prisma.Decimal(item.quantity).greaterThan(0);
  });
  return pantryItem ? { requestedName, pantryName: pantryItem.name, family: requestedFamily.name } : null;
}

export function pantryPresence(pantryItems: PantryValue[], ingredientName: string) {
  const canonical = canonicalIngredientName(ingredientName);
  return pantryItems.some(item => canonicalIngredientName(item.normalizedName || item.name) === canonical && new Prisma.Decimal(item.quantity).greaterThan(0));
}
