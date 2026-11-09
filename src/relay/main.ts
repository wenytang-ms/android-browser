import { resolve } from "node:path";
import { createRelay } from "./server.js";
import { relayUrl } from "../shared/protocol.js";

const publicUrl = relayUrl(process.env.PUBLIC_URL ?? "http://localhost:3000");
if (publicUrl.protocol === "https:" && !process.env.DEPLOYMENT_TOKEN)
  throw new Error("Public deployment requires DEPLOYMENT_TOKEN.");
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be between 1 and 65535.");

const relay = createRelay({
  publicUrl: publicUrl.href,
  viewerDir: resolve(process.env.VIEWER_DIR ?? "dist/viewer"),
  extensionOrigins: (process.env.EXTENSION_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  deploymentToken: process.env.DEPLOYMENT_TOKEN,
});
relay.server.on("error", (error) => {
  console.error("Relay failed:", error.message);
  process.exitCode = 1;
  void relay.close();
});
relay.server.listen(port, process.env.HOST ?? "127.0.0.1", () => {
  console.log(`Tango relay ready on port ${port}; viewer: ${publicUrl.origin}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void relay.close().catch((error: unknown) => {
      console.error("Relay shutdown failed:", error);
      process.exitCode = 1;
    });
  });
