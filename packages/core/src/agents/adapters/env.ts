/**
 * Environment helpers for agent runs. Windows treats variable names
 * case-insensitively, so a plain spread could leave both `PATH` and `Path`, or
 * let a lower-cased copy of a blackwall-owned variable sit beside the real one
 * (which of the two the child sees is then undefined). On `win32` these
 * helpers match names case-insensitively; elsewhere names are exact.
 *
 * A repo's variables are expanded once, against the base environment, before
 * they are layered ({@link withRepoEnv}): a leading `~` (alone or before `/`
 * or `\`) becomes the home folder; `$NAME`, `${NAME}` and, on `win32`,
 * `%NAME%` become the variable's value; `$$` is a literal `$`. An unset
 * variable expands to empty and is reported. Substituted text is never scanned
 * again, and anything else (a lone `$`, `$1`, `${`, `%%`) stays as typed.
 */

import { homedir } from "node:os";

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

const REFERENCE = /\$\$|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g;
const REFERENCE_WIN32 = /\$\$|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)|%([A-Za-z_][\w()]*)%/g;

export interface ExpandedEnvValue {
  value: string;
  /** Referenced variables that are not set, as written. */
  unknown: string[];
  /** Every variable the value refers to, as written. */
  referenced: string[];
}

/** `value` with `~` and variable references expanded from `env`. */
export function expandEnvValue(
  value: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): ExpandedEnvValue {
  const unknown: string[] = [];
  const referenced: string[] = [];
  const lookup = (name: string): string => {
    if (!referenced.includes(name)) referenced.push(name);
    const key =
      platform === "win32"
        ? Object.keys(env).find((candidate) => matches(candidate, name, platform))
        : name;
    const found = key === undefined ? undefined : env[key];
    if (found === undefined) {
      if (!unknown.includes(name)) unknown.push(name);
      return "";
    }
    return found;
  };
  const pattern = platform === "win32" ? REFERENCE_WIN32 : REFERENCE;
  let rest = value;
  let prefix = "";
  if (value.startsWith("~") && (value.length === 1 || value[1] === "/" || value[1] === "\\")) {
    prefix = home;
    rest = value.slice(1);
  }
  // The non-win32 pattern has no `%` group, so its third extra argument is the
  // match offset: take the first capture that is a string.
  const expanded = rest.replace(pattern, (_match: string, ...groups: unknown[]) => {
    const name = groups.slice(0, 3).find((group) => typeof group === "string");
    return typeof name === "string" ? lookup(name) : "$";
  });
  return { value: prefix + expanded, unknown, referenced };
}

export interface ExpandedEnv {
  env: Record<string, string>;
  /** Unknown variables by the name that referred to them; only non-empty lists. */
  unknown: Record<string, string[]>;
  /** Referenced variables by the name that referred to them; only non-empty lists. */
  referenced: Record<string, string[]>;
}

/** Each of `record`'s values expanded from `env` with {@link expandEnvValue}. */
export function expandEnv(
  record: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ExpandedEnv {
  const result: ExpandedEnv = { env: {}, unknown: {}, referenced: {} };
  for (const [name, raw] of Object.entries(record)) {
    const { value, unknown, referenced } = expandEnvValue(raw, env, platform);
    result.env[name] = value;
    if (unknown.length > 0) result.unknown[name] = unknown;
    if (referenced.length > 0) result.referenced[name] = referenced;
  }
  return result;
}

/**
 * `base` with a repo's variables expanded against it and layered on top. The
 * one way adapters apply `AgentRunOptions.env`; blackwall-owned variables go
 * on after this.
 */
export function withRepoEnv(
  base: NodeJS.ProcessEnv,
  repoEnv: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return mergeEnv(base, expandEnv(repoEnv, base, platform).env, platform);
}
