import { APP_NAME } from "@blackwall/shared";

export function describeCore(): string {
  return `${APP_NAME} core`;
}

export * from "./db/index.js";
export * from "./secrets/index.js";
