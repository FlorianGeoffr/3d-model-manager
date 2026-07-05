import { useState } from "react";

import { useCreateNote, useDeleteNote, usePatchNote } from "@/api/library";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/format";
import { MARKDOWN_CLASSNAME, renderMarkdown } from "@/lib/markdown";
import type { ModelDetail, NoteOut } from "@/api/types";

function NoteItem({ note, modelSlug }: { note: NoteOut; modelSlug: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const patchNote = usePatchNote(modelSlug);
  const deleteNote = useDeleteNote(modelSlug);

  if (editing) {
    return (
      <li className="rounded-lg border border-border p-3">
        <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} autoFocus />
        <div className="mt-2 flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={patchNote.isPending || draft.trim().length === 0}
            onClick={() =>
              patchNote.mutate(
                { id: note.id, body: draft },
                { onSuccess: () => setEditing(false) },
              )
            }
          >
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft(note.body);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="rounded-lg border border-border p-3">
      <div className={MARKDOWN_CLASSNAME} dangerouslySetInnerHTML={{ __html: renderMarkdown(note.body) }} />
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{formatDateTime(note.updated_at)}</span>
        <div className="flex gap-3">
          <button type="button" className="hover:underline" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className="hover:underline" onClick={() => deleteNote.mutate(note.id)}>
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}

export function NotesTab({ model }: { model: ModelDetail }) {
  const [draft, setDraft] = useState("");
  const createNote = useCreateNote(model.slug);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    createNote.mutate({ model_id: model.id, body }, { onSuccess: () => setDraft("") });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="space-y-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Write a note… (markdown supported)"
          rows={3}
          aria-label="New note"
        />
        <Button type="submit" size="sm" disabled={createNote.isPending || draft.trim().length === 0}>
          Add note
        </Button>
      </form>

      {model.notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="space-y-3">
          {model.notes.map((note) => (
            <NoteItem key={note.id} note={note} modelSlug={model.slug} />
          ))}
        </ul>
      )}
    </div>
  );
}
