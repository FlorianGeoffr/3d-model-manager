import { useEffect, useState } from "react";
import { PencilIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface InlineEditProps {
  value: string;
  placeholder?: string;
  multiline?: boolean;
  onSave: (value: string) => void;
  className?: string;
  displayClassName?: string;
  "aria-label"?: string;
}

/** Explicit-commit click-to-edit text (name/description in `ModelHeader`,
 * mounted only while the page is in edit mode). Resting state shows the
 * value plus a small pencil affordance; opening it reveals an input/textarea
 * with explicit Save/Cancel actions. Blur does NOT save -- only Save (or
 * Enter on single-line, Cmd/Ctrl+Enter on multiline) commits; Cancel or
 * Escape reverts without saving. */
export function InlineEdit({
  value,
  placeholder,
  multiline,
  onSave,
  className,
  displayClassName,
  "aria-label": ariaLabel,
}: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  function commit() {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed !== value) onSave(trimmed);
  }

  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  if (editing) {
    const Field = multiline ? Textarea : Input;
    return (
      <div className="space-y-1.5">
        <Field
          autoFocus
          value={draft}
          placeholder={placeholder}
          aria-label={ariaLabel}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !multiline) {
              event.preventDefault();
              commit();
            }
            if (event.key === "Enter" && multiline && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
          className={className}
        />
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={commit}>
            Save
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-1.5">
      <span className={cn(!value && "text-muted-foreground", displayClassName)}>
        {value || placeholder}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={ariaLabel ? `Edit ${ariaLabel}` : "Edit"}
        onClick={() => setEditing(true)}
        className="mt-0.5 shrink-0 opacity-60 hover:opacity-100"
      >
        <PencilIcon />
      </Button>
    </div>
  );
}
