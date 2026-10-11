import { APP_NAME } from "./index.js";

/** The window title: `(N) blackwall`, N being the tasks that need the user. */
export function documentTitle(needsYouCount: number): string {
  return needsYouCount > 0 ? `(${needsYouCount}) ${APP_NAME}` : APP_NAME;
}

/** Reads the needs-you count back from a `documentTitle`; 0 for any other title. */
export function needsYouCountFromTitle(title: string): number {
  // Built per call: `APP_NAME` is not initialised yet while index.ts loads this module.
  const match = new RegExp(`^\\((\\d+)\\) ${APP_NAME}$`).exec(title);
  return match ? Number(match[1]) : 0;
}
