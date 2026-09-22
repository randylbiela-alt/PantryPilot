# PantryPilot API vertical slice

Runnable Fastify + TypeScript + Prisma API for the first production PantryPilot flow.

## Security note

`ALLOW_DEV_AUTH=true` and `Bearer dev-token` exist only for local development and integration tests. Production startup must set `ALLOW_DEV_AUTH=false` and use a real Microsoft Entra External ID issuer and API audience.

## Local startup

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run db:generate
npx prisma db push
npm run db:seed
npm run dev
```

Open:

- API: http://localhost:3001
- Swagger UI: http://localhost:3001/docs
- OpenAPI JSON: http://localhost:3001/openapi.json
- Readiness: http://localhost:3001/health/ready

Use the local development identity:

```bash
curl -H "Authorization: Bearer dev-token" http://localhost:3001/api/v1/bootstrap
```

## Tests and validation

```bash
npm run lint
npm test
npm run build
npm run openapi
npm run test:integration
```

Integration tests require a running Docker daemon because Testcontainers starts PostgreSQL automatically.

## Production migration workflow

The checked-in migration is intentionally a placeholder marker. Before first deployment, generate and review the full baseline:

```bash
rm -rf prisma/migrations
npx prisma migrate dev --name initial --create-only
# Review SQL, add database CHECK constraints, then apply:
npx prisma migrate dev
```

Commit the complete migration. In CI/CD and production, use only:

```bash
npx prisma migrate deploy
```

## Implemented endpoints

- `GET /api/v1/auth/session`
- `POST /api/v1/auth/sign-out`
- `GET /api/v1/bootstrap`
- `GET /api/v1/households/:householdId/pantry`
- `POST /api/v1/households/:householdId/pantry`
- `PATCH /api/v1/households/:householdId/pantry/:itemId`
- `DELETE /api/v1/households/:householdId/pantry/:itemId?version=N`
- `/health`, `/health/live`, `/health/ready`

Pantry writes atomically create business data, audit records, and outbox records. Updates and deletes require version numbers and return HTTP 409 on stale writes.
