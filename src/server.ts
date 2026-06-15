import "dotenv/config";
import { createApp } from "./app.js";
import { logger } from "./utils/logger.js";

const port = Number(process.env.PORT ?? "3000");
const app = await createApp();

app.listen(port, () => {
  logger.info("server.started", { port });
});
