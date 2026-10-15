import { agentCliFor, type Agent, type GrillQuestion, type Task } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { answerQuestion } from "../../api";
import { useAgentLibrary } from "../../hooks";
import { isModKey, modKeyLabel } from "../../keyboard";
import { cn } from "../../lib/utils";
import { queryKeys, stepEventsQuery } from "../../query";
import { errorMessage } from "../../settings-forms";
import { AUTO_MODEL_LABEL, effectiveModel, grillCounts, modelTitle } from "../../task-view";
import { AgentTile } from "../AgentTile";
import { StatusBadge } from "../StatusBadge";
import { Button } from "../ui/button";
import { Chip } from "../ui/chip";
import { ErrorText, fieldLabel } from "../ui/field";
import { Kbd } from "../ui/kbd";
import { Textarea } from "../ui/textarea";
import type { PlanComment } from "./actions";
import { PlanPanel } from "./PlanPanel";
import type { TaskAction } from "./use-task-action";

function QuestionStatus({ question }: { question: GrillQuestion }) {
  if (question.answer !== null) {
    return (
      <Chip tone="done">
        {question.answeredBy === "user" ? "Answered by you" : "Answered by planner"}
      </Chip>
    );
  }
  if (question.needsHuman) return <StatusBadge status="needs-you" label="Needs your decision" />;
  return <Chip tone="neutral">Waiting on planner</Chip>;
}

function AnswerForm({ task, question }: { task: Task; question: GrillQuestion }) {
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!answer.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await answerQuestion(task.id, question.id, answer.trim());
      queryClient.setQueryData(queryKeys.task(task.id), result.task);
      await queryClient.invalidateQueries({ queryKey: queryKeys.taskGrill(task.id) });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  const id = `answer-${question.id}`;
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className={fieldLabel}>
        Your answer
      </label>
      <Textarea
        id={id}
        rows={2}
        value={answer}
        placeholder="Decide for the planner. It revises the plan with your answer."
        onChange={(event) => setAnswer(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && isModKey(event.nativeEvent)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex items-center gap-2">
        <span className="text-meta text-faint">
          Goes back to the planner, who revises the plan.
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="needs" type="submit" disabled={pending || !answer.trim()}>
          {pending ? "Sending…" : "Answer"}
          <Kbd onFill aria-hidden="true">
            {modKeyLabel("↵")}
          </Kbd>
        </Button>
      </div>
    </form>
  );
}

function QuestionCard({
  task,
  question,
  number,
  asker,
}: {
  task: Task;
  question: GrillQuestion;
  number: number;
  asker: Agent | undefined;
}) {
  const needsAnswer = question.needsHuman && question.answer === null;
  const canAnswer = needsAnswer && task.status === "needs-you" && task.gate === "questions";
  const events = useQuery({
    ...stepEventsQuery(task.id, question.stepId ?? ""),
    enabled: question.stepId !== null,
  });
  const cli = asker ? agentCliFor(task, asker.id) : null;
  const model = effectiveModel(events.data, asker, cli);
  return (
    <article
      aria-label={`Question ${number}`}
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card px-3.5 py-3",
        needsAnswer && "border-magenta/45 bg-needs-wash",
        canAnswer && "border-magenta bg-sidebar shadow-glow-needs",
      )}
    >
      <div className="flex items-center gap-2 text-meta">
        <span className="mono text-faint">Q{number}</span>
        <QuestionStatus question={question} />
        <span className="flex-1" />
        {asker ? (
          <>
            <AgentTile cli={agentCliFor(task, asker.id)} />
            <span className="text-muted-foreground">{asker.name}</span>
            <span
              className="mono max-w-40 truncate text-[11px] text-faint"
              title={modelTitle(model)}
            >
              {model.model ?? AUTO_MODEL_LABEL}
            </span>
          </>
        ) : (
          <span className="text-faint">Plan reviewer</span>
        )}
      </div>
      <p className="m-0 font-medium whitespace-pre-wrap text-foreground-strong">
        {question.question}
      </p>
      {question.answer !== null && (
        <div className="flex gap-2.5 pl-0.5">
          <span className="label mt-0.5 w-12 flex-none text-muted-foreground">
            {question.answeredBy === "user" ? "You" : "Planner"}
          </span>
          <p className="m-0 text-[12.5px] whitespace-pre-wrap text-foreground">{question.answer}</p>
        </div>
      )}
      {canAnswer && <AnswerForm task={task} question={question} />}
    </article>
  );
}

/**
 * The grill: plan reviewers' questions in order, each with who asked it and
 * the planner's or the user's answer. Questions only the user can decide are
 * answered inline; the plan sits beside them with Approve / Request changes.
 */
export function GrillPanel({
  task,
  questions,
  action,
  draft,
  planComment,
  onPlanComment,
}: {
  task: Task;
  questions: readonly GrillQuestion[];
  action: TaskAction;
  draft: string;
  planComment: PlanComment;
  onPlanComment: (comment: PlanComment) => void;
}) {
  const agentMap = useAgentLibrary();
  const counts = grillCounts(questions);

  return (
    <div className="flex min-h-0 flex-1 flex-wrap">
      <section
        aria-label="Grill"
        className="flex h-full min-w-0 flex-[999_1_520px] flex-col gap-3 overflow-auto px-5 pt-4 pb-6"
      >
        <div className="flex flex-wrap items-center gap-2.5 text-meta text-muted-foreground">
          <span className="label">Questions</span>
          <span>{questions.length}</span>
          {counts.byPlanner > 0 && (
            <>
              <span className="text-faint">·</span>
              <span>{counts.byPlanner} answered by planner</span>
            </>
          )}
          {counts.byUser > 0 && (
            <>
              <span className="text-faint">·</span>
              <span>{counts.byUser} answered by you</span>
            </>
          )}
          {counts.open > 0 && (
            <>
              <span className="text-faint">·</span>
              <span className="font-semibold text-magenta">
                {counts.open} {counts.open === 1 ? "needs" : "need"} your decision
              </span>
            </>
          )}
        </div>
        {questions.length === 0 ? (
          <p className="m-0 text-muted-foreground">
            {task.stage === "plan-review" && task.status === "running"
              ? "Reviewers on the plan. Questions land here."
              : "Standing by. Plan reviewers grill the plan in the Plan review stage."}
          </p>
        ) : (
          questions.map((question, i) => (
            <QuestionCard
              key={question.id}
              task={task}
              question={question}
              number={i + 1}
              asker={question.askedByAgentId ? agentMap.get(question.askedByAgentId) : undefined}
            />
          ))
        )}
      </section>
      <aside
        aria-label="Plan"
        className="flex h-full max-w-[480px] min-w-0 flex-[1_1_420px] flex-col border-l border-border bg-sidebar"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="font-semibold text-foreground-strong">Plan</span>
        </div>
        <PlanPanel
          task={task}
          action={action}
          draft={draft}
          openQuestions={counts.open}
          comment={planComment}
          onComment={onPlanComment}
          className="min-h-0 flex-1"
        />
      </aside>
    </div>
  );
}
