import { banner } from "./banner.js";
import { parseConfig } from "./config.js";
import { openBrowser } from "./open-browser.js";
import { startBlackwall, type RunningBlackwall } from "./start.js";

const config = parseConfig(process.argv.slice(2), process.env);
let running: RunningBlackwall | undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void Promise.resolve(running?.shutdown()).then(() => process.exit(0));
  });
}

try {
  running = await startBlackwall(config);
  console.log(`${banner()}\n\nblackwall is running at:\n  ${running.launchUrl}\n`);
  if (config.open) openBrowser(running.launchUrl);
} catch (error) {
  // startBlackwall has already run the shutdown hooks.
  console.error(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
