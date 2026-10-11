export interface QuitPrompt {
  message: string;
  detail?: string;
}

/** The quit confirmation; `runningAgents` is `undefined` when the server did not answer in time. */
export function quitPrompt(runningAgents: number | undefined): QuitPrompt {
  const message = "Are you sure you want to quit blackwall?";
  if (!runningAgents) return { message };
  const detail =
    runningAgents === 1
      ? "There is 1 agent currently running that will be stopped."
      : `There are ${runningAgents} agents currently running that will be stopped.`;
  return { message, detail };
}
