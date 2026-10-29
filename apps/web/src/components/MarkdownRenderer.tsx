import { createContext, useContext, type ComponentProps, type ElementType, type JSX } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";
import { codeBlock } from "./classes";

/** True inside a fenced block, so `code` drops its inline chip styling. */
const InPre = createContext(false);

/** Drops react-markdown's hast `node` prop so it never reaches the DOM. */
function domProps<P extends ExtraProps>(props: P): Omit<P, "node"> {
  const rest = { ...props };
  delete rest.node;
  return rest;
}

/** A react-markdown renderer for `Tag` with fixed token classes. */
function styled<T extends keyof JSX.IntrinsicElements>(Tag: T, className: string) {
  return function Styled(props: ComponentProps<T> & ExtraProps) {
    const Element = Tag as ElementType;
    return <Element {...domProps(props)} className={cn(className, props.className)} />;
  };
}

const heading = "m-0 text-body font-semibold text-foreground-strong [&:not(:first-child)]:mt-2";
const cell = "border border-border px-2 py-1 text-left";

const components: Components = {
  h1: styled("h1", cn(heading, "text-heading")),
  h2: styled("h2", heading),
  h3: styled("h3", heading),
  h4: styled("h4", heading),
  h5: styled("h5", heading),
  h6: styled("h6", heading),
  p: styled("p", "m-0"),
  ul: styled("ul", "m-0 flex list-disc flex-col gap-1.5 pl-[18px]"),
  ol: styled("ol", "m-0 flex list-decimal flex-col gap-1.5 pl-[18px]"),
  pre: (props) => (
    <InPre.Provider value={true}>
      <pre {...domProps(props)} className={codeBlock} />
    </InPre.Provider>
  ),
  code: function Code(props) {
    const inPre = useContext(InPre);
    return (
      <code
        {...domProps(props)}
        className={cn(
          !inPre && "bg-code-inline px-1 font-mono text-code text-foreground-strong",
          props.className,
        )}
      />
    );
  },
  a: (props) => (
    <a {...domProps(props)} className="text-primary underline" target="_blank" rel="noreferrer" />
  ),
  blockquote: styled("blockquote", "m-0 border-l-2 border-border pl-3 text-muted-foreground"),
  table: (props) => (
    <div className="overflow-x-auto">
      <table {...domProps(props)} className="border-collapse" />
    </div>
  ),
  th: styled("th", cn(cell, "font-semibold")),
  td: styled("td", cell),
  hr: styled("hr", "m-0 w-full border-border"),
  strong: styled("strong", "font-semibold text-foreground-strong"),
};

/** Agent-written markdown in token styles. Raw HTML is deliberately not rendered. */
export function MarkdownRenderer({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2.5 text-body text-foreground", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
