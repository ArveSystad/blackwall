import { createRepositories, openDatabase } from "@blackwall/core";
import { banner } from "./banner.js";
import { parseConfig } from "./config.js";
import { openBrowser } from "./open-browser.js";
import { startServer } from "./server.js";
import { createShutdown } from "./shutdown.js";

const config = parseConfig(process.argv.slice(2), process.env);
const shutdown = createShutdown();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown.run().then(() => process.exit(0));
  });
}

try {
  const database = openDatabase(config.dataDir);
  shutdown.onShutdown(() => database.close());
  // Steps left running by a previous process can only be resumed, not continued.
  createRepositories(database.db).steps.interruptRunning();

  const { launchUrl } = await startServer({
    port: config.port,
    dev: config.dev,
    webDevOrigin: config.webDevOrigin,
    shutdown,
  });
  console.log(`${banner()}\n\nblackwall is running at:\n  ${launchUrl}\n`);
  if (config.open) openBrowser(launchUrl);
} catch (error) {
  console.error(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  await shutdown.run();
  process.exit(1);
}
