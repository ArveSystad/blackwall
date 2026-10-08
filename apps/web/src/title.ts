import { APP_NAME } from "@blackwall/shared";

export function documentTitle(needsYouCount: number): string {
  return needsYouCount > 0 ? `(${needsYouCount}) ${APP_NAME}` : APP_NAME;
}
