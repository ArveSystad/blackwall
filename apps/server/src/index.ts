import {
  createAgentService,
  createClaudeAdapter,
  createConnectionService,
  createConnectionTokens,
  createCopilotAdapter,
  createDefaultStages,
  createDeliverer,
  createGitService,
  createKeyringSecretStore,
  createPipelineEngine,
  createRepoService,
  createRepositories,
  createSettingsService,
  createTaskDiffs,
  createWorkspacePreparer,
  detectClis,
  openDatabase,
} from "@blackwall/core";
import { parseRemoteSlug, testConnection } from "@blackwall/integrations";
import type { ServerEvent } from "@blackwall/shared";
import { banner } from "./banner.js";
import { parseConfig } from "./config.js";
import { createGitHubOrigin, firstBranchFor, firstOriginContext } from "./github.js";
import { createJiraOrigin } from "./jira.js";
import { openBrowser } from "./open-browser.js";
import { startServer } from "./server.js";
import { createShutdown } from "./shutdown.js";

const config = parseConfig(process.argv.slice(2), process.env);
const shutdown = createShutdown();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown.run().then(() => process.exit(0));
  });
}

try {
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
  const repos = createRepoService({ repos: repositories.repos, connections });
  const agents = createAgentService({
    agents: repositories.agents,
    settings: repositories.settings,
    tags: repositories.tags,
  });
  // First start: the built-in agents, their role defaults and the finding tags.
  agents.seed();
  const settings = createSettingsService({
    settings: repositories.settings,
    tags: repositories.tags,
  });

  let broadcast: (event: ServerEvent) => void = () => undefined;
  const jira = createJiraOrigin({ connections });
  const github = createGitHubOrigin({ connections });
  const git = createGitService();
  const pipeline = createPipelineEngine({
    repositories,
    invocation: agents.invocation,
    adapters: { claude: createClaudeAdapter(), copilot: createCopilotAdapter() },
    stages: createDefaultStages({
      originContext: firstOriginContext(jira.originContext, github.originContext),
      git,
      reviewGit: git,
    }),
    prepareWorkspace: createWorkspacePreparer({
      git,
      repos: repositories.repos,
      branchFor: firstBranchFor(jira.branchFor, github.branchFor),
    }),
    delivery: createDeliverer({
      git,
      repositories,
      ports: {
        parseRemote: parseRemoteSlug,
        jiraIssueUrl: jira.issueUrl,
        openPullRequest: (_task, action) => github.openPullRequest(action),
        commentOnPullRequest: github.commentOnPullRequest,
        commentOnJiraIssue: jira.commentOnIssue,
        reviewPullRequest: github.reviewPullRequest,
      },
    }),
    maxTasksPerRepo: settings.maxTasksPerRepo,
    publish: (event) => broadcast(event),
  });
  // Runs before the database closes: kills the agent CLIs and marks their steps interrupted.
  shutdown.onShutdown(() => pipeline.shutdown());

  const { launchUrl, broadcast: send } = await startServer({
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
      newTask: {
        repos,
        resolveRoles: agents.resolveRoles,
        originTitle: async (origin) =>
          (await jira.titleFor(origin)) ?? (await github.titleFor(origin)),
      },
      diffs: createTaskDiffs({ repositories, git }),
    },
    backlog: {
      backlogItems: repositories.backlogItems,
      repos: repositories.repos,
      tasks: repositories.tasks,
    },
    clis: () => clis,
    shutdown,
  });
  broadcast = send;
  // Steps left running by a previous process become interrupted (resumable); queued tasks start.
  pipeline.recover();
  console.log(`${banner()}\n\nblackwall is running at:\n  ${launchUrl}\n`);
  if (config.open) openBrowser(launchUrl);
} catch (error) {
  console.error(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  await shutdown.run();
  process.exit(1);
}
