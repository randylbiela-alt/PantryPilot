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

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const descriptiveSuffix = (value: string) => normalize(value).split(",")[0]!.trim();

const canonicalNames = new Map<string, string>([
  ["sweet paprika", "paprika"],
  ["smoked paprika", "paprika"],
  ["hungarian paprika", "paprika"],
  ["fresh thyme", "thyme"],
  ["dried thyme", "thyme"],
  ["kosher salt", "salt"],
  ["sea salt", "salt"],
  ["table salt", "salt"],
  ["ground black pepper", "black pepper"],
  ["freshly ground black pepper", "black pepper"],
  ["garlic cloves", "garlic"],
  ["fresh garlic", "garlic"],
  ["yellow onion", "onion"],
  ["white onion", "onion"]
]);

const presenceOnlyNames = new Set([
  "allspice", "basil", "bay leaves", "black pepper", "cayenne pepper", "chili powder",
  "cinnamon", "cloves", "coriander", "cumin", "curry powder", "dill", "garlic powder",
  "ginger", "italian seasoning", "nutmeg", "onion powder", "oregano", "paprika", "parsley",
  "red pepper flakes", "rosemary", "sage", "seasoning salt", "thyme", "turmeric",
  "all purpose flour", "baking powder", "baking soda", "bread crumbs", "breadcrumbs",
  "brown sugar", "cornmeal", "cornstarch", "flour", "granulated sugar", "oats",
  "olive oil", "powdered sugar", "rolled oats", "salt", "sugar", "vegetable oil", "yeast"
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
  const base = descriptiveSuffix(value)
    .replace(" uncooked", "")
    .replace(" raw", "")
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
