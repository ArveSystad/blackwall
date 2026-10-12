// A stand-in agent CLI for tests: `node fake-cli.js <mode> [fixture] ...ignored CLI args`.
//   replay <fixture>  prints the fixture's lines, then exits with code 0
//   replay-resume <new> <resumed>
//                     replays <resumed> when the args contain --resume or --session, else <new>
//   copilot-echo      Copilot JSONL messages: stdin, the auth env vars, the --plugin-dir and
//                     whether its worker agent file exists, then argv (the final text)
//   opencode-echo     OpenCode JSON events, one step with text parts: stdin, argv, PWD and the
//                     config env vars, $XDG_CONFIG_HOME/git/config (or null) and whether
//                     $XDG_CONFIG_HOME/opencode exists (the final text); no closing line
//   opencode-locked <marker>
//                     fails like OpenCode on a locked database (exit 1) unless <marker> exists,
//                     which it creates; then behaves like opencode-echo
//   echo              reads stdin and returns it as the result text, with argv as structured output
//   hang              spawns a sleeping grandchild, reports its pid as the session id, then hangs
//   fail              writes to stderr and exits with code 3 without a result
//   limit             writes a rate-limit error to stderr and exits with code 1 without a result
// Any mode first writes $FAKE_CLI_STDERR to stderr when it is set.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, fixture] = process.argv.slice(2);
const print = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (process.env.FAKE_CLI_STDERR) process.stderr.write(`${process.env.FAKE_CLI_STDERR}\n`);

const locked = mode === "opencode-locked" && !existsSync(fixture);
if (locked) writeFileSync(fixture, "");

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

if (mode === "replay") {
  process.stdout.write(readFileSync(fixture, "utf8"));
} else if (mode === "replay-resume") {
  const resumed = process.argv.includes("--resume") || process.argv.includes("--session");
  process.stdout.write(readFileSync(process.argv[resumed ? 4 : 3], "utf8"));
} else if (locked) {
  process.stderr.write("Error: Unexpected error\n\ndatabase is locked\n");
  process.exitCode = 1;
} else if (mode === "opencode-echo" || mode === "opencode-locked") {
  const input = await readStdin();
  const args = process.argv.slice(3);
  const session = args.indexOf("--session");
  const sessionID = session === -1 ? "ses_fake" : args[session + 1];
  const home = process.env.XDG_CONFIG_HOME;
  const gitConfig = home && existsSync(join(home, "git", "config"));
  const text = (value) =>
    print({ type: "text", sessionID, part: { type: "text", text: JSON.stringify(value) } });
  print({ type: "step_start", sessionID, part: { type: "step-start" } });
  print({ type: "text", sessionID, part: { type: "text", text: input } });
  text(args);
  text({
    PWD: process.env.PWD,
    OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
    OPENCODE_DISABLE_PROJECT_CONFIG: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
    XDG_CONFIG_HOME: home,
    gitConfig: gitConfig ? readFileSync(join(home, "git", "config"), "utf8") : null,
    opencodeDir: Boolean(home && existsSync(join(home, "opencode"))),
  });
  print({
    type: "step_finish",
    sessionID,
    part: { type: "step-finish", reason: "stop", tokens: { input: 1, output: 1 }, cost: 0 },
  });
} else if (mode === "copilot-echo") {
  const input = await readStdin();
  const args = process.argv.slice(3);
  const id = args[args.findIndex((a) => a === "--session-id" || a === "--resume") + 1];
  print({ type: "session.tools_updated", data: { model: "fake" }, ephemeral: true });
  const env = { token: process.env.COPILOT_GITHUB_TOKEN, host: process.env.COPILOT_GH_HOST };
  print({ type: "assistant.message", data: { content: input } });
  print({ type: "assistant.message", data: { content: JSON.stringify(env) } });
  const plugin = args.includes("--plugin-dir") ? args[args.indexOf("--plugin-dir") + 1] : null;
  const worker = Boolean(plugin && existsSync(join(plugin, "agents", "blackwall-worker.agent.md")));
  print({ type: "assistant.message", data: { content: JSON.stringify({ plugin, worker }) } });
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
