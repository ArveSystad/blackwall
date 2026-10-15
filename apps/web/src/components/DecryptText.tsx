import { useDecrypt } from "./use-decrypt";

/**
 * `text` with a decrypt `frame` drawn over it (see `.bw-decrypt*` in
 * styles.css). The real text stays in flow, so it sets the width and stays in
 * the accessibility tree; it is only transparent while scrambling. The glyphs
 * are an `aria-hidden` overlay that inherits the text's typography.
 */
export function DecryptGlyphs({
  text,
  frame,
  className,
}: {
  text: string;
  frame: string | null;
  className?: string | undefined;
}) {
  return (
    <span
      className={className ? `bw-decrypt ${className}` : "bw-decrypt"}
      data-scrambling={frame ? "" : undefined}
    >
      <span className="bw-decrypt-text">{text}</span>
      {frame && (
        <span className="bw-decrypt-glyphs" aria-hidden="true">
          {frame}
        </span>
      )}
    </span>
  );
}

/** `text` that decrypts on mount and whenever `trigger` changes (see `useDecrypt`). */
export function DecryptText({
  text,
  trigger,
  className,
}: {
  text: string;
  trigger: string | number | null;
  className?: string | undefined;
}) {
  const frame = useDecrypt(text, trigger);
  return <DecryptGlyphs text={text} frame={frame} className={className} />;
}
