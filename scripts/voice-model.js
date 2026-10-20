// `pnpm voice:model [model-id]`: downloads a sherpa-onnx speech model for voice control into
// `<dataDir>/models/<archive>` (`BLACKWALL_HOME`, default `~/.blackwall`), the folder the server
// reads it from. Defaults to the default model; skips a model that is already there. The install
// runs through `@blackwall/core`'s `installVoiceModel`, the same code as Settings → Voice, loaded
// from `packages/core/dist`; the workspace is built first if its output is missing or stale.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureBuilt } from "./start.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Model id → release archive name. Mirrors `VOICE_MODELS` in `@blackwall/shared`. */
export const ARCHIVES = {
  "moonshine-tiny-en": "sherpa-onnx-moonshine-tiny-en-int8",
  "whisper-small": "sherpa-onnx-whisper-small",
};
export const DEFAULT_MODEL = "moonshine-tiny-en";

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

const MB = 1024 * 1024;

/** Logs download progress at most once per 10%, or per 50 MB when the size is unknown. */
function progressLogger() {
  let logged = 0;
  return (progress) => {
    if (progress.phase === "unpacking") {
      console.log("Unpacking…");
      return;
    }
    const { receivedBytes, totalBytes } = progress;
    const step = totalBytes
      ? Math.floor((receivedBytes / totalBytes) * 10)
      : Math.floor(receivedBytes / (50 * MB));
    if (step <= logged) return;
    logged = step;
    const received = Math.round(receivedBytes / MB);
    console.log(
      totalBytes
        ? `  ${received} of ${Math.round(totalBytes / MB)} MB (${step * 10}%)`
        : `  ${received} MB`,
    );
  };
}

async function main(id = DEFAULT_MODEL) {
  // Validates the id before any build.
  const target = modelDirFor(process.env, homedir(), id);
  ensureBuilt();
  // A file: URL, since Windows absolute paths are not valid import specifiers.
  const { installVoiceModel, isVoiceModelInstalled, voiceModelUrl } = await import(
    pathToFileURL(join(ROOT, "packages/core/dist/voice/install.js")).href
  );
  const modelsDir = dirname(target);
  if (!isVoiceModelInstalled(modelsDir, id)) console.log(`Downloading ${voiceModelUrl(id)}`);
  const result = await installVoiceModel({ modelsDir, id, onProgress: progressLogger() });
  if (result === "already-installed") {
    console.log(`The ${id} model is already installed at ${target}`);
    return;
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
