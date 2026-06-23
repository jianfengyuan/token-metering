import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AccessRepository } from "../repositories/accessRepository.js";
import { DEFAULT_TENANT_ID } from "../repositories/accessRepository.js";
import type { AuditRepository } from "../repositories/auditRepository.js";
import type { UsageRepository } from "../repositories/usageRepository.js";
import type { ProviderGateway } from "../providers/gateway.js";
import { logger } from "../utils/logger.js";

export const FALLBACK_ADMIN_TOKEN = "tm_admin_dev_token";

export interface AdminRouterDeps {
  accessRepository: AccessRepository;
  auditRepository: AuditRepository;
  usageRepository: UsageRepository;
  providerGateway: ProviderGateway;
  adminToken: string;
}

const createTenantSchema = z.object({
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  tenantName: z.string().min(1).optional(),
  projectName: z.string().min(1).optional(),
  apiKey: z.string().min(8).optional(),
  scope: z.string().min(1).optional(),
  tokenLimit: z.number().int().positive().optional(),
  costLimit: z.number().positive().optional()
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const usageQuerySchema = z.object({
  tenantId: z.string().min(1).default(DEFAULT_TENANT_ID),
  projectId: z.string().min(1).optional()
});

const createModelRouteSchema = z.object({
  model: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  providerModel: z.string().trim().min(1)
});

const upsertProviderConfigSchema = z.object({
  providerId: z.string().trim().min(1),
  providerType: z.enum(["openai_compatible", "mock_local"]).default("openai_compatible"),
  baseUrl: z.string().trim().url(),
  apiKey: z.string().trim().min(1)
});

function maskSecret(raw: string): string {
  if (raw.length <= 8) {
    return "*".repeat(raw.length);
  }
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function parseAdminToken(req: Request): string | null {
  const headerToken = req.header("x-admin-token");
  if (headerToken && headerToken.trim().length > 0) {
    return headerToken.trim();
  }
  const authHeader = req.header("authorization");
  if (!authHeader) {
    return null;
  }
  const [scheme, token] = authHeader.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }
  return token.trim();
}

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();
  const reloadProviderGateway = async (): Promise<void> => {
    deps.providerGateway.setExternalProviders(await deps.accessRepository.listActiveProviderConfigs());
    deps.providerGateway.setModelRoutes(await deps.accessRepository.listActiveModelRoutes());
  };

  const requireAdminToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = parseAdminToken(req);
    if (token !== deps.adminToken) {
      const requestId = res.locals.requestId as string | undefined;
      await deps.auditRepository.save({
        eventType: "admin.auth.failed",
        outcome: "failure",
        requestId,
        method: req.method,
        path: req.originalUrl,
        errorCode: token ? "INVALID_ADMIN_TOKEN" : "MISSING_ADMIN_TOKEN",
        message: token ? "Invalid admin token" : "Missing admin token"
      });
      res.status(401).json({
        error: token ? "Invalid admin token" : "Missing admin token",
        code: token ? "INVALID_ADMIN_TOKEN" : "MISSING_ADMIN_TOKEN",
        requestId
      });
      return;
    }
    next();
  };

  router.use(requireAdminToken);

  router.post("/tenants", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }

    const result = await deps.accessRepository.createTenantProjectApiKey(parsed.data);
    await deps.auditRepository.save({
      eventType: "admin.tenant.created",
      outcome: "success",
      requestId,
      tenantId: result.tenantId,
      projectId: result.projectId,
      apiKeyId: result.apiKeyId,
      method: req.method,
      path: req.originalUrl,
      message: `Tenant ${result.tenantId} / project ${result.projectId} provisioned`
    });
    logger.info("admin.tenant.created", {
      requestId,
      tenantId: result.tenantId,
      projectId: result.projectId,
      apiKeyId: result.apiKeyId
    });

    res.status(201).json({
      requestId,
      tenantId: result.tenantId,
      projectId: result.projectId,
      apiKeyId: result.apiKeyId,
      apiKey: result.apiKey
    });
  });

  router.post("/model-routes", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const parsed = createModelRouteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }

    const payload = {
      model: parsed.data.model,
      providerId: parsed.data.providerId,
      providerModel: parsed.data.providerModel
    };
    if (!deps.providerGateway.hasProvider(payload.providerId)) {
      res.status(400).json({
        error: "Unsupported provider",
        code: "UNSUPPORTED_PROVIDER",
        requestId,
        supportedProviders: deps.providerGateway.listProviderIds()
      });
      return;
    }

    const route = await deps.accessRepository.upsertModelRoute(payload);
    deps.providerGateway.setModelRoutes(await deps.accessRepository.listActiveModelRoutes());

    await deps.auditRepository.save({
      eventType: "admin.model_route.upserted",
      outcome: "success",
      requestId,
      provider: route.providerId,
      model: route.model,
      method: req.method,
      path: req.originalUrl,
      message: `Model route upserted: ${route.model} -> ${route.providerId}/${route.providerModel}`
    });
    logger.info("admin.model_route.upserted", {
      requestId,
      model: route.model,
      provider: route.providerId,
      providerModel: route.providerModel
    });

    res.status(201).json({
      requestId,
      modelRoute: route
    });
  });

  router.get("/model-routes", async (_req, res) => {
    res.json({ modelRoutes: await deps.accessRepository.listActiveModelRoutes() });
  });

  router.post("/providers", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const parsed = upsertProviderConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }

    const config = await deps.accessRepository.upsertProviderConfig(parsed.data);
    await reloadProviderGateway();
    await deps.auditRepository.save({
      eventType: "admin.provider.upserted",
      outcome: "success",
      requestId,
      provider: config.providerId,
      method: req.method,
      path: req.originalUrl,
      message: `Provider upserted: ${config.providerId} (${config.providerType})`
    });
    logger.info("admin.provider.upserted", {
      requestId,
      provider: config.providerId,
      providerType: config.providerType,
      baseUrl: config.baseUrl
    });

    res.status(201).json({
      requestId,
      provider: {
        providerId: config.providerId,
        providerType: config.providerType,
        baseUrl: config.baseUrl,
        apiKeyMasked: maskSecret(config.apiKey)
      }
    });
  });

  router.get("/providers", async (_req, res) => {
    const providers = await deps.accessRepository.listActiveProviderConfigs();
    res.json({
      providers: providers.map((provider) => ({
        providerId: provider.providerId,
        providerType: provider.providerType,
        baseUrl: provider.baseUrl,
        apiKeyMasked: maskSecret(provider.apiKey)
      }))
    });
  });

  router.get("/audit-events", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }
    res.json({ events: await deps.auditRepository.listRecent(parsed.data.limit) });
  });

  router.get("/usage", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const parsed = usageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }

    const query = {
      tenantId: parsed.data.tenantId,
      projectId: parsed.data.projectId
    };
    res.json({
      summary: await deps.usageRepository.summary(query),
      records: (await deps.usageRepository.list(query)).slice(0, 50)
    });
  });

  return router;
}
