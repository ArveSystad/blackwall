import {
  MAX_PROJECT_OUTPUT_CHARS,
  type ProjectRun,
  type ProjectRunOutput,
  type RepoView,
} from "@blackwall/shared";

/** What the Run project split button shows for a repo and its latest run. */
export interface RunButtonState {
  /** The main half can't be clicked; `title` says why. */
  disabled: boolean;
  title: string;
  mainLabel: string;
  mainAction: "start" | "stop";
  /** The project is up: the main half glows green. */
  glowing: boolean;
  /** A run exists, so its output can be read. */
  showOutputButton: boolean;
}

/** True while the repo's run has processes that are, or may still be, alive. */
export function isRunActive(run: ProjectRun | undefined): boolean {
  return run?.status === "starting" || run?.status === "running" || run?.status === "stopping";
}

export function runButtonState(repo: RepoView, run: ProjectRun | undefined): RunButtonState {
  const showOutputButton = run !== undefined;
  const start = { mainLabel: "Run project", mainAction: "start" as const, glowing: false };
  if (run?.status === "starting" || run?.status === "running") {
    return {
      disabled: false,
      title: run.status === "running" ? "The project is running" : "The project is starting",
      mainLabel: "Stop project",
      mainAction: "stop",
      glowing: run.status === "running",
      showOutputButton,
    };
  }
  if (run?.status === "stopping") {
    return {
      disabled: true,
      title: "Stopping the project",
      mainLabel: "Stopping…",
      mainAction: "stop",
      glowing: false,
      showOutputButton,
    };
  }
  if (repo.runCommands.length === 0) {
    return {
      ...start,
      disabled: true,
      title: "Add run commands in Settings → Repositories to run this project from here",
      showOutputButton,
    };
  }
  if (!repo.exists) {
    return { ...start, disabled: true, title: "The repo folder is missing", showOutputButton };
  }
  return {
    ...start,
    disabled: false,
    title: run?.status === "failed" && run.error ? run.error : "Start the repo's run commands",
    showOutputButton,
  };
}

/**
 * The cached output with a `projectRun.output` chunk appended, capped to the
 * last {@link MAX_PROJECT_OUTPUT_CHARS} characters; null when the chunk is from
 * another run or doesn't follow on from the cache, so it must be refetched.
 */
export function appendProjectOutput(
  cached: ProjectRunOutput | null,
  event: { runId: string; end: number; text: string },
): ProjectRunOutput | null {
  if (!cached || cached.runId !== event.runId) return null;
  if (cached.end !== event.end - event.text.length) return null;
  return {
    runId: cached.runId,
    end: event.end,
    text: (cached.text + event.text).slice(-MAX_PROJECT_OUTPUT_CHARS),
  };
}

/** A piece of project output: plain text, or a link when `href` is set. */
export interface OutputSegment {
  text: string;
  href?: string;
}

// Control characters end a match, so OSC 8 hyperlink debris (ESC, BEL) stays out of links.
// eslint-disable-next-line no-control-regex
const OUTPUT_URL = /https?:\/\/[^\s<>"'`\u0000-\u001f\u007f]+/gi;
const TRAILING_PUNCTUATION = ".,;:!?'\"";
const BRACKETS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const count = (text: string, char: string) => text.split(char).length - 1;

/** The URL without trailing sentence punctuation or closing brackets it didn't open. */
function trimUrl(match: string): string {
  let url = match;
  for (;;) {
    const last = url.at(-1);
    if (!last) return url;
    const opener = BRACKETS[last];
    if (TRAILING_PUNCTUATION.includes(last)) url = url.slice(0, -1);
    else if (opener && count(url, last) > count(url, opener)) url = url.slice(0, -1);
    else return url;
  }
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Splits project output into text and http(s) link segments; joining every
 * segment's `text` gives back the input.
 */
export function outputLinks(text: string): OutputSegment[] {
  const segments: OutputSegment[] = [];
  const pushText = (piece: string) => {
    if (!piece) return;
    const last = segments.at(-1);
    if (last && last.href === undefined) last.text += piece;
    else segments.push({ text: piece });
  };
  let index = 0;
  for (const match of text.matchAll(OUTPUT_URL)) {
    const url = trimUrl(match[0]);
    if (!url || !isWebUrl(url)) continue;
    pushText(text.slice(index, match.index));
    segments.push({ text: url, href: url });
    index = match.index + url.length;
  }
  pushText(text.slice(index));
  return segments;
}
