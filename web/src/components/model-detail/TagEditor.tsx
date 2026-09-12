import { useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";

import { useAddTag, useRemoveTag, useSetTagColor, useTags } from "@/api/library";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TAG_COLORS, tagColorClass, tagSwatchClass } from "@/lib/tagColors";
import { cn } from "@/lib/utils";
import type { ModelDetail, TagOut } from "@/api/types";

/** Tag chip display, plus add (combobox from `/api/tags` + free text) /
 * remove (Task 8 decision). The add/remove controls only render in edit
 * mode -- entering edit mode is itself the consent step, so individual
 * removes stay unconfirmed. */
export function TagEditor({ model, editMode }: { model: ModelDetail; editMode: boolean }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const tagsQuery = useTags();
  const addTag = useAddTag(model.slug, model.id);
  const removeTag = useRemoveTag(model.slug, model.id);
  const setTagColor = useSetTagColor();

  const allTags = tagsQuery.data ?? [];
  const tagsByName = new Map(allTags.map((tag) => [tag.name, tag]));
  const suggestions = allTags
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
      {model.tags.map((tag) => {
        const tagRow = tagsByName.get(tag);
        return (
          <Badge key={tag} variant="secondary" className={cn("gap-1", tagColorClass(tagRow?.color))}>
            {editMode && tagRow ? (
              <TagColorPicker tag={tagRow} onPick={(color) => setTagColor.mutate({ id: tagRow.id, color })} />
            ) : (
              tag
            )}
            {editMode && (
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                onClick={() => removeTag.mutate(tag)}
                className="rounded-full hover:text-destructive"
              >
                <XIcon className="size-3" />
              </button>
            )}
          </Badge>
        );
      })}
      {editMode && (
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
      )}
    </div>
  );
}

/** Click-the-tag-name-to-recolor control, edit-mode only (R11-C item 16).
 * A 10-swatch grid from the fixed palette -- picking one PATCHes the tag
 * globally (color is a tag-level property, not per-model). */
function TagColorPicker({ tag, onPick }: { tag: TagOut; onPick: (color: TagOut["color"]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Set color for tag ${tag.name}`}>
          {tag.name}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <div className="grid grid-cols-5 gap-1.5">
          {TAG_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Color ${color}`}
              aria-pressed={tag.color === color}
              className={cn(
                "size-5 rounded-full ring-offset-2 ring-offset-background",
                tagSwatchClass(color),
                tag.color === color && "ring-2 ring-foreground",
              )}
              onClick={() => {
                onPick(color);
                setOpen(false);
              }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
