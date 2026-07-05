import { useEffect, useState } from "react";

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

/** Click-to-edit text (Task 8: header name/description inline edit). Saves
 * on blur or Enter (single-line); Escape reverts without saving. */
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
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== value) onSave(trimmed);
  }

  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  if (editing) {
    const Field = multiline ? Textarea : Input;
    return (
      <Field
        autoFocus
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !multiline) {
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
    );
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={() => setEditing(true)}
      className={cn(
        "cursor-text rounded px-1 py-0.5 text-left transition-colors hover:bg-muted",
        displayClassName,
      )}
    >
      {value || <span className="text-muted-foreground">{placeholder}</span>}
    </button>
  );
}
