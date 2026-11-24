/**
 * Environment helpers for agent runs. Windows treats variable names
 * case-insensitively, so a plain spread could leave both `PATH` and `Path`, or
 * let a lower-cased copy of a blackwall-owned variable sit beside the real one
 * (which of the two the child sees is then undefined). On `win32` these
 * helpers match names case-insensitively; elsewhere names are exact.
 */

function matches(name: string, other: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? name.toUpperCase() === other.toUpperCase() : name === other;
}

/**
 * A copy of `base` with `overrides` applied on top. On `win32`, base keys that
 * match an override key case-insensitively are removed first, so the
 * override is the only copy.
 */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const names = Object.keys(overrides);
  if (platform === "win32" && names.length > 0) {
    for (const key of Object.keys(env)) {
      if (names.some((name) => matches(key, name, platform))) delete env[key];
    }
  }
  for (const name of names) env[name] = overrides[name];
  return env;
}

/** A copy of `env` without `names`, matched case-insensitively on `win32`. */
export function omitEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(result)) {
    if (names.some((name) => matches(key, name, platform))) delete result[key];
  }
  return result;
}
