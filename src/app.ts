import path from "node:path";
import express from "express";
import { createDatabase } from "./db/client.js";
import type { DatabaseClient } from "./db/types.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createHttpMetricsMiddleware } from "./middleware/httpMetrics.js";
import { createRequestContextMiddleware } from "./middleware/requestContext.js";
import { MeteringService } from "./metering/service.js";
import { metrics } from "./observability/metrics.js";
import { ProviderGateway } from "./providers/gateway.js";
import { AccessRepository } from "./repositories/accessRepository.js";
import { AuditRepository } from "./repositories/auditRepository.js";
import { QuotaRepository } from "./repositories/quotaRepository.js";
import { UsageRepository } from "./repositories/usageRepository.js";
import { FALLBACK_ADMIN_TOKEN, createAdminRouter } from "./routes/admin.js";
import { createChatRouter } from "./routes/chat.js";
import { createSimulatorRouter } from "./routes/simulator.js";
import { createUsageRouter } from "./routes/usage.js";
import { logger } from "./utils/logger.js";

export interface CreateAppOptions {
  database?: DatabaseClient;
  allowLegacyAuth?: boolean;
  adminToken?: string;
}

export async function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const port = process.env.PORT ?? "3000";
  const simulatorBaseUrl = process.env.LOCAL_SIMULATOR_BASE_URL ?? `http://127.0.0.1:${port}/simulator/v1`;
  const database = options.database ?? (await createDatabase());
  const accessRepository = new AccessRepository(database);
  const modelRoutes = await accessRepository.listActiveModelRoutes();
  const meteringService = new MeteringService(Number(process.env.QUOTA_RESERVED_COMPLETION_TOKENS ?? "256"));
  const quotaRepository = new QuotaRepository(database);
  const usageRepository = new UsageRepository(database);
  const auditRepository = new AuditRepository(database);
  const providerGateway = new ProviderGateway({
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    ollamaApiKey: process.env.OLLAMA_API_KEY,
    simulatorBaseUrl,
    simulatorApiKey: process.env.LOCAL_SIMULATOR_API_KEY,
    modelRoutes
  });
  const allowLegacyAuth = options.allowLegacyAuth ?? process.env.ALLOW_LEGACY_AUTH !== "false";
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? FALLBACK_ADMIN_TOKEN;

  app.use(createRequestContextMiddleware());
  app.use(express.json());
  app.use(createHttpMetricsMiddleware());

  app.use("/simulator/v1", createSimulatorRouter());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/models", async (_req, res) => {
    const routes = await accessRepository.listActiveModelRoutes();
    res.json({
      models: routes.map((route) => route.model)
    });
  });
  app.use("/console", express.static(path.resolve(process.cwd(), "public", "console")));
  app.get("/metrics", (_req, res) => {
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(metrics.renderPrometheus());
  });

  app.use(
    "/chat",
    createAuthMiddleware(accessRepository, {
      allowLegacy: allowLegacyAuth,
      requiredScope: "chat.write",
      auditRepository
    }),
    createChatRouter({
      meteringService,
      providerGateway,
      quotaRepository,
      usageRepository,
      auditRepository
    })
  );
  app.use(
    "/usage",
    createAuthMiddleware(accessRepository, {
      allowLegacy: allowLegacyAuth,
      requiredScope: "usage.read",
      auditRepository
    }),
    createUsageRouter(usageRepository)
  );
  app.use(
    "/admin/v1",
    createAdminRouter({
      accessRepository,
      auditRepository,
      usageRepository,
      adminToken
    })
  );

  logger.info("app.initialized", {
    port: Number(port),
    databaseDriver: database.dialect,
    hasOllamaBaseUrl: Boolean(process.env.OLLAMA_BASE_URL),
    simulatorBaseUrl,
    allowLegacyAuth
  });

  return app;
}
