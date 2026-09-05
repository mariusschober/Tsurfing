import { createApp } from "./app";
import { productionConfigurationProblems, readConfig } from "./config";
import { configureTelegramDeployment } from "./telegram/deployment";

const config = readConfig();
const configurationProblems = productionConfigurationProblems(config);
if (configurationProblems.length > 0) {
  console.error(JSON.stringify({
    level: "error",
    event: "server.production_configuration_invalid",
    problems: configurationProblems
  }));
}
const telegram = await configureTelegramDeployment(config);
if (telegram.configured) {
  console.log(JSON.stringify({
    level: "info",
    event: "telegram.deployment_configured",
    username: telegram.username,
    webhookUrl: telegram.webhookUrl,
    miniAppUrl: telegram.miniAppUrl
  }));
}
const app = await createApp(config);
const server = app.listen(config.PORT, config.HOST, () => {
  console.log(JSON.stringify({ level: "info", event: "server.started", host: config.HOST, port: config.PORT, environment: config.NODE_ENV }));
});

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "server.stopping", signal }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", error => {
  console.error(JSON.stringify({ level: "error", event: "server.uncaught_exception", category: error.name }));
  shutdown("uncaughtException");
});
process.on("unhandledRejection", reason => {
  console.error(JSON.stringify({
    level: "error",
    event: "server.unhandled_rejection",
    category: reason instanceof Error ? reason.name : "unknown"
  }));
  shutdown("unhandledRejection");
});
