import { APP_NAME } from "@blackwall/shared";

export function describeCore(): string {
  return `${APP_NAME} core`;
}

export * from "./agents/index.js";
export * from "./chat/index.js";
export * from "./connections/index.js";
export * from "./data/index.js";
export * from "./db/index.js";
export * from "./git/index.js";
export * from "./pipeline/index.js";
export * from "./repos/index.js";
export * from "./search/index.js";
export * from "./secrets/index.js";
export * from "./settings/index.js";
export * from "./system/index.js";
