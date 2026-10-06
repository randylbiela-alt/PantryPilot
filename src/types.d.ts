import type { HouseholdRole, User } from "@prisma/client";

declare module "fastify" {
 interface FastifyRequest {
 authUser: User | undefined;
 correlationId: string;
 householdRole: HouseholdRole | undefined;
 }
}
