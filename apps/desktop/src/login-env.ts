import { execFile } from "node:child_process";

type Env = Record<string, string | undefined>;

const MARKER = "__BLACKWALL_ENV__";
const LOGIN_SHELL_TIMEOUT_MS = 5000;

/**
 * Reads `env` output printed between two markers, dropping rc-file noise
 * around it. A line without `=` continues the previous value.
 */
export function parseEnvOutput(text: string): Record<string, string> {
  const start = text.indexOf(MARKER);
  const end = text.indexOf(MARKER, start + MARKER.length);
  if (start === -1 || end === -1) return {};
  const env: Record<string, string> = {};
  let last: string | undefined;
  for (const line of text.slice(start + MARKER.length, end).split("\n")) {
    const eq = line.indexOf("=");
    const name = eq > 0 ? line.slice(0, eq) : "";
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      env[name] = line.slice(eq + 1);
      last = name;
    } else if (last !== undefined) {
      env[last] += `\n${line}`;
    }
  }
  if (last !== undefined) env[last] = env[last]!.replace(/\n+$/, "");
  return env;
}

function withoutElectronVars(env: Env): Env {
  const result = { ...env };
  for (const name of Object.keys(result)) if (name.startsWith("ELECTRON_")) delete result[name];
  return result;
}

function loginShellOutput(): Promise<string> {
  const shell = process.env.SHELL || "/bin/sh";
  return new Promise((resolve, reject) =>
    execFile(
      shell,
      ["-ilc", `printf ${MARKER}; env; printf ${MARKER}`],
      { timeout: LOGIN_SHELL_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}

/**
 * The environment the server child runs with. Apps started from Finder or a
 * desktop launcher miss the login shell's `PATH`, so on macOS and Linux it is
 * read from `$SHELL -ilc env`; falls back to `process.env` on any failure.
 */
export async function resolveLoginEnv(): Promise<Env> {
  if (process.platform === "win32") return withoutElectronVars(process.env);
  try {
    const parsed = parseEnvOutput(await loginShellOutput());
    if (Object.keys(parsed).length === 0) return withoutElectronVars(process.env);
    return withoutElectronVars({ ...process.env, ...parsed });
  } catch {
    return withoutElectronVars(process.env);
  }
}
