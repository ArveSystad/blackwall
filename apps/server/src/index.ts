import {
  createAgentService,
  createConnectionService,
  createConnectionTokens,
  createKeyringSecretStore,
  createRepoService,
  createRepositories,
  createSettingsService,
  detectClis,
  openDatabase,
} from "@blackwall/core";
import { testConnection } from "@blackwall/integrations";
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
  // Runs in the background; the Settings screen shows the result.
  const clis = detectClis();
  const database = openDatabase(config.dataDir);
  shutdown.onShutdown(() => database.close());
  const repositories = createRepositories(database.db);
  // Steps left running by a previous process can only be resumed, not continued.
  repositories.steps.interruptRunning();
  const connectionTokens = createConnectionTokens({
    store: createKeyringSecretStore(),
    connections: repositories.connections,
  });
  const connections = createConnectionService({
    connections: repositories.connections,
    tokens: connectionTokens,
  });
  const repos = createRepoService({ repos: repositories.repos, connections });
  const agents = createAgentService({
    agents: repositories.agents,
    settings: repositories.settings,
    tags: repositories.tags,
  });
  // First start: the built-in agents, their role defaults and the finding tags.
  agents.seed();
  const settings = createSettingsService({
    settings: repositories.settings,
    tags: repositories.tags,
  });

  const { launchUrl } = await startServer({
    port: config.port,
    dev: config.dev,
    webDevOrigin: config.webDevOrigin,
    connections: { connections, test: testConnection },
    repos,
    agents,
    settings,
    tasks: repositories.tasks,
    clis: () => clis,
    shutdown,
  });
  console.log(`${banner()}\n\nblackwall is running at:\n  ${launchUrl}\n`);
  if (config.open) openBrowser(launchUrl);
} catch (error) {
  console.error(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  await shutdown.run();
  process.exit(1);
}
