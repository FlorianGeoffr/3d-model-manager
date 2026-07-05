import { useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";

import { useAddTag, useRemoveTag, useTags } from "@/api/library";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ModelDetail } from "@/api/types";

/** Tag add (combobox from `/api/tags` + free text) / remove (Task 8 decision). */
export function TagEditor({ model }: { model: ModelDetail }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const tagsQuery = useTags();
  const addTag = useAddTag(model.slug, model.id);
  const removeTag = useRemoveTag(model.slug, model.id);

  const suggestions = (tagsQuery.data ?? [])
    .map((tag) => tag.name)
    .filter((name) => !model.tags.includes(name) && name.toLowerCase().includes(value.trim().toLowerCase()));

  function commit(name: string) {
    const trimmed = name.trim();
    if (!trimmed || model.tags.includes(trimmed)) return;
    addTag.mutate(trimmed, {
      onSuccess: () => {
        setValue("");
        setOpen(false);
      },
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {model.tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1">
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => removeTag.mutate(tag)}
            className="rounded-full hover:text-destructive"
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="icon-sm" aria-label="Add tag">
            <PlusIcon className="size-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56" align="start">
          <Input
            autoFocus
            value={value}
            placeholder="Add tag…"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit(value);
              }
            }}
          />
          {suggestions.length > 0 && (
            <ul className="mt-1.5 max-h-40 overflow-y-auto text-sm">
              {suggestions.map((name) => (
                <li key={name}>
                  <button
                    type="button"
                    className="w-full rounded px-2 py-1 text-left hover:bg-muted"
                    onClick={() => commit(name)}
                  >
                    {name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
