import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JiraClient } from "./client.js";
import type { AttachmentOutcome, JiraAttachment } from "./issue.js";

/** Scratch folder in a task's worktree; ignored by its own `.gitignore`. */
export const SCRATCH_DIR = ".blackwall";

export interface AttachmentLimits {
  /** Largest single file downloaded. */
  maxFileBytes: number;
  /** Total bytes downloaded per issue. */
  maxTotalBytes: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
};

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/sql",
  "application/x-sh",
  "application/javascript",
  "application/typescript",
]);

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "log",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "yml",
  "sql",
  "html",
  "har",
  "diff",
  "patch",
]);

/** Images, PDFs and text files are downloaded; anything else is only listed. */
export function isSupportedAttachment({ mimeType, filename }: JiraAttachment): boolean {
  const mime = mimeType.toLowerCase().split(";")[0]!.trim();
  if (mime.startsWith("image/") || mime.startsWith("text/") || mime === "application/pdf") {
    return true;
  }
  if (TEXT_MIME_TYPES.has(mime)) return true;
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  return ext !== undefined && TEXT_EXTENSIONS.has(ext);
}

/** A file name safe on every OS, without directories. */
export function safeFileName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned || fallback;
}

function formatLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

/** Creates the worktree's scratch folder with a `.gitignore` that ignores everything in it. */
export async function ensureScratchDir(worktreePath: string): Promise<string> {
  const dir = join(worktreePath, SCRATCH_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "*\n", { flag: "w" });
  return dir;
}

export interface DownloadAttachmentsOptions {
  worktreePath: string;
  limits?: AttachmentLimits;
  signal?: AbortSignal;
}

/**
 * Downloads an issue's image, PDF and text attachments into
 * `<worktree>/.blackwall/jira/<KEY>/`, skipping unsupported types and files
 * over the size caps. Paths in the outcomes are worktree-relative with `/`.
 * A failed download is reported as skipped rather than failing the task.
 */
export async function downloadJiraAttachments(
  client: Pick<JiraClient, "downloadAttachment">,
  key: string,
  attachments: readonly JiraAttachment[],
  { worktreePath, limits = DEFAULT_ATTACHMENT_LIMITS, signal }: DownloadAttachmentsOptions,
): Promise<AttachmentOutcome[]> {
  if (attachments.length === 0) return [];
  await ensureScratchDir(worktreePath);
  const relDir = `${SCRATCH_DIR}/jira/${safeFileName(key, "issue")}`;
  const dir = join(worktreePath, ...relDir.split("/"));
  await mkdir(dir, { recursive: true });

  const outcomes: AttachmentOutcome[] = [];
  const used = new Set<string>();
  let total = 0;
  for (const attachment of attachments) {
    const skip = (reason: string) => outcomes.push({ attachment, saved: false, reason });
    if (!isSupportedAttachment(attachment)) {
      skip("not an image, PDF or text file");
      continue;
    }
    if (attachment.size > limits.maxFileBytes) {
      skip(`larger than the ${formatLimit(limits.maxFileBytes)} limit`);
      continue;
    }
    const remaining = limits.maxTotalBytes - total;
    if (attachment.size > remaining) {
      skip(`the ${formatLimit(limits.maxTotalBytes)} total download limit is reached`);
      continue;
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = await client.downloadAttachment(
        attachment.id,
        Math.min(limits.maxFileBytes, remaining),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      skip(`download failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!bytes) {
      skip("larger than the size limit");
      continue;
    }
    let name = safeFileName(attachment.filename, attachment.id);
    if (used.has(name.toLowerCase())) name = `${attachment.id}-${name}`;
    used.add(name.toLowerCase());
    await writeFile(join(dir, name), bytes);
    total += Math.max(bytes.byteLength, attachment.size);
    outcomes.push({ attachment, saved: true, path: `${relDir}/${name}` });
  }
  return outcomes;
}
