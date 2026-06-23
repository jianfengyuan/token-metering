import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { z } from "zod";
import { createDatabase } from "../db/client.js";
import { AccessRepository } from "../repositories/accessRepository.js";

const providerConfigSchema = z.object({
  providerId: z.string().trim().min(1),
  providerType: z.enum(["openai_compatible", "mock_local"]),
  baseUrl: z.string().trim().min(1),
  apiKey: z.string().trim().min(1)
});

const modelRouteSchema = z.object({
  model: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  providerModel: z.string().trim().min(1)
});

const platformInitConfigSchema = z.object({
  providers: z.array(providerConfigSchema).min(1),
  modelRoutes: z.array(modelRouteSchema).min(1)
});

function resolveConfigPath(): string {
  const fromArgv = process.argv[2]?.trim();
  if (fromArgv) {
    return path.resolve(process.cwd(), fromArgv);
  }
  const fromEnv = process.env.PLATFORM_INIT_CONFIG?.trim();
  if (fromEnv) {
    return path.resolve(process.cwd(), fromEnv);
  }
  throw new Error("Missing init config path. Usage: npm run init:platform -- ./platform.init.json");
}

async function main(): Promise<void> {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(`Init config file not found: ${configPath}`);
  }

  const configRaw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  const config = platformInitConfigSchema.parse(configRaw);
  const configuredProviderIds = new Set(config.providers.map((provider) => provider.providerId));
  for (const route of config.modelRoutes) {
    if (!configuredProviderIds.has(route.providerId)) {
      throw new Error(`Model route references unknown provider: ${route.model} -> ${route.providerId}`);
    }
  }

  const database = await createDatabase();
  const accessRepository = new AccessRepository(database);

  for (const provider of config.providers) {
    await accessRepository.upsertProviderConfig(provider);
  }
  for (const route of config.modelRoutes) {
    await accessRepository.upsertModelRoute(route);
  }

  console.log(
    JSON.stringify(
      {
        initialized: true,
        providers: config.providers.length,
        modelRoutes: config.modelRoutes.length,
        configPath
      },
      null,
      2
    )
  );
}

await main();
