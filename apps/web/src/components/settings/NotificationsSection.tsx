import { useState } from "react";
import {
  notificationPermission,
  setNotificationsEnabled,
  useNotificationsEnabled,
} from "../../notifications";
import { editorBody, sectionLegend } from "../classes";
import { CheckChip } from "../ui/check-chip";
import { SectionHeader } from "./parts";

/** Desktop notifications, per browser. Applies at once, like the theme toggle. */
export function NotificationsSection() {
  const enabled = useNotificationsEnabled();
  const [permission, setPermission] = useState(notificationPermission);
  const [requesting, setRequesting] = useState(false);

  async function toggle(on: boolean) {
    if (requesting) return;
    if (!on) {
      setNotificationsEnabled(false);
      return;
    }
    if (permission === "default") {
      setRequesting(true);
      try {
        await Notification.requestPermission();
      } catch {
        // Treated like a dismissed prompt; the permission below stays `default`.
      } finally {
        setRequesting(false);
      }
    }
    const next = notificationPermission();
    setPermission(next);
    setNotificationsEnabled(next === "granted");
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <SectionHeader title="Notifications" />
      <div className={editorBody}>
        <fieldset className="m-0 flex max-w-[720px] flex-col gap-3 border-none p-0">
          <legend className={sectionLegend}>Desktop</legend>
          {permission === "unsupported" ? (
            <p className="m-0 text-meta text-muted-foreground">
              This browser doesn&apos;t support desktop notifications.
            </p>
          ) : permission === "denied" ? (
            <p className="m-0 text-meta text-muted-foreground">
              Notifications are blocked for this site. Allow them in the browser&apos;s site
              settings, then turn this on.
            </p>
          ) : (
            <>
              <p className="m-0 text-meta text-muted-foreground">
                Shows a notification when a task starts needing you. Click it to open the task.
              </p>
              <div>
                <CheckChip
                  checked={enabled && permission === "granted"}
                  onCheckedChange={(checked) => void toggle(checked)}
                >
                  Notify me when a task needs you
                </CheckChip>
              </div>
            </>
          )}
        </fieldset>
      </div>
    </div>
  );
}
