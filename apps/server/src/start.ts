import { existsSync } from "node:fs";
import { join } from "node:path";
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
  createMemoryBackfill,
  createMemoryReleaser,
  createPipelineEngine,
  createQuotaTracker,
  createRepoService,
  createRepositories,
  createSearch,
  createSettingsService,
  createSystemService,
  createTaskArtifacts,
  createVoiceCommandService,
  createVoiceModelDownloads,
  createVoiceService,
  createTaskDiffs,
  createPrHeadSync,
  createWorkspacePreparer,
  createWorkspaceRemover,
  createWorkspaceSyncer,
  createWorktreeSetup,
  detectClis,
  openDatabase,
  sqliteOf,
  VoiceToolError,
} from "@blackwall/core";
import { parseRemoteSlug, testConnection } from "@blackwall/integrations";
import {
  newBacklogItemInputSchema,
  ROLE_STAGES,
  type AgentCli,
  type ServerEvent,
  type TaskOrigin,
} from "@blackwall/shared";
import {
  addBacklogItem,
  importRemoteIssue,
  promoteBacklogItem,
  type BacklogRouteOptions,
} from "./backlog.js";
import type { ServerConfig } from "./config.js";
import {
  createGitHubOrigin,
  createRepoIssueSource,
  firstBranchFor,
  firstOriginContext,
} from "./github.js";
import { createJiraIssueSource, createJiraOrigin } from "./jira.js";
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
    const repoIssues = createRepoIssueSource({ connections });
    const jiraIssues = createJiraIssueSource({ connections });
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
      importRemoteIssue: (repo) =>
        importRemoteIssue(
          { backlogItems: repositories.backlogItems, tasks: repositories.tasks },
          {
            listIssues: repoIssues.listRepoIssues,
            viewerLogin: repoIssues.viewerLogin,
            listJiraIssues: jiraIssues.listRepoJiraIssues,
            broadcast: publish,
          },
          repo,
        ),
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
    // Releases PR tasks' memories once their pull request merges into the default branch.
    const memoryReleaser = createMemoryReleaser({
      repositories,
      prMergeState: github.pullRequestMergeState,
    });
    memoryReleaser.start();
    shutdown.onShutdown(() => memoryReleaser.stop());
    const adapters = {
      claude: createClaudeAdapter(),
      copilot: createCopilotAdapter(),
      opencode: createOpencodeAdapter(),
    };
    // Learns notes from a repo's past tasks, on the user's request.
    const memoryBackfill = createMemoryBackfill({
      repositories,
      adapters,
      agents,
      prMergeState: github.pullRequestMergeState,
      onHeld: () => {
        memoryReleaser
          .check()
          .catch((error: unknown) =>
            console.error(
              `Memory release failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
      },
    });
    shutdown.onShutdown(() => memoryBackfill.stop());
    const pipeline = createPipelineEngine({
      repositories,
      invocation: agents.invocation,
      adapters,
      stages: createDefaultStages({
        originContext: firstOriginContext(jira.originContext, github.originContext),
        stackContext: github.stackContext,
        prCommentsContext: github.prCommentsContext,
        git,
        reviewGit: git,
        checksGit: git,
      }),
      prepareWorkspace: createWorkspacePreparer({
        git,
        repos: repositories.repos,
        branchFor: firstBranchFor(jira.branchFor, github.branchFor),
        baseBranchFor: github.baseBranchFor,
      }),
      syncWorkspace: createWorkspaceSyncer({ git, repos: repositories.repos }),
      removeWorkspace: createWorkspaceRemover({ git, repos: repositories.repos }),
      prHead: createPrHeadSync({ git, repos: repositories.repos }),
      // Uses the chat only once a task is deleted, after the chat below exists.
      beforeDelete: (taskId) => chat.forgetTask(taskId),
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
      prFeedback: github.pullRequestFeedback,
      prBranchOwned: github.prBranchOwned,
      worktreeGuard: git,
      setup: createWorktreeSetup({ git }),
      // Autonomous mode covers the repo's backlog tasks only, read live at each gate.
      autonomous: (task) =>
        settings.repoBacklogRunner(task.repoId).autonomous &&
        repositories.backlogItems.list(task.repoId).some((item) => item.taskId === task.id),
    });
    // Runs before the database closes: kills the agent CLIs and marks their steps interrupted.
    shutdown.onShutdown(() => pipeline.shutdown());
    // Registered after the engine's hook, so it runs first: no promotions while tasks are aborted.
    shutdown.onShutdown(() => backlogRunner.stop());
    // The planner's model on the CLI, so the chat and voice answer like the agent that plans.
    const modelFor = (cli: AgentCli) => {
      const planner = agents.resolveRoles().planner;
      if (typeof planner !== "string") return undefined;
      try {
        return agents.invocation(planner, ROLE_STAGES.planner, cli).model ?? undefined;
      } catch {
        return undefined;
      }
    };
    const chat = createChatService({
      adapters,
      repos: repositories.repos,
      tasks: repositories.tasks,
      questions: repositories.grillQuestions,
      backlogItems: repositories.backlogItems,
      memories: repositories.memories,
      messages: repositories.chatMessages,
      modelFor,
      publish,
    });
    shutdown.onShutdown(() => chat.shutdown());
    const backlog: BacklogRouteOptions = {
      backlogItems: repositories.backlogItems,
      repos: repositories.repos,
      tasks: repositories.tasks,
      runner: settings,
      onChanged: () => backlogRunner.poke(),
    };
    // Set once the server listens; voice turns start only after that.
    let port = config.port;
    const modelsDir = join(config.dataDir, "models");
    const voice = createVoiceService({
      modelsDir,
      modelId: () => settings.general().voiceModel,
    });
    const voiceDownloads = createVoiceModelDownloads({ modelsDir, publish });
    shutdown.onShutdown(() => voiceDownloads.shutdown());
    const voiceCommands = createVoiceCommandService({
      adapters,
      repos: repositories.repos,
      tasks: repositories.tasks,
      questions: repositories.grillQuestions,
      answerQuestion: (taskId, questionId, answer) =>
        pipeline.answerQuestion(taskId, questionId, { answer }),
      // No issue comment, like the task view's unticked default.
      approvePlan: (taskId) =>
        pipeline.respond(taskId, { gate: "plan-approval", decision: "approve" }),
      sendChat: chat.send,
      backlogItems: repositories.backlogItems,
      runner: settings,
      runBacklogItem: (repoId, itemId) => {
        const item = repositories.backlogItems.get(itemId);
        if (!item || item.repoId !== repoId || item.status !== "waiting") {
          throw new VoiceToolError("The backlog item is not waiting in this repo");
        }
        return promoteBacklogItem(item, {
          pipeline,
          newTask,
          backlogItems: repositories.backlogItems,
          broadcast: publish,
        });
      },
      // The same path as the New task form; `publish` also tells the backlog runner.
      submitTask: (repoId, input) => {
        const parsed = newBacklogItemInputSchema.safeParse(input);
        if (!parsed.success) {
          throw new VoiceToolError(parsed.error.issues[0]?.message ?? "Invalid task");
        }
        return addBacklogItem(
          backlog,
          { broadcast: publish, pipeline, newTask, runner: settings },
          repoId,
          parsed.data,
        );
      },
      modelFor,
      mcpUrl: () => `http://${HOSTNAME}:${port}/mcp`,
      publish,
    });
    shutdown.onShutdown(() => voiceCommands.shutdown());
    const data = createDataService({
      sqlite: sqliteOf(database.db),
      dataDir: config.dataDir,
      repositories,
      pipeline,
      tokens: connectionTokens,
      // Nothing promotes or answers while the rows are replaced; chats would refer to old data.
      pause: async () => {
        chat.reset();
        voiceCommands.reset();
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
        prComments: github.pullRequestComments,
        artifacts: createTaskArtifacts(),
      },
      backlog,
      memories: {
        memories: repositories.memories,
        repos: repositories.repos,
        backfill: memoryBackfill,
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
      voice,
      voiceCommands,
      voiceDownloads,
      shutdown,
    });
    broadcast = send;
    port = actualPort;
    // Steps left running by a previous process become interrupted (resumable); queued tasks start.
    pipeline.recover();
    // CI watches a previous process left pending resume, or time out.
    void ciWatcher.recover();
    backlogRunner.start();
    // Autonomous repos' tasks left waiting at a gate by the previous process move on.
    for (const repo of repositories.repos.list()) void pipeline.autopilotRepo(repo.id);
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
