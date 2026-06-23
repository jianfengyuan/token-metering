import { describe, expect, it } from "vitest";
import type { ProviderGenerateParams, ProviderGenerateResult, ProviderStreamResult } from "../src/providers/base.js";
import { ModelRouteNotFoundError, ProviderGateway } from "../src/providers/gateway.js";

class StaticProvider {
  constructor(
    public readonly id: string,
    private readonly content: string
  ) {}

  async generate(_params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
    return {
      content: this.content,
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2
      },
      raw: { provider: this.id }
    };
  }

  async generateStream(params: ProviderGenerateParams): Promise<ProviderStreamResult> {
    const result = await this.generate(params);
    return {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        }
      }),
      completion: Promise.resolve(result),
      contentType: "text/event-stream; charset=utf-8"
    };
  }
}

class FlakyProvider extends StaticProvider {
  private attempts = 0;

  constructor(id: string, content: string, private readonly failTimes: number) {
    super(id, content);
  }

  override async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
    this.attempts += 1;
    if (this.attempts <= this.failTimes) {
      throw new Error("Provider request failed (503): retry me");
    }
    return super.generate(params);
  }
}

describe("ProviderGateway routing", () => {
  it("resolves configured model route", () => {
    const gateway = new ProviderGateway({
      providers: [new StaticProvider("test-sim", "ok")],
      modelRoutes: [
        {
          model: "sim-local",
          providerId: "test-sim",
          providerModel: "sim-local"
        }
      ]
    });
    const route = gateway.resolveModelRoute("sim-local");

    expect(route.providerId).toBe("test-sim");
    expect(route.providerModel).toBe("sim-local");
    expect(route.source).toBe("model_route");
  });

  it("falls back to legacy provider for backward compatibility", () => {
    const gateway = new ProviderGateway({
      providers: [new StaticProvider("legacy-provider", "legacy")],
      modelRoutes: []
    });
    const route = gateway.resolveModelRoute("custom-model", "legacy-provider");

    expect(route.providerId).toBe("legacy-provider");
    expect(route.providerModel).toBe("custom-model");
    expect(route.source).toBe("legacy_provider");
  });

  it("throws when both model route and legacy provider are unavailable", () => {
    const gateway = new ProviderGateway({ modelRoutes: [] });

    expect(() => gateway.resolveModelRoute("unknown-model")).toThrowError(ModelRouteNotFoundError);
  });

  it("loads external openai-compatible providers from config", () => {
    const gateway = new ProviderGateway({ modelRoutes: [] });
    gateway.setExternalProviders([
      {
        providerId: "openai",
        providerType: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test"
      },
      {
        providerId: "deepseek",
        providerType: "openai_compatible",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "deepseek-test-key"
      }
    ]);

    expect(gateway.hasProvider("openai")).toBe(true);
    expect(gateway.hasProvider("deepseek")).toBe(true);
  });

  it("ignores unsupported external provider types", () => {
    const gateway = new ProviderGateway({ modelRoutes: [] });
    gateway.setExternalProviders([
      {
        providerId: "anthropic",
        providerType: "anthropic_native",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "test"
      }
    ]);

    expect(gateway.hasProvider("anthropic")).toBe(false);
  });

  it("retries provider call and eventually succeeds", async () => {
    const gateway = new ProviderGateway({
      providers: [new FlakyProvider("flaky-primary", "ok after retry", 1)],
      modelRoutes: [
        {
          model: "retry-model",
          providerId: "flaky-primary",
          providerModel: "retry-model"
        }
      ],
      maxRetries: 1,
      retryBackoffMs: 1
    });

    const route = gateway.resolveModelRoute("retry-model");
    const response = await gateway.generateWithResilience(route, {
      model: "retry-model",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(response.providerId).toBe("flaky-primary");
    expect(response.retries).toBe(1);
    expect(response.attempts).toBe(2);
    expect(response.failoverUsed).toBe(false);
    expect(response.result.content).toContain("ok after retry");
  });

  it("fails over to fallback provider when primary remains unavailable", async () => {
    const gateway = new ProviderGateway({
      providers: [
        new FlakyProvider("always-fail", "never", 99),
        new StaticProvider("backup-provider", "backup reply")
      ],
      modelRoutes: [
        {
          model: "failover-model",
          providerId: "always-fail",
          providerModel: "failover-model",
          fallbackProviderId: "backup-provider",
          fallbackProviderModel: "failover-model-backup"
        }
      ],
      maxRetries: 0
    });

    const route = gateway.resolveModelRoute("failover-model");
    const response = await gateway.generateWithResilience(route, {
      model: "failover-model",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(response.providerId).toBe("backup-provider");
    expect(response.failoverUsed).toBe(true);
    expect(response.result.content).toContain("backup reply");
  });
});
