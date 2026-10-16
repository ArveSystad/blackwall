import { toggleChat, useChatLayout } from "../chat";
import { cn } from "../lib/utils";
import { ChatIcon } from "./icons";
import { Button } from "./ui/button";

/** Top bar button that opens and closes the chat panel; `C` does the same anywhere. */
export function ChatToggle({ className }: { className?: string }) {
  const { open } = useChatLayout();
  return (
    <Button
      id="chat-toggle"
      variant="ghost"
      size="icon"
      // Pressed looks like the top bar's active Stats and Settings buttons.
      className={cn(
        "aria-pressed:bg-muted aria-pressed:text-foreground-strong aria-pressed:[--bw-chamfer-line:var(--border-strong)]",
        className,
      )}
      aria-label="Chat"
      aria-pressed={open}
      aria-keyshortcuts="C"
      title={open ? "Close chat (C)" : "Open chat (C)"}
      onClick={() => toggleChat()}
    >
      <ChatIcon />
    </Button>
  );
}
