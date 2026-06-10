import { MockLocalProvider } from "./mockLocal.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import type {
  ModelProvider,
  ProviderGenerateParams,
  ProviderGenerateResult,
  ProviderStreamResult
} from "./base.js";

export interface ProviderGatewayOptions {
  ollamaBaseUrl?: string;
  ollamaApiKey?: string;
  simulatorBaseUrl?: string;
  simulatorApiKey?: string;
}

export class ProviderGateway {
  private readonly providers: Map<string, ModelProvider>;

  constructor(options: ProviderGatewayOptions = {}) {
    const ollamaBaseUrl = options.ollamaBaseUrl ?? "http://127.0.0.1:11434/v1";
    const ollamaApiKey = options.ollamaApiKey ?? "local-dev";
    const simulatorBaseUrl = options.simulatorBaseUrl ?? "http://127.0.0.1:3000/simulator/v1";
    const simulatorApiKey = options.simulatorApiKey ?? "local-dev";

    this.providers = new Map<string, ModelProvider>([
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
    ]);
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
}
