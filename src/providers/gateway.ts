import { MockLocalProvider } from "./mockLocal.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import type {
  ModelProvider,
  ProviderGenerateParams,
  ProviderGenerateResult,
  ProviderStreamResult
} from "./base.js";
import { metrics } from "../observability/metrics.js";
import { logger } from "../utils/logger.js";

export interface ProviderModelRoute {
  model: string;
  providerId: string;
  providerModel: string;
  fallbackProviderId?: string;
  fallbackProviderModel?: string;
}

interface ProviderCandidate {
  providerId: string;
  providerModel: string;
}

export interface ResolvedModelRoute {
  requestedModel: string;
  providerId: string;
  providerModel: string;
  source: "model_route" | "legacy_provider";
  fallback?: ProviderCandidate;
}

export interface ResilientProviderResult<T> {
  providerId: string;
  providerModel: string;
  attempts: number;
  retries: number;
  failoverUsed: boolean;
  result: T;
}

export interface ProviderGatewayOptions {
  ollamaBaseUrl?: string;
  ollamaApiKey?: string;
  simulatorBaseUrl?: string;
  simulatorApiKey?: string;
  modelRoutes?: ProviderModelRoute[];
  providers?: ModelProvider[];
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
}

export class ModelRouteNotFoundError extends Error {
  readonly code = "MODEL_ROUTE_NOT_FOUND";

  constructor(model: string) {
    super(`No provider route configured for model: ${model}`);
    this.name = "ModelRouteNotFoundError";
  }
}

export class ProviderGateway {
  private readonly providers: Map<string, ModelProvider>;
  private readonly modelRoutes: Map<string, ProviderModelRoute>;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;

  constructor(options: ProviderGatewayOptions = {}) {
    const ollamaBaseUrl = options.ollamaBaseUrl ?? "http://127.0.0.1:11434/v1";
    const ollamaApiKey = options.ollamaApiKey ?? "local-dev";
    const simulatorBaseUrl = options.simulatorBaseUrl ?? "http://127.0.0.1:3000/simulator/v1";
    const simulatorApiKey = options.simulatorApiKey ?? "local-dev";
    this.requestTimeoutMs = options.requestTimeoutMs ?? Number(process.env.PROVIDER_TIMEOUT_MS ?? "15000");
    this.maxRetries = options.maxRetries ?? Number(process.env.PROVIDER_RETRY_MAX ?? "1");
    this.retryBackoffMs = options.retryBackoffMs ?? Number(process.env.PROVIDER_RETRY_BACKOFF_MS ?? "150");

    const providerEntries: Array<[string, ModelProvider]> = [
      [
        "local-ollama",
        new OpenAICompatibleProvider({
          id: "local-ollama",
          baseUrl: ollamaBaseUrl,
          apiKey: ollamaApiKey
        })
      ],
      [
        "local-simulator",
        new OpenAICompatibleProvider({
          id: "local-simulator",
          baseUrl: simulatorBaseUrl,
          apiKey: simulatorApiKey
        })
      ],
      ["local-mock", new MockLocalProvider()]
    ];
    for (const provider of options.providers ?? []) {
      providerEntries.push([provider.id, provider]);
    }
    this.providers = new Map<string, ModelProvider>(providerEntries);

    this.modelRoutes = new Map<string, ProviderModelRoute>();
    this.setModelRoutes(
      options.modelRoutes ?? [
        {
          model: "sim-local",
          providerId: "local-simulator",
          providerModel: "sim-local",
          fallbackProviderId: "local-mock",
          fallbackProviderModel: "sim-local"
        },
        {
          model: "llama3.2",
          providerId: "local-ollama",
          providerModel: "gemma4:e2b",
          fallbackProviderId: "local-simulator",
          fallbackProviderModel: "sim-local"
        },
        {
          model: "gpt-4o-mini",
          providerId: "local-simulator",
          providerModel: "sim-local",
          fallbackProviderId: "local-mock",
          fallbackProviderModel: "sim-local"
        },
        {
          model: "mock-default",
          providerId: "local-mock",
          providerModel: "sim-local"
        }
      ]
    );
  }

  setModelRoutes(routes: ProviderModelRoute[]): void {
    this.modelRoutes.clear();
    for (const route of routes) {
      if (!this.providers.has(route.providerId)) {
        continue;
      }
      const normalized: ProviderModelRoute = {
        model: route.model,
        providerId: route.providerId,
        providerModel: route.providerModel
      };
      if (route.fallbackProviderId && this.providers.has(route.fallbackProviderId)) {
        normalized.fallbackProviderId = route.fallbackProviderId;
        normalized.fallbackProviderModel = route.fallbackProviderModel ?? route.providerModel;
      }
      this.modelRoutes.set(route.model, normalized);
    }
  }

  resolveModelRoute(model: string, legacyProviderId?: string): ResolvedModelRoute {
    const route = this.modelRoutes.get(model);
    if (route) {
      return {
        requestedModel: model,
        providerId: route.providerId,
        providerModel: route.providerModel,
        source: "model_route",
        fallback: route.fallbackProviderId
          ? {
              providerId: route.fallbackProviderId,
              providerModel: route.fallbackProviderModel ?? route.providerModel
            }
          : undefined
      };
    }

    if (legacyProviderId && this.providers.has(legacyProviderId)) {
      return {
        requestedModel: model,
        providerId: legacyProviderId,
        providerModel: model,
        source: "legacy_provider"
      };
    }

    throw new ModelRouteNotFoundError(model);
  }

  getProvider(providerId: string): ModelProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unsupported provider: ${providerId}`);
    }
    return provider;
  }

  async generate(providerId: string, params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
    const provider = this.getProvider(providerId);
    return provider.generate(params);
  }

  async generateStream(providerId: string, params: ProviderGenerateParams): Promise<ProviderStreamResult> {
    const provider = this.getProvider(providerId);
    return provider.generateStream(params);
  }

  async generateWithResilience(
    route: ResolvedModelRoute,
    params: ProviderGenerateParams
  ): Promise<ResilientProviderResult<ProviderGenerateResult>> {
    return this.executeWithResilience(route, params, false, (provider, nextParams) => provider.generate(nextParams));
  }

  async generateStreamWithResilience(
    route: ResolvedModelRoute,
    params: ProviderGenerateParams
  ): Promise<ResilientProviderResult<ProviderStreamResult>> {
    return this.executeWithResilience(route, params, true, (provider, nextParams) => provider.generateStream(nextParams));
  }

  private providerCandidates(route: ResolvedModelRoute): ProviderCandidate[] {
    const candidates: ProviderCandidate[] = [
      {
        providerId: route.providerId,
        providerModel: route.providerModel
      }
    ];
    if (route.fallback && this.providers.has(route.fallback.providerId)) {
      candidates.push(route.fallback);
    }
    return candidates;
  }

  private async withTimeout<T>(executor: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.requestTimeoutMs <= 0) {
      const controller = new AbortController();
      return executor(controller.signal);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);

    try {
      return await executor(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`PROVIDER_TIMEOUT:${this.requestTimeoutMs}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseProviderErrorReason(error: unknown): "timeout" | "rate_limit" | "upstream_5xx" | "client_error" | "unknown" {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("PROVIDER_TIMEOUT:")) {
      return "timeout";
    }
    const statusMatch = message.match(/Provider request failed \((\d{3})\)/);
    const status = statusMatch ? Number(statusMatch[1]) : null;
    if (status === 429) {
      return "rate_limit";
    }
    if (status && status >= 500) {
      return "upstream_5xx";
    }
    if (status && status >= 400) {
      return "client_error";
    }
    return "unknown";
  }

  private isRetryableError(error: unknown): boolean {
    const reason = this.parseProviderErrorReason(error);
    if (reason === "client_error") {
      return false;
    }
    return true;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async executeWithResilience<T>(
    route: ResolvedModelRoute,
    params: ProviderGenerateParams,
    stream: boolean,
    executor: (provider: ModelProvider, params: ProviderGenerateParams) => Promise<T>
  ): Promise<ResilientProviderResult<T>> {
    const candidates = this.providerCandidates(route);
    let totalAttempts = 0;
    let retries = 0;
    let lastError: unknown;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!candidate) {
        continue;
      }
      const provider = this.getProvider(candidate.providerId);

      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        totalAttempts += 1;
        const startedAt = Date.now();
        try {
          const result = await this.withTimeout((signal) =>
            executor(provider, {
              ...params,
              model: candidate.providerModel,
              signal
            })
          );
          metrics.providerCallDurationMs.observe(Date.now() - startedAt, {
            provider: candidate.providerId,
            model: route.requestedModel,
            stream,
            outcome: "success"
          });

          return {
            providerId: candidate.providerId,
            providerModel: candidate.providerModel,
            attempts: totalAttempts,
            retries,
            failoverUsed: index > 0,
            result
          };
        } catch (error) {
          lastError = error;
          const reason = this.parseProviderErrorReason(error);
          metrics.providerCallDurationMs.observe(Date.now() - startedAt, {
            provider: candidate.providerId,
            model: route.requestedModel,
            stream,
            outcome: "failure"
          });
          logger.warn("provider.call.failed", {
            provider: candidate.providerId,
            model: route.requestedModel,
            stream,
            attempt: attempt + 1,
            reason
          });

          if (attempt < this.maxRetries && this.isRetryableError(error)) {
            retries += 1;
            metrics.providerRetriesTotal.inc({
              provider: candidate.providerId,
              reason
            });
            await this.sleep(this.retryBackoffMs * (attempt + 1));
            continue;
          }

          const nextCandidate = candidates[index + 1];
          if (nextCandidate) {
            metrics.providerFailoversTotal.inc({
              fromProvider: candidate.providerId,
              toProvider: nextCandidate.providerId,
              model: route.requestedModel
            });
            logger.warn("provider.failover.triggered", {
              provider: candidate.providerId,
              fallbackProvider: nextCandidate.providerId,
              model: route.requestedModel,
              reason
            });
          }
          break;
        }
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error("Provider execution failed");
  }
}
