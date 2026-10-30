import type { ProjectRunStatus, RepoView } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef } from "react";
import { outputLinks } from "../project-run";
import { projectRunOutputQuery } from "../query";
import { errorMessage } from "../settings-forms";
import { ProjectRunAction } from "./ProjectRunAction";
import { Button } from "./ui/button";
import { Chip } from "./ui/chip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { ErrorText } from "./ui/field";
import type { ProjectRunControl } from "./use-project-run";

/** How close to the bottom, in px, still counts as following the output. */
const FOLLOW_SLACK_PX = 24;

const STATUS_CHIPS: Record<
  ProjectRunStatus,
  { label: string; tone: "neutral" | "done" | "cyan" | "failed" }
> = {
  starting: { label: "Starting", tone: "cyan" },
  running: { label: "Running", tone: "done" },
  stopping: { label: "Stopping", tone: "neutral" },
  stopped: { label: "Stopped", tone: "neutral" },
  exited: { label: "Exited", tone: "neutral" },
  failed: { label: "Failed", tone: "failed" },
};

/**
 * The live terminal output of the repo's latest Run project run, with the same
 * start/stop action as the top bar. It follows new output while scrolled to the
 * bottom and stays put while the user reads further up. URLs in the output are
 * clickable; opening it focuses Close rather than the first link, so the jump
 * to that link doesn't scroll up and stop the following.
 */
export function ProjectOutputModal({
  repo,
  project,
  onClose,
}: {
  repo: RepoView;
  project: ProjectRunControl;
  onClose: () => void;
}) {
  const output = useQuery(projectRunOutputQuery(repo.id));
  const pre = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const closeRef = useRef<HTMLButtonElement>(null);
  const text = output.data?.text ?? "";
  const { run, error } = project;
  const chip = run ? STATUS_CHIPS[run.status] : null;

  useLayoutEffect(() => {
    const el = pre.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="max-w-[900px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus();
        }}
      >
        <div className="flex flex-col gap-3 px-5 pt-[18px] pb-4">
          <div className="flex flex-col gap-2">
            <DialogTitle>{repo.name} output</DialogTitle>
            <DialogDescription asChild>
              <div className="m-0 flex flex-wrap items-center gap-2">
                {chip && <Chip tone={chip.tone}>{chip.label}</Chip>}
                {(run?.commands ?? repo.runCommands).map((command, index) => (
                  <code key={index} className="mono text-meta text-muted-foreground">
                    {command}
                  </code>
                ))}
              </div>
            </DialogDescription>
          </div>
          <pre
            ref={pre}
            className="m-0 h-[60vh] overflow-auto bg-code px-3 py-2 font-mono text-code whitespace-pre-wrap text-foreground"
            onScroll={(event) => {
              const el = event.currentTarget;
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
            }}
          >
            {output.isPending ? "Loading…" : text ? <OutputText text={text} /> : "(no output)"}
          </pre>
          {run?.status === "failed" && run.error && <ErrorText>{run.error}</ErrorText>}
          {output.error && <ErrorText>{errorMessage(output.error)}</ErrorText>}
          {error && <ErrorText>{error}</ErrorText>}
        </div>
        <DialogFooter>
          <Button ref={closeRef} variant="ghost" onClick={onClose}>
            Close
          </Button>
          <ProjectRunAction project={project} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Project output with its http(s) URLs as links that open in a new tab. */
export function OutputText({ text }: { text: string }) {
  const segments = useMemo(() => outputLinks(text), [text]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.href ? (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline"
          >
            {segment.text}
          </a>
        ) : (
          segment.text
        ),
      )}
    </>
  );
}
