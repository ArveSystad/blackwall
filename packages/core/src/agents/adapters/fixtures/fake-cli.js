// A stand-in agent CLI for tests: `node fake-cli.js <mode> [fixture] ...ignored CLI args`.
//   replay <fixture>  prints the fixture's lines, then exits with code 0
//   echo              reads stdin and returns it as the result text, with argv as structured output
//   hang              spawns a sleeping grandchild, reports its pid as the session id, then hangs
//   fail              writes to stderr and exits with code 3 without a result
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
}
