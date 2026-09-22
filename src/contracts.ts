import { z } from "zod";

export const householdParams = z.object({
  householdId: z.string().uuid()
});

export const itemParams = householdParams.extend({
  itemId: z.string().uuid()
});

export const listParams = householdParams.extend({
  listId: z.string().uuid()
});

export const groceryItemParams = listParams.extend({
  itemId: z.string().uuid()
});

export const createPantry = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.number().finite().min(0),
  unit: z.string().trim().min(1).max(30),
  category: z.string().trim().max(60).nullable().optional(),
  expirationDate: z.iso.date().nullable().optional()
}).strict();

export const updatePantry = createPantry.partial().extend({
  version: z.number().int().min(1)
}).strict();

export const createGroceryList = z.object({
  name: z.string().trim().min(1).max(120)
}).strict();

export const updateGroceryList = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED"]).optional(),
  version: z.number().int().min(1)
}).strict().refine(value => value.name !== undefined || value.status !== undefined, {
  message: "At least one editable field is required."
});

export const createGroceryItem = z.object({
  name: z.string().trim().min(1).max(120)
}).strict();

export const updateGroceryItem = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  checked: z.boolean().optional(),
  version: z.number().int().min(1)
}).strict().refine(value => value.name !== undefined || value.checked !== undefined, {
  message: "At least one editable field is required."
});
