import { DEFAULT_TAGS } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { setTags } from "../../api";
import { cn } from "../../lib/utils";
import { queryKeys, tagsQuery } from "../../query";
import { addTag, errorMessage, moveItem, sameList } from "../../settings-forms";
import { editorBody } from "../classes";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/field";
import { Input } from "../ui/input";
import { Empty, SaveBar, SectionHeader } from "./parts";

function TagEditor({ saved }: { saved: string[] }) {
  const queryClient = useQueryClient();
  const [tags, setList] = useState(saved);
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = !sameList(tags, saved);

  function add(event: FormEvent) {
    event.preventDefault();
    const result = addTag(tags, input);
    if (!result.ok) {
      setInputError(result.error);
      return;
    }
    setList(result.tags);
    setInput("");
    setInputError(null);
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = await setTags(tags);
      queryClient.setQueryData(queryKeys.tags, next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className={cn(editorBody, "gap-3")}>
        <p className="m-0 max-w-[640px] text-meta text-muted-foreground">
          Code reviewers tag each finding from this list. Changes apply to review steps that start
          after saving.
        </p>
        <form className="flex max-w-[640px] flex-col gap-1" onSubmit={add}>
          <div className="flex gap-2">
            <Input
              className="mono"
              aria-label="New tag"
              placeholder="new-tag"
              spellCheck={false}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setInputError(null);
              }}
            />
            <Button type="submit" disabled={!input.trim()}>
              Add tag
            </Button>
          </div>
          {inputError && <ErrorText>{inputError}</ErrorText>}
        </form>
        {tags.length === 0 ? (
          <p className="m-0 text-muted-foreground">
            No tags. Reviewers then report findings without tags.{" "}
            <button
              type="button"
              className="cursor-pointer border-none bg-transparent p-0 text-primary hover:underline"
              onClick={() => setList([...DEFAULT_TAGS])}
            >
              Restore the default list
            </button>
          </p>
        ) : (
          <ol className="m-0 flex max-w-[640px] list-none flex-col p-0" aria-label="Tags">
            {tags.map((tag, i) => (
              <li
                key={tag}
                className="group flex h-9 items-center gap-2 rounded-md px-2 hover:bg-card"
              >
                <span className="mono w-6 text-right text-label text-faint">{i + 1}</span>
                <span className="mono inline-flex h-5 items-center rounded-xs bg-muted px-1.5 text-foreground-strong">
                  {tag}
                </span>
                <span className="flex-1" />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${tag} up`}
                  disabled={i === 0}
                  onClick={() => setList(moveItem(tags, i, -1))}
                >
                  ↑
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${tag} down`}
                  disabled={i === tags.length - 1}
                  onClick={() => setList(moveItem(tags, i, 1))}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${tag}`}
                  className="hover:text-destructive"
                  onClick={() => setList(tags.filter((t) => t !== tag))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ol>
        )}
      </div>
      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        onDiscard={() => {
          setList(saved);
          setError(null);
        }}
        onSave={() => void save()}
      />
    </>
  );
}

/** The editable finding tag list, injected into code reviewer prompts. */
export function TagsSection() {
  const tags = useQuery(tagsQuery);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <SectionHeader title="Tags">
        {tags.data && <span className="mono text-label text-faint">{tags.data.length}</span>}
      </SectionHeader>
      {tags.isPending ? (
        <Empty>Loading tags…</Empty>
      ) : tags.isError ? (
        <Empty>{tags.error.message}</Empty>
      ) : (
        // Re-keyed after a save so the form starts from the stored list.
        <TagEditor key={tags.data.join(",")} saved={tags.data} />
      )}
    </div>
  );
}
