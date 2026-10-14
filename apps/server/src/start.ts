import { existsSync } from "node:fs";
import {
  acquireDataDirLock,
  createAgentService,
  createBacklogRunner,
  createBranchDiff,
  createChatService,
  createCiWatcher,
  createClaudeAdapter,
  createConnectionService,
  createConnectionTokens,
  createCopilotAdapter,
  createDataService,
  createOpencodeAdapter,
  createDefaultStages,
  createDeliverer,
  createGitService,
  createKeyringSecretStore,
  createPipelineEngine,
  createQuotaTracker,
  createRepoService,
  createRepositories,
  createSearch,
  createSettingsService,
  createSystemService,
  createTaskArtifacts,
  createTaskDiffs,
  createWorkspacePreparer,
  createWorkspaceRemover,
  detectClis,
  openDatabase,
  sqliteOf,
} from "@blackwall/core";
import { parseRemoteSlug, testConnection } from "@blackwall/integrations";
import { ROLE_STAGES, type ServerEvent, type TaskOrigin } from "@blackwall/shared";
import { promoteBacklogItem } from "./backlog.js";
import type { ServerConfig } from "./config.js";
import { createGitHubOrigin, firstBranchFor, firstOriginContext } from "./github.js";
import { createJiraOrigin } from "./jira.js";
import { HOSTNAME, startServer } from "./server.js";
import { createShutdown } from "./shutdown.js";

export type BlackwallConfig = Pick<ServerConfig, "port" | "dev" | "webDevOrigin" | "dataDir">;

export interface RunningBlackwall {
  /** URL that swaps the per-launch token for a session cookie. */
  launchUrl: string;
  /** Port the server listens on. */
  port: number;
  /** Agent steps currently running. */
  runningAgents(): number;
  /** Runs the shutdown hooks once; later calls return the same promise. */
  shutdown(): Promise<void>;
}

/**
 * Opens the database, wires the services and starts the HTTP server. Shared by
 * `pnpm start` (`index.ts`) and the desktop shell (`desktop-entry.ts`). Prints
 * nothing and never exits the process; on error the shutdown hooks run and the
 * error is rethrown.
 */
export async function startBlackwall(config: BlackwallConfig): Promise<RunningBlackwall> {
  const shutdown = createShutdown();
  try {
    // First: a second instance would otherwise interrupt this one's steps through `recover()`.
    const lock = acquireDataDirLock(
      config.dataDir,
      config.dev ? config.webDevOrigin : `http://${HOSTNAME}:${config.port}`,
    );
    shutdown.onShutdown(() => lock.release());
    // Runs in the background; the Settings screen shows the result.
    const clis = detectClis();
    const database = openDatabase(config.dataDir);
    shutdown.onShutdown(() => database.close());
    const repositories = createRepositories(database.db);
    const connectionTokens = createConnectionTokens({
      store: createKeyringSecretStore(),
      connections: repositories.connections,
    });
    const connections = createConnectionService({
      connections: repositories.connections,
      tokens: connectionTokens,
    });
    const git = createGitService();
    const repos = createRepoService({
      repos: repositories.repos,
      connections,
    });
    const agents = createAgentService({
      agents: repositories.agents,
      settings: repositories.settings,
      tags: repositories.tags,
      repos: repositories.repos,
      tasks: repositories.tasks,
      backlogItems: repositories.backlogItems,
      transaction: repositories.transaction,
    });
    // First start: the built-in agents, their role defaults and the finding tags.
    agents.seed();
    const settings = createSettingsService({
      settings: repositories.settings,
      tags: repositories.tags,
    });

    let broadcast: (event: ServerEvent) => void = () => undefined;
    // Engine and quota events also reach the backlog runner.
    const publish = (event: ServerEvent) => {
      broadcast(event);
      backlogRunner.handleEvent(event);
    };
    const quota = createQuotaTracker({
      settings: repositories.settings,
      onChange: (state) => publish({ type: "quota.changed", payload: { quota: state } }),
    });
    const jira = createJiraOrigin({ connections });
    const github = createGitHubOrigin({ connections });
    const newTask = {
      repos,
      resolveRoles: agents.resolveRoles,
      resolveClis: agents.resolveClis,
      originTitle: async (origin: TaskOrigin) =>
        (await jira.titleFor(origin)) ?? (await github.titleFor(origin)),
      commentOnIssue: github.commentOnIssue,
      assignIssue: github.assignIssue,
      pullRequestStack: github.pullRequestStack,
    };
    // Uses the engine only once started, after the engine below exists.
    const backlogRunner = createBacklogRunner({
      repositories,
      createTask: async (item) =>
        promoteBacklogItem(item, {
          pipeline,
          newTask,
          backlogItems: repositories.backlogItems,
          broadcast: publish,
        }),
      resumeTask: (taskId) => void pipeline.resume(taskId),
      settings,
      quota,
      clisFor: (item) =>
        agents.clisFor(
          agents.resolveRoles(item.agents),
          item.agentClis,
          repositories.repos.get(item.repoId)?.defaultCli ?? "claude",
        ),
      onHalt: (repoId) => publish({ type: "backlog.changed", payload: { repoId } }),
    });
    // Watches CI on commits tasks push to GitHub/GHE; never opens the token modal.
    const ciWatcher = createCiWatcher({
      repositories,
      git,
      parseRemote: parseRemoteSlug,
      ports: { readChecks: github.ciChecks, logTail: github.ciLogTail },
      publish,
    });
    shutdown.onShutdown(() => ciWatcher.stop());
    const adapters = {
      claude: createClaudeAdapter(),
      copilot: createCopilotAdapter(),
      opencode: createOpencodeAdapter(),
    };
    const pipeline = createPipelineEngine({
      repositories,
      invocation: agents.invocation,
      adapters,
      stages: createDefaultStages({
        originContext: firstOriginContext(jira.originContext, github.originContext),
        stackContext: github.stackContext,
        git,
        reviewGit: git,
      }),
      prepareWorkspace: createWorkspacePreparer({
        git,
        repos: repositories.repos,
        branchFor: firstBranchFor(jira.branchFor, github.branchFor),
        baseBranchFor: github.baseBranchFor,
      }),
      removeWorkspace: createWorkspaceRemover({ git, repos: repositories.repos }),
      delivery: createDeliverer({
        git,
        repositories,
        ports: {
          parseRemote: parseRemoteSlug,
          jiraIssueUrl: jira.issueUrl,
          openPullRequest: (_task, action) => github.openPullRequest(action),
          commentOnPullRequest: github.commentOnPullRequest,
          commentOnJiraIssue: jira.commentOnIssue,
          commentOnGitHubIssue: github.commentOnIssue,
          reviewPullRequest: github.reviewPullRequest,
        },
        // The backlog runner picks up the follow-ups `create-tasks` adds.
        onBacklogChanged: (repoId) => publish({ type: "backlog.changed", payload: { repoId } }),
      }),
      maxTasksPerRepo: settings.maxTasksPerRepo,
      quota,
      publish,
      pathExists: existsSync,
      ci: ciWatcher,
    });
    // Runs before the database closes: kills the agent CLIs and marks their steps interrupted.
    shutdown.onShutdown(() => pipeline.shutdown());
    // Registered after the engine's hook, so it runs first: no promotions while tasks are aborted.
    shutdown.onShutdown(() => backlogRunner.stop());
    const chat = createChatService({
      adapters,
      repos: repositories.repos,
      tasks: repositories.tasks,
      backlogItems: repositories.backlogItems,
      messages: repositories.chatMessages,
      // The planner's model on the CLI, so the chat answers like the agent that plans.
      modelFor: (cli) => {
        const planner = agents.resolveRoles().planner;
        if (typeof planner !== "string") return undefined;
        try {
          return agents.invocation(planner, ROLE_STAGES.planner, cli).model ?? undefined;
        } catch {
          return undefined;
        }
      },
      publish,
    });
    shutdown.onShutdown(() => chat.shutdown());
    const data = createDataService({
      sqlite: sqliteOf(database.db),
      dataDir: config.dataDir,
      repositories,
      pipeline,
      tokens: connectionTokens,
      // Nothing promotes or answers while the rows are replaced; chats would refer to old data.
      pause: async () => {
        chat.reset();
        ciWatcher.stop();
        await backlogRunner.stop();
      },
      resume: () => {
        backlogRunner.start();
        void ciWatcher.recover();
      },
      publish,
      pathExists: existsSync,
    });

    const {
      launchUrl,
      port: actualPort,
      broadcast: send,
    } = await startServer({
      port: config.port,
      dev: config.dev,
      webDevOrigin: config.webDevOrigin,
      connections: { connections, test: testConnection },
      repos,
      agents,
      settings,
      tasks: {
        tasks: repositories.tasks,
        grillQuestions: repositories.grillQuestions,
        findings: repositories.findings,
        runs: repositories.runs,
        steps: repositories.steps,
        stepEvents: repositories.stepEvents,
      },
      pipeline,
      taskServices: {
        newTask,
        diffs: createTaskDiffs({ repositories, git }),
        branchDiff: createBranchDiff({ git, repositories }),
        artifacts: createTaskArtifacts(),
      },
      backlog: {
        backlogItems: repositories.backlogItems,
        repos: repositories.repos,
        tasks: repositories.tasks,
        runner: settings,
        onChanged: () => backlogRunner.poke(),
      },
      chat,
      quota,
      clis: () => clis,
      data,
      system: createSystemService({
        dataDir: config.dataDir,
        db: database.db,
        tasks: repositories.tasks,
      }),
      search: createSearch(database.db),
      shutdown,
    });
    broadcast = send;
    // Steps left running by a previous process become interrupted (resumable); queued tasks start.
    pipeline.recover();
    // CI watches a previous process left pending resume, or time out.
    void ciWatcher.recover();
    backlogRunner.start();
    return {
      launchUrl,
      port: actualPort,
      runningAgents: () => repositories.steps.listActiveAgents().length,
      shutdown: () => shutdown.run(),
    };
  } catch (error) {
    await shutdown.run();
    throw error;
  }
}
