// `pnpm --filter @blackwall/core inspect:task <task-id | title-substring>`: prints a task, its
// runs, steps and `delivery.*` events from the live database. Opens the database read-only and
// never runs migrations, so it is safe to use while the server is running.
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error("usage: inspect-task <task-id | title-substring>");
  process.exit(1);
}

// Mirrors `resolveDataDir` and `DB_FILENAME` in src/db/database.ts.
const dataDir = process.env.BLACKWALL_HOME || join(homedir(), ".blackwall");
const db = new Database(join(dataDir, "blackwall.db"), { readonly: true, fileMustExist: true });

const time = (ms) => (ms == null ? "-" : new Date(ms).toISOString());

const tasks = db
  .prepare(
    `SELECT id, title, status, gate, stage, error, branch, worktree_path, delivery_targets,
            created_at, updated_at
       FROM tasks WHERE id = ? OR title LIKE ? ORDER BY created_at`,
  )
  .all(query, `%${query}%`);
if (tasks.length === 0) {
  console.error(`no task matches "${query}"`);
  process.exit(1);
}

for (const task of tasks) {
  console.log(`\n=== ${task.id}  ${task.title}`);
  console.log(`status:   ${task.status}  stage: ${task.stage ?? "-"}  gate: ${task.gate ?? "-"}`);
  console.log(`error:    ${task.error ?? "-"}`);
  console.log(`branch:   ${task.branch ?? "-"}`);
  console.log(`worktree: ${task.worktree_path ?? "-"}`);
  console.log(`delivery: ${task.delivery_targets}`);
  console.log(`created:  ${time(task.created_at)}  updated: ${time(task.updated_at)}`);

  const runs = db
    .prepare(
      `SELECT id, number, status, created_at, finished_at FROM runs WHERE task_id = ? ORDER BY number`,
    )
    .all(task.id);
  for (const run of runs) {
    console.log(
      `\n-- run ${run.number} (${run.status})  ${time(run.created_at)} → ${time(run.finished_at)}`,
    );
    const steps = db
      .prepare(
        `SELECT id, stage, agent_id, round, visit, status, error, started_at, finished_at
           FROM steps WHERE run_id = ? ORDER BY created_at`,
      )
      .all(run.id);
    for (const step of steps) {
      console.log(
        `   ${step.stage.padEnd(10)} ${step.status.padEnd(9)} agent=${step.agent_id ?? "-"} ` +
          `round=${step.round} visit=${step.visit}  ${time(step.started_at)} → ${time(step.finished_at)}`,
      );
      if (step.error) console.log(`      error: ${step.error}`);
      const events = db
        .prepare(
          `SELECT seq, type, payload, created_at FROM step_events
            WHERE step_id = ? AND type LIKE 'delivery.%' ORDER BY seq`,
        )
        .all(step.id);
      for (const event of events) {
        console.log(`      #${event.seq} ${time(event.created_at)} ${event.type} ${event.payload}`);
      }
    }
  }
}

db.close();
