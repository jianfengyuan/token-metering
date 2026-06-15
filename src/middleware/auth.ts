import type { NextFunction, Request, Response } from "express";
import { setRequestContextFields } from "../observability/requestContext.js";
import type { AccessRepository, AuthContext } from "../repositories/accessRepository.js";
import type { AuditRepository } from "../repositories/auditRepository.js";
import { logger } from "../utils/logger.js";

export interface AuthMiddlewareOptions {
  allowLegacy?: boolean;
  requiredScope: "chat.write" | "usage.read";
  auditRepository?: AuditRepository;
}

function parseBearerToken(authHeader?: string): string | null {
  if (!authHeader) {
    return null;
  }
  const [scheme, token] = authHeader.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }
  return token.trim();
}

function resolveLegacyUserId(req: Request): string | undefined {
  if (typeof req.body?.userId === "string") {
    return req.body.userId;
  }
  if (typeof req.query?.userId === "string") {
    return req.query.userId;
  }
  if (typeof req.header("x-user-id") === "string") {
    return req.header("x-user-id");
  }
  return undefined;
}

function hasScope(context: AuthContext, requiredScope: string): boolean {
  return context.scopes.includes("*") || context.scopes.includes(requiredScope);
}

async function respondUnauthorized(
  req: Request,
  res: Response,
  options: AuthMiddlewareOptions,
  code: string,
  message: string,
  authContext?: Partial<AuthContext>
): Promise<void> {
  const requestId = res.locals.requestId as string | undefined;
  if (options.auditRepository) {
    await options.auditRepository.save({
      eventType: "auth.failed",
      outcome: "failure",
      requestId,
      tenantId: authContext?.tenantId,
      projectId: authContext?.projectId,
      apiKeyId: authContext?.apiKeyId,
      method: req.method,
      path: req.originalUrl,
      errorCode: code,
      message
    });
  }
  logger.warn("auth.request.rejected", {
    code,
    reason: message
  });
  res.status(401).json({
    error: message,
    code,
    requestId
  });
}

export function createAuthMiddleware(
  accessRepository: AccessRepository,
  options: AuthMiddlewareOptions
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const allowLegacy = options.allowLegacy ?? true;

  return async (req: Request, res: Response, next: NextFunction) => {
    const bearerToken = parseBearerToken(req.header("authorization"));

    if (bearerToken) {
      const identity = await accessRepository.resolveApiKey(bearerToken);
      if (!identity) {
        await respondUnauthorized(req, res, options, "INVALID_API_KEY", "Invalid API key");
        return;
      }

      const userIdHeader = req.header("x-user-id");
      const userId =
        userIdHeader && userIdHeader.trim().length > 0
          ? userIdHeader.trim()
          : `api-key:${identity.apiKeyId}`;
      const authContext: AuthContext = {
        tenantId: identity.tenantId,
        projectId: identity.projectId,
        apiKeyId: identity.apiKeyId,
        userId,
        scopes: identity.scopes,
        authType: "api_key"
      };

      if (!hasScope(authContext, options.requiredScope)) {
        await respondUnauthorized(req, res, options, "INSUFFICIENT_SCOPE", "API key scope is not allowed", authContext);
        return;
      }

      res.locals.authContext = authContext;
      setRequestContextFields({
        tenantId: authContext.tenantId,
        projectId: authContext.projectId,
        apiKeyId: authContext.apiKeyId,
        userId: authContext.userId
      });
      next();
      return;
    }

    if (!allowLegacy) {
      await respondUnauthorized(req, res, options, "MISSING_API_KEY", "Missing API key");
      return;
    }

    const legacyContext = accessRepository.getLegacyContext(resolveLegacyUserId(req));
    if (!hasScope(legacyContext, options.requiredScope)) {
      await respondUnauthorized(req, res, options, "INSUFFICIENT_SCOPE", "Legacy auth scope is not allowed", legacyContext);
      return;
    }
    res.locals.authContext = legacyContext;
    setRequestContextFields({
      tenantId: legacyContext.tenantId,
      projectId: legacyContext.projectId,
      apiKeyId: legacyContext.apiKeyId,
      userId: legacyContext.userId
    });
    next();
  };
}
