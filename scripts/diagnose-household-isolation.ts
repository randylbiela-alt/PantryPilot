import { db } from "../src/db.js";

function maskEmail(email: string | null): string | null {
  if (!email) return null;

  const separator = email.indexOf("@");

  if (separator <= 1) {
    return "masked";
  }

  return email.slice(0, 1) + "***" + email.slice(separator);
}

async function main() {
  const users = await db.user.findMany({
    orderBy: {
      createdAt: "asc"
    },
    select: {
      id: true,
      primaryEmail: true,
      displayName: true,
      status: true,
      createdAt: true,
      lastLoginAt: true,
      identities: {
        select: {
          provider: true,
          issuer: true,
          providerSubject: true,
          emailAtProvider: true,
          linkedAt: true,
          lastUsedAt: true
        }
      },
      memberships: {
        select: {
          householdId: true,
          role: true,
          status: true,
          household: {
            select: {
              name: true,
              createdByUserId: true
            }
          }
        }
      }
    }
  });

  const safeUsers = users.map(user => ({
    id: user.id,
    primaryEmail: maskEmail(user.primaryEmail),
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    identities: user.identities.map(identity => ({
      provider: identity.provider,
      issuer: identity.issuer,
      providerSubjectSuffix: identity.providerSubject.slice(-8),
      emailAtProvider: maskEmail(identity.emailAtProvider),
      linkedAt: identity.linkedAt,
      lastUsedAt: identity.lastUsedAt
    })),
    memberships: user.memberships.map(membership => ({
      householdId: membership.householdId,
      householdName: membership.household.name,
      householdCreatedByUserId: membership.household.createdByUserId,
      role: membership.role,
      status: membership.status
    }))
  }));

  console.log(JSON.stringify(safeUsers, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
