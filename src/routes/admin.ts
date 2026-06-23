import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AccessRepository } from "../repositories/accessRepository.js";
import { ConflictError, NotFoundError } from "../repositories/accessRepository.js";
import { ConflictError as UserConflictError, NotFoundError as UserNotFoundError } from "../repositories/userRepository.js";
import { DEFAULT_TENANT_ID } from "../repositories/accessRepository.js";
import type { AuditRepository } from "../repositories/auditRepository.js";
import type { UsageRepository } from "../repositories/usageRepository.js";
import type { UserRepository } from "../repositories/userRepository.js";
import type { ProviderGateway } from "../providers/gateway.js";
import { logger } from "../utils/logger.js";

export const FALLBACK_ADMIN_TOKEN = "tm_admin_dev_token";

export interface AdminRouterDeps {
  accessRepository: AccessRepository;
  userRepository: UserRepository;
  auditRepository: AuditRepository;
  usageRepository: UsageRepository;
  providerGateway: ProviderGateway;
  adminToken: string;
}

const createTenantSchema = z.object({
  tenantId: z.string().min(1),
  tenantName: z.string().min(1).optional()
});

const provisionSchema = z.object({
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  tenantName: z.string().min(1).optional(),
  projectName: z.string().min(1).optional(),
  apiKey: z.string().min(8).optional(),
  scope: z.string().min(1).optional(),
  tokenLimit: z.number().int().positive().optional(),
  costLimit: z.number().positive().optional(),
  createdBy: z.string().min(1).optional()
});

const createProjectSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  tokenLimit: z.number().int().positive().optional(),
  costLimit: z.number().positive().optional(),
  createdBy: z.string().min(1).optional()
});

const createApiKeySchema = z.object({
  scope: z.string().min(1).optional(),
  createdBy: z.string().min(1).optional()
});

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  platformRole: z.enum(["platform_admin"]).nullable().optional()
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  platformRole: z.enum(["platform_admin"]).nullable().optional(),
  status: z.enum(["active", "disabled"]).optional()
});

const addMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["owner", "admin", "member"]).default("member")
});

const updateMemberSchema = z.object({
  role: z.enum(["owner", "admin", "member"])
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

function handleRepoError(res: Response, error: unknown, requestId?: string): boolean {
  if (
    error instanceof ConflictError ||
    error instanceof UserConflictError ||
    (error instanceof Error && error.name === "ConflictError")
  ) {
    res.status(409).json({
      error: error instanceof Error ? error.message : "Conflict",
      code: "CONFLICT",
      requestId
    });
    return true;
  }
  if (
    error instanceof NotFoundError ||
    error instanceof UserNotFoundError ||
    (error instanceof Error && error.name === "NotFoundError")
  ) {
    res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
      code: "NOT_FOUND",
      requestId
    });
    return true;
  }
  return false;
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

  router.get("/tenants", async (_req, res) => {
    res.json({ tenants: await deps.accessRepository.listTenants() });
  });

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

    try {
      const tenant = await deps.accessRepository.createTenant(parsed.data);
      await deps.auditRepository.save({
        eventType: "admin.tenant.created",
        outcome: "success",
        requestId,
        tenantId: tenant.id,
        method: req.method,
        path: req.originalUrl,
        message: `Tenant ${tenant.id} created`
      });
      res.status(201).json({ requestId, tenant });
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
  });

  router.post("/tenants/provision", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const parsed = provisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }

    try {
      const result = await deps.accessRepository.createTenantProjectApiKey(parsed.data);
      await deps.auditRepository.save({
        eventType: "admin.tenant.provisioned",
        outcome: "success",
        requestId,
        tenantId: result.tenantId,
        projectId: result.projectId,
        apiKeyId: result.apiKeyId,
        method: req.method,
        path: req.originalUrl,
        message: `Tenant ${result.tenantId} / project ${result.projectId} provisioned`
      });
      logger.info("admin.tenant.provisioned", {
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
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
  });

  router.get("/tenants/:tenantId/projects", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    try {
      const projects = await deps.accessRepository.listProjects(req.params.tenantId);
      res.json({ projects });
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
  });

  router.post("/tenants/:tenantId/projects", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }

    try {
      const result = await deps.accessRepository.createProject({
        tenantId: req.params.tenantId,
        ...parsed.data
      });
      await deps.auditRepository.save({
        eventType: "admin.project.created",
        outcome: "success",
        requestId,
        tenantId: result.tenantId,
        projectId: result.projectId,
        apiKeyId: result.apiKeyId,
        method: req.method,
        path: req.originalUrl,
        message: `Project ${result.projectId} created with initial API key`
      });
      res.status(201).json({
        requestId,
        tenantId: result.tenantId,
        projectId: result.projectId,
        apiKeyId: result.apiKeyId,
        apiKey: result.apiKey
      });
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
  });

  router.get("/projects/:projectId/api-keys", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    try {
      const apiKeys = await deps.accessRepository.listApiKeys(req.params.projectId);
      res.json({ apiKeys });
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
  });

  router.post("/projects/:projectId/api-keys", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const parsed = createApiKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }

    try {
      const result = await deps.accessRepository.createApiKey({
        projectId: req.params.projectId,
        ...parsed.data
      });
      await deps.auditRepository.save({
        eventType: "admin.api_key.created",
        outcome: "success",
        requestId,
        projectId: result.projectId,
        apiKeyId: result.apiKeyId,
        method: req.method,
        path: req.originalUrl,
        message: `API key ${result.apiKeyId} created for project ${result.projectId}`
      });
      res.status(201).json({
        requestId,
        projectId: result.projectId,
        apiKeyId: result.apiKeyId,
        apiKey: result.apiKey
      });
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
  });

  router.post("/api-keys/:apiKeyId/revoke", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    try {
      const apiKey = await deps.accessRepository.revokeApiKey(req.params.apiKeyId);
      await deps.auditRepository.save({
        eventType: "admin.api_key.revoked",
        outcome: "success",
        requestId,
        projectId: apiKey.projectId,
        apiKeyId: apiKey.id,
        method: req.method,
        path: req.originalUrl,
        message: `API key ${apiKey.id} revoked`
      });
      res.json({ requestId, apiKey });
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
  });

  router.post("/api-keys/:apiKeyId/rotate", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const createdBy =
      typeof req.body?.createdBy === "string" && req.body.createdBy.trim().length > 0
        ? req.body.createdBy.trim()
        : undefined;

    try {
      const result = await deps.accessRepository.rotateApiKey(req.params.apiKeyId, createdBy);
      await deps.auditRepository.save({
        eventType: "admin.api_key.rotated",
        outcome: "success",
        requestId,
        projectId: result.projectId,
        apiKeyId: result.apiKeyId,
        method: req.method,
        path: req.originalUrl,
        message: `API key rotated: new ${result.apiKeyId}`
      });
      res.status(201).json({
        requestId,
        projectId: result.projectId,
        apiKeyId: result.apiKeyId,
        apiKey: result.apiKey
      });
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
  });

  router.get("/users", async (_req, res) => {
    res.json({ users: await deps.userRepository.listUsers() });
  });

  router.post("/users", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }

    try {
      const user = await deps.userRepository.createUser(parsed.data);
      await deps.auditRepository.save({
        eventType: "admin.user.created",
        outcome: "success",
        requestId,
        method: req.method,
        path: req.originalUrl,
        message: `User ${user.id} created`
      });
      res.status(201).json({ requestId, user });
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
  });

  router.get("/users/:userId", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const user = await deps.userRepository.getUser(req.params.userId);
    if (!user) {
      res.status(404).json({
        error: `User ${req.params.userId} not found`,
        code: "NOT_FOUND",
        requestId
      });
      return;
    }
    res.json({ user });
  });

  router.patch("/users/:userId", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }

    try {
      const user = await deps.userRepository.updateUser(req.params.userId, parsed.data);
      await deps.auditRepository.save({
        eventType: "admin.user.updated",
        outcome: "success",
        requestId,
        method: req.method,
        path: req.originalUrl,
        message: `User ${user.id} updated`
      });
      res.json({ requestId, user });
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
  });

  router.get("/tenants/:tenantId/members", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    try {
      const members = await deps.userRepository.listTenantMembers(req.params.tenantId);
      res.json({ members });
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
  });

  router.post("/tenants/:tenantId/members", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const parsed = addMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }

    try {
      const member = await deps.userRepository.addTenantMember(
        req.params.tenantId,
        parsed.data.userId,
        parsed.data.role
      );
      await deps.auditRepository.save({
        eventType: "admin.member.added",
        outcome: "success",
        requestId,
        tenantId: member.tenantId,
        method: req.method,
        path: req.originalUrl,
        message: `User ${member.userId} added to tenant ${member.tenantId}`
      });
      res.status(201).json({ requestId, member });
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
  });

  router.patch("/tenants/:tenantId/members/:userId", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const parsed = updateMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }

    try {
      const member = await deps.userRepository.updateTenantMemberRole(
        req.params.tenantId,
        req.params.userId,
        parsed.data.role
      );
      await deps.auditRepository.save({
        eventType: "admin.member.updated",
        outcome: "success",
        requestId,
        tenantId: member.tenantId,
        method: req.method,
        path: req.originalUrl,
        message: `Member ${member.userId} role updated in tenant ${member.tenantId}`
      });
      res.json({ requestId, member });
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
  });

  router.delete("/tenants/:tenantId/members/:userId", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    try {
      await deps.userRepository.removeTenantMember(req.params.tenantId, req.params.userId);
      await deps.auditRepository.save({
        eventType: "admin.member.removed",
        outcome: "success",
        requestId,
        tenantId: req.params.tenantId,
        method: req.method,
        path: req.originalUrl,
        message: `Member ${req.params.userId} removed from tenant ${req.params.tenantId}`
      });
      res.status(204).send();
    } catch (error) {
      if (handleRepoError(res, error, requestId)) {
        return;
      }
      throw error;
    }
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
