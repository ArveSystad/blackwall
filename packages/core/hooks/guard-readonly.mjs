// Claude Code PreToolUse hook keeping a read-only agent read-only under the
// Trusted level, where the repo's skills could grant more through their
// `allowed-tools`. A hook's deny beats every allow rule. Plain Node, no
// dependencies: Claude Code runs it as `"<node>" "<this file>"`, with the hook
// input on stdin and the allowed Bash prefixes in BLACKWALL_GUARD_ALLOW (a
// JSON array of strings; `*` allows any command). A missing or malformed list
// denies everything.

/** Tools that write files; never allowed. */
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/** Shell metacharacters that could chain, substitute or redirect a command. */
const SHELL_META = /[;&|`$()<>\r\n]/;

/** The allowed prefixes, or null when the list is missing or malformed. */
function allowedPrefixes(raw) {
  if (typeof raw !== "string") return null;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.every((p) => typeof p === "string" && p.trim() !== "")
      ? list.map((p) => p.trim())
      : null;
  } catch {
    return null;
  }
}

/** Why the tool call is refused, or null to let the CLI's own rules decide. */
function decide(input, prefixes) {
  if (!prefixes) return "the read-only guard has no allow list";
  const tool = typeof input?.tool_name === "string" ? input.tool_name : "";
  if (WRITE_TOOLS.has(tool)) return `${tool} is not allowed for a read-only agent`;
  if (tool !== "Bash") return null;
  const command = String(input?.tool_input?.command ?? "").trim();
  if (SHELL_META.test(command)) {
    return "read-only agents may run one plain command, without shell operators";
  }
  if (prefixes.includes("*")) return null;
  const allowed = prefixes.some((p) => command === p || command.startsWith(`${p} `));
  return allowed ? null : `read-only agents may only run: ${prefixes.join(", ")}`;
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Blackwall read-only guard: ${reason}`,
      },
    }),
  );
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    deny("the hook input was not JSON");
    return;
  }
  const reason = decide(input, allowedPrefixes(process.env.BLACKWALL_GUARD_ALLOW));
  if (reason) deny(reason);
});
