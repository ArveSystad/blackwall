import { describeCore } from "@blackwall/core";
import { describeIntegrations } from "@blackwall/integrations";

export function banner(): string {
  return `${describeCore()} + ${describeIntegrations()}`;
}
