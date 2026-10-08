import { spawn } from "node:child_process";

/** Opens `url` in the default browser. Failures are logged, never thrown. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];

  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", (error) => {
    console.error(`Could not open the browser (${error.message}); open the URL manually.`);
  });
  child.unref();
}
