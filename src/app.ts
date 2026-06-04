import express from "express";
import { createDatabase } from "./db/client.js";
import { MeteringService } from "./metering/service.js";
import { ProviderGateway } from "./providers/gateway.js";
import { UsageRepository } from "./repositories/usageRepository.js";
import { createChatRouter } from "./routes/chat.js";
import { createSimulatorRouter } from "./routes/simulator.js";
import { createUsageRouter } from "./routes/usage.js";
import { logger } from "./utils/logger.js";

export function createApp() {
  const app = express();
  const port = process.env.PORT ?? "3000";
  const simulatorBaseUrl = process.env.LOCAL_SIMULATOR_BASE_URL ?? `http://127.0.0.1:${port}/simulator/v1`;
  const database = createDatabase();
  const meteringService = new MeteringService();
  const usageRepository = new UsageRepository(database);
  const providerGateway = new ProviderGateway({
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    ollamaApiKey: process.env.OLLAMA_API_KEY,
    simulatorBaseUrl,
    simulatorApiKey: process.env.LOCAL_SIMULATOR_API_KEY
  });

  app.use(express.json());

  app.use("/simulator/v1", createSimulatorRouter());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(
    "/chat",
    createChatRouter({
      meteringService,
      providerGateway,
      usageRepository
    })
  );
  app.use("/usage", createUsageRouter(usageRepository));

  logger.info("app.initialized", {
    port: Number(port),
    hasOllamaBaseUrl: Boolean(process.env.OLLAMA_BASE_URL),
    simulatorBaseUrl
  });

  return app;
}
