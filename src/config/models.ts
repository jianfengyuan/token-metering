export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  currency: string;
}

const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 0,
  outputPerMillion: 0,
  currency: "USD"
};

const MODEL_PRICING: Record<string, ModelPricing> = {
  "llama3.2": {
    inputPerMillion: 0,
    outputPerMillion: 0,
    currency: "USD"
  },
  "gpt-4o-mini": {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    currency: "USD"
  }
};

export function getModelPricing(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? DEFAULT_PRICING;
}
