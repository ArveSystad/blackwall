import {
  MAX_GITHUB_ISSUES_REFRESH_SECONDS,
  MIN_GITHUB_ISSUES_REFRESH_SECONDS,
  type GeneralSettings,
} from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { updateSettings } from "../../api";
import { cn } from "../../lib/utils";
import { queryKeys, settingsQuery } from "../../query";
import { errorMessage, parseCap, parseRefreshSeconds } from "../../settings-forms";
import { editorBody, sectionLegend } from "../classes";
import { fieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Empty, SaveBar, SectionHeader } from "./parts";

function BacklogEditor({ saved }: { saved: GeneralSettings }) {
  const queryClient = useQueryClient();
  const [runner, setRunner] = useState(saved.backlogRunner);
  const [cap, setCap] = useState(String(saved.maxBacklogTasksPerRepo));
  const [stopOnNeeds, setStopOnNeeds] = useState(saved.stopBacklogOnNeedsYou);
  const [refresh, setRefresh] = useState(String(saved.githubIssuesRefreshSeconds));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const capValue = parseCap(cap);
  const refreshValue = parseRefreshSeconds(refresh);
  const dirty =
    runner !== saved.backlogRunner ||
    capValue !== saved.maxBacklogTasksPerRepo ||
    stopOnNeeds !== saved.stopBacklogOnNeedsYou ||
    refreshValue !== saved.githubIssuesRefreshSeconds;

  async function save() {
    if (!dirty || saving) return;
    if (capValue === null) {
      setError("Backlog tasks per repo must be a whole number from 1 to 20");
      return;
    }
    if (refreshValue === null) {
      setError(
        `Refresh interval must be a whole number of seconds from ${MIN_GITHUB_ISSUES_REFRESH_SECONDS} to ${MAX_GITHUB_ISSUES_REFRESH_SECONDS}`,
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      queryClient.setQueryData(
        queryKeys.settings,
        await updateSettings({
          backlogRunner: runner,
          maxBacklogTasksPerRepo: capValue,
          stopBacklogOnNeedsYou: stopOnNeeds,
          githubIssuesRefreshSeconds: refreshValue,
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <>
      <div className={cn(editorBody, "gap-6")}>
        <fieldset className="m-0 flex max-w-[720px] flex-col gap-4 border-none p-0">
          <legend className={sectionLegend}>Backlog runner</legend>
          <p className="m-0 text-meta text-muted-foreground">
            The runner promotes each repo&apos;s backlog items to tasks when the repo is idle and
            the agents&apos; quotas allow. Each repo&apos;s backlog view can switch it off for that
            repo.
          </p>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-[3px]"
              checked={runner}
              onChange={(event) => setRunner(event.target.checked)}
            />
            <span className="flex flex-col gap-0.5">
              <span className={fieldLabel}>Run backlogs automatically</span>
              <span className="text-meta text-muted-foreground">
                Off: items wait until you press Start working.
              </span>
            </span>
          </label>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <label htmlFor="max-backlog-tasks-per-repo" className={fieldLabel}>
              Backlog tasks per repo
            </label>
            <div className="flex items-center gap-3">
              <Input
                id="max-backlog-tasks-per-repo"
                type="number"
                min={1}
                max={20}
                className="mono w-20"
                aria-invalid={capValue === null}
                aria-describedby="max-backlog-tasks-per-repo-hint"
                value={cap}
                onChange={(event) => setCap(event.target.value)}
              />
              <span
                id="max-backlog-tasks-per-repo-hint"
                className="text-meta text-muted-foreground"
              >
                Default for repos without their own cap, within the repo&apos;s task cap.
              </span>
            </div>
          </div>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-[3px]"
              checked={stopOnNeeds}
              onChange={(event) => setStopOnNeeds(event.target.checked)}
            />
            <span className="flex flex-col gap-0.5">
              <span className={fieldLabel}>Stop when a task needs me</span>
              <span className="text-meta text-muted-foreground">
                Hold a repo&apos;s backlog while one of its backlog tasks waits on you.
              </span>
            </span>
          </label>
        </fieldset>
        <fieldset className="m-0 flex max-w-[720px] flex-col gap-4 border-none p-0">
          <legend className={sectionLegend}>GitHub issues</legend>
          <p className="m-0 text-meta text-muted-foreground">
            How often each backlog&apos;s GitHub and Jira issues and the assigned issues re-read
            GitHub and Jira, so closed issues drop off.
          </p>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <label htmlFor="github-issues-refresh-seconds" className={fieldLabel}>
              Refresh every (seconds)
            </label>
            <div className="flex items-center gap-3">
              <Input
                id="github-issues-refresh-seconds"
                type="number"
                min={MIN_GITHUB_ISSUES_REFRESH_SECONDS}
                max={MAX_GITHUB_ISSUES_REFRESH_SECONDS}
                className="mono w-20"
                aria-invalid={refreshValue === null}
                aria-describedby="github-issues-refresh-seconds-hint"
                value={refresh}
                onChange={(event) => setRefresh(event.target.value)}
              />
              <span
                id="github-issues-refresh-seconds-hint"
                className="text-meta text-muted-foreground"
              >
                Seconds between refreshes while the window is focused.
              </span>
            </div>
          </div>
        </fieldset>
      </div>
      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        onDiscard={() => {
          setRunner(saved.backlogRunner);
          setCap(String(saved.maxBacklogTasksPerRepo));
          setStopOnNeeds(saved.stopBacklogOnNeedsYou);
          setRefresh(String(saved.githubIssuesRefreshSeconds));
          setError(null);
        }}
        onSave={() => void save()}
      />
    </>
  );
}

/**
 * Global backlog runner settings and the GitHub issues refresh interval; the
 * per-repo switch lives on each backlog view and the per-repo cap on each
 * repo's settings.
 */
export function BacklogSection() {
  const settings = useQuery(settingsQuery);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <SectionHeader title="Backlog" />
      {settings.error ? (
        <Empty>{settings.error.message}</Empty>
      ) : !settings.data ? (
        <Empty>Reading backlog settings…</Empty>
      ) : (
        <BacklogEditor key={JSON.stringify(settings.data)} saved={settings.data} />
      )}
    </div>
  );
}
