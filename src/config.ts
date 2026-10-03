import { z } from "zod";

const optionalNonEmpty = z.string().trim().min(1).optional();
const optionalUrl = z.string().url().optional();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  COOKIE_SECRET: z.string().min(32),
  SESSION_PEPPER: z.string().min(32),
  SESSION_IDLE_TTL_SECONDS: z.coerce.number().int().min(60).default(1800),
  SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().min(300).default(28800),
  SESSION_ROTATION_SECONDS: z.coerce.number().int().min(60).default(900),
  CORS_ORIGIN: z.string().url(),
  ENTRA_TENANT_ID: z.string().min(1),
  ENTRA_API_CLIENT_ID: z.string().min(1),
  ENTRA_ISSUER: z.string().url(),
  ALLOW_DEV_AUTH: z.string().default("false").transform(value => value === "true"),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_VISION_MODEL: z.string().default("gpt-4.1-mini"),
  LOG_LEVEL: z.string().default("info"),
  FRONTEND_APP_URL: optionalUrl,
  AUTH_INVITE_ONLY: z.string().default("true").transform(value => value !== "false"),
  MICROSOFT_CLIENT_ID: optionalNonEmpty,
  MICROSOFT_CLIENT_SECRET: optionalNonEmpty,
  MICROSOFT_AUTHORITY: z.string().url().default("https://login.microsoftonline.com/common"),
  MICROSOFT_CALLBACK_URL: optionalUrl,
  GOOGLE_CLIENT_ID: optionalNonEmpty,
  GOOGLE_CLIENT_SECRET: optionalNonEmpty,
  GOOGLE_CALLBACK_URL: optionalUrl
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env = process.env): Config {
  return schema.parse(env);
}
