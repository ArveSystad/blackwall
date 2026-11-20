import type { Element as HastElement } from "hast";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ElementType,
  type JSX,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";
import { codeBlock } from "./classes";
import { codeLanguage, svgDataUrl, svgIllustration } from "./svg-illustration";
import { Button } from "./ui/button";

/** True inside a fenced block, so `code` drops its inline chip styling. */
const InPre = createContext(false);

/** Set when ```svg fences show as illustrations; null keeps them as code. */
const Illustrations = createContext<{ onResize?: (() => void) | undefined } | null>(null);

/** The language and text of a fenced block's hast `pre`, or null when it holds no `code`. */
function fence(
  node: HastElement | undefined,
): { language: string | undefined; source: string } | null {
  const child = node?.children.find((c): c is HastElement => c.type === "element");
  if (child?.tagName !== "code") return null;
  const source = child.children.map((c) => (c.type === "text" ? c.value : "")).join("");
  return { language: codeLanguage(child.properties.className), source };
}

/**
 * A ```svg fence drawn as an image, with a Source toggle. The SVG only ever loads through `<img>`
 * from a data URL, so it can't run script or fetch anything; the markup never enters the DOM.
 */
export function SvgFigure({
  source,
  alt,
  onResize,
}: {
  source: string;
  alt: string;
  onResize?: (() => void) | undefined;
}) {
  const [showSource, setShowSource] = useState(false);
  const url = useMemo(() => svgDataUrl(source), [source]);
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);
  // The Source toggle changes the height; skip the mount run, which changes nothing.
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) onResizeRef.current?.();
    mounted.current = true;
  }, [showSource]);

  return (
    <figure className="bw-chamfer-box m-0 flex flex-col gap-1.5 bg-code p-2 [--bw-chamfer-line:var(--border)]">
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={showSource}
          onClick={() => setShowSource((shown) => !shown)}
        >
          Source
        </Button>
      </div>
      {showSource ? (
        <InPre.Provider value={true}>
          <pre className={codeBlock}>
            <code className="language-svg">{source}</code>
          </pre>
        </InPre.Provider>
      ) : (
        <img
          src={url}
          alt={alt}
          onLoad={() => onResizeRef.current?.()}
          className="block h-auto max-h-[480px] w-auto max-w-full self-start"
        />
      )}
    </figure>
  );
}

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
  pre: function Pre(props) {
    const illustrations = useContext(Illustrations);
    const block = illustrations ? fence(props.node) : null;
    const language = block?.language;
    const source = block?.source ?? "";
    const svg = useMemo(
      () => (illustrations ? svgIllustration(language, source) : null),
      [illustrations, language, source],
    );
    if (svg)
      return <SvgFigure source={svg.source} alt={svg.alt} onResize={illustrations?.onResize} />;
    return (
      <InPre.Provider value={true}>
        <pre {...domProps(props)} className={codeBlock} />
      </InPre.Provider>
    );
  },
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

/**
 * Agent-written markdown in token styles. Raw HTML is deliberately not rendered. With
 * `illustrations` (chat only), well-formed ```svg fences show as an `<img>`, never as inline markup.
 */
export function MarkdownRenderer({
  children,
  className,
  illustrations = false,
  onIllustrationResize,
}: {
  children: string;
  className?: string;
  illustrations?: boolean;
  /** Called when an illustration's height changes (image loaded, Source toggled). */
  onIllustrationResize?: (() => void) | undefined;
}) {
  const context = useMemo(
    () => (illustrations ? { onResize: onIllustrationResize } : null),
    [illustrations, onIllustrationResize],
  );
  return (
    <div className={cn("flex flex-col gap-2.5 text-body text-foreground", className)}>
      <Illustrations.Provider value={context}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {children}
        </ReactMarkdown>
      </Illustrations.Provider>
    </div>
  );
}
