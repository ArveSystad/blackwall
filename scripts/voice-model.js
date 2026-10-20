// `pnpm voice:model [model-id]`: downloads a sherpa-onnx speech model for voice control into
// `<dataDir>/models/<archive>` (`BLACKWALL_HOME`, default `~/.blackwall`), the folder the server
// reads it from. Defaults to the default model; skips a model that is already there.
import { spawnSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/** Model id → release archive name. Mirrors `VOICE_MODELS` in `@blackwall/shared`. */
export const ARCHIVES = {
  "moonshine-tiny-en": "sherpa-onnx-moonshine-tiny-en-int8",
  "whisper-small": "sherpa-onnx-whisper-small",
};
export const DEFAULT_MODEL = "moonshine-tiny-en";
const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

/** Where a model unpacks to, resolving the data dir as the server does. Throws on an unknown id. */
export function modelDirFor(env, home, id) {
  const archive = ARCHIVES[id];
  if (!archive) {
    throw new Error(
      `Unknown voice model "${id}". Pick one of: ${Object.keys(ARCHIVES).join(", ")}`,
    );
  }
  return join(env.BLACKWALL_HOME || join(home, ".blackwall"), "models", archive);
}

async function main(id = DEFAULT_MODEL) {
  const target = modelDirFor(process.env, homedir(), id);
  if (existsSync(target)) {
    console.log(`The ${id} model is already installed at ${target}`);
    return;
  }
  const archive = ARCHIVES[id];
  const url = `${RELEASES}/${archive}.tar.bz2`;
  // Downloads and unpacks in a fresh temp folder, so a failure leaves no half-installed model.
  const temp = mkdtempSync(join(tmpdir(), "blackwall-voice-"));
  try {
    console.log(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
    const file = `${archive}.tar.bz2`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(join(temp, file)));
    // Relative paths: GNU tar reads `C:\…` as a remote host.
    const tar = spawnSync("tar", ["-xjf", file], { cwd: temp, stdio: "inherit" });
    if (tar.status !== 0 || !existsSync(join(temp, archive))) {
      throw new Error(
        `Could not unpack ${file}${tar.error ? `: ${tar.error.message}` : ""}. ` +
          "Unpacking needs tar with bzip2 support; on Linux, install bzip2 and try again.",
      );
    }
    rmSync(join(temp, file));
    mkdirSync(resolve(target, ".."), { recursive: true });
    cpSync(join(temp, archive), target, { recursive: true });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  console.log(`Installed the ${id} model at ${target}`);
  if (id !== DEFAULT_MODEL) console.log("Select it in Settings → Voice.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  try {
    await main(args[0]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
