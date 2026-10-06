import { Prisma, type PrismaClient } from "@prisma/client";
import type { ReceiptImportItem } from "./receipt-types.js";
import { canonicalProductName, cleanProductName, normalizedUnit } from "./product-identity.js";

type ImportResult = {
 created: number;
 updated: number;
 total: number;
 items: Array<{ id: string; name: string; action: "created" | "updated" }>;
};

function cleanName(value: string): string {
 return value.replace(/\s+/g, " ").trim();
}

function normalize(value: string): string {
 return cleanName(value).toLocaleLowerCase("en-US");
}

export async function importReceiptItems(
 db: PrismaClient,
 householdId: string,
 actorUserId: string,
 input: ReceiptImportItem[]
): Promise<ImportResult> {
 const consolidated = new Map<string, ReceiptImportItem>();
 for (const candidate of input) {
 const name = cleanName(candidate.name);
 const unit = cleanName(candidate.unit);
 const key = `${normalize(name)}|${normalizedUnit(unit)}`;
 const existing = consolidated.get(key);
 if (existing) consolidated.set(key, { ...existing, quantity: existing.quantity + candidate.quantity });
 else consolidated.set(key, { ...candidate, name, unit });
 }

 return db.$transaction(async tx => {
 const current = await tx.pantryItem.findMany({
 where: { householdId, archivedAt: null }
 });
 let created = 0;
 let updated = 0;
 const items: ImportResult["items"] = [];

 for (const candidate of consolidated.values()) {
 const candidateName = normalize(candidate.name);
 const candidateUnit = normalizedUnit(candidate.unit);
 const match = current.find(item =>
 canonicalProductName(item.name) === candidateName && normalizedUnit(item.unit) === candidateUnit
 );

 if (match) {
 const updatedItem = await tx.pantryItem.update({
 where: { id: match.id },
 data: {
 quantity: { increment: new Prisma.Decimal(candidate.quantity) },
 category: candidate.category ?? match.category,
 expirationDate: candidate.expirationDate
 ? new Date(`${candidate.expirationDate}T00:00:00.000Z`)
 : match.expirationDate,
 updatedByUserId: actorUserId,
 version: { increment: 1 }
 }
 });
 updated += 1;
 items.push({ id: updatedItem.id, name: updatedItem.name, action: "updated" });
 } else {
 const createdItem = await tx.pantryItem.create({
 data: {
 householdId,
 name: candidate.name,
 normalizedName: candidateName,
 quantity: new Prisma.Decimal(candidate.quantity),
 unit: candidate.unit,
 category: candidate.category ?? null,
 expirationDate: candidate.expirationDate
 ? new Date(`${candidate.expirationDate}T00:00:00.000Z`)
 : null,
 createdByUserId: actorUserId,
 updatedByUserId: actorUserId
 }
 });
 created += 1;
 current.push(createdItem);
 items.push({ id: createdItem.id, name: createdItem.name, action: "created" });
 }
 }

 return { created, updated, total: created + updated, items };
 });
}
