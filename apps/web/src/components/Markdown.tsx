import { lazy, Suspense, type ComponentProps } from "react";
import { cn } from "../lib/utils";

// Lazy so react-markdown and remark-gfm stay out of the main chunk (the chat imports this eagerly).
const MarkdownRenderer = lazy(() =>
  import("./MarkdownRenderer").then((m) => ({ default: m.MarkdownRenderer })),
);

/** Agent-written markdown in token styles; plain text until the renderer chunk has loaded. */
export function Markdown(props: ComponentProps<typeof MarkdownRenderer>) {
  const { children, className } = props;
  return (
    <Suspense
      fallback={
        <div
          className={cn(
            "flex flex-col gap-2.5 whitespace-pre-wrap text-body text-foreground",
            className,
          )}
        >
          {children}
        </div>
      }
    >
      <MarkdownRenderer {...props} />
    </Suspense>
  );
}
