// A stand-in agent CLI for tests: `node fake-cli.js <mode> [fixture] ...ignored CLI args`.
//   replay <fixture>  prints the fixture's lines, then exits with code 0
//   replay-resume <new> <resumed>
//                     replays <resumed> when the args contain --resume, else <new>
//   copilot-echo      Copilot JSONL messages: stdin, the auth env vars, then argv (the final text)
//   echo              reads stdin and returns it as the result text, with argv as structured output
//   hang              spawns a sleeping grandchild, reports its pid as the session id, then hangs
//   fail              writes to stderr and exits with code 3 without a result
//   limit             writes a rate-limit error to stderr and exits with code 1 without a result
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const [mode, fixture] = process.argv.slice(2);
const print = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

if (mode === "replay") {
  process.stdout.write(readFileSync(fixture, "utf8"));
} else if (mode === "replay-resume") {
  const resumed = process.argv.includes("--resume");
  process.stdout.write(readFileSync(process.argv[resumed ? 4 : 3], "utf8"));
} else if (mode === "copilot-echo") {
  const input = await readStdin();
  const args = process.argv.slice(3);
  const id = args[args.findIndex((a) => a === "--session-id" || a === "--resume") + 1];
  print({ type: "session.tools_updated", data: { model: "fake" }, ephemeral: true });
  const env = { token: process.env.COPILOT_GITHUB_TOKEN, host: process.env.COPILOT_GH_HOST };
  print({ type: "assistant.message", data: { content: input } });
  print({ type: "assistant.message", data: { content: JSON.stringify(env) } });
  print({ type: "assistant.message", data: { content: JSON.stringify(args) } });
  print({
    type: "result",
    sessionId: id,
    exitCode: 0,
  });
} else if (mode === "echo") {
  const input = await readStdin();
  print({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "echo",
    result: input,
    structured_output: process.argv.slice(3),
    usage: {},
  });
} else if (mode === "hang") {
  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  print({ type: "system", subtype: "init", session_id: String(grandchild.pid) });
  setInterval(() => {}, 60_000);
} else if (mode === "fail") {
  process.stderr.write("boom: not logged in\n");
  process.exitCode = 3;
} else if (mode === "limit") {
  process.stderr.write(
    "Error: 429 Too Many Requests: rate limit exceeded. Try again in 30 minutes.\n",
  );
  process.exitCode = 1;
}
