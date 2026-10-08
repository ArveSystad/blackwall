import { APP_NAME } from "@blackwall/shared";

export function describeIntegrations(): string {
  return `${APP_NAME} integrations`;
}

export * from "./connection-test.js";
export * from "./jira/index.js";
