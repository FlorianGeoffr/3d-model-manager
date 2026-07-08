import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { modelQueryOptions, useModelSearchQuery } from "@/api/library";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useDebouncedValue } from "@/lib/format";

export type TargetMode = "new" | "existing";

export interface ExistingTarget {
  modelId: number;
  revisionId: number;
  slug: string;
  name: string;
}

interface TargetPickerProps {
  mode: TargetMode;
  onModeChange: (mode: TargetMode) => void;
  newModelName: string;
  onNewModelNameChange: (name: string) => void;
  existingTarget: ExistingTarget | null;
  onExistingTargetChange: (target: ExistingTarget | null) => void;
  disabled?: boolean;
}

/** Upload target picker (Task 8): new model {name} vs. existing model
 * (search select whose current revision receives the uploaded files). */
export function TargetPicker({
  mode,
  onModeChange,
  newModelName,
  onNewModelNameChange,
  existingTarget,
  onExistingTargetChange,
  disabled,
}: TargetPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const debouncedQuery = useDebouncedValue(query, 300);
  const searchQuery = useModelSearchQuery(debouncedQuery);
  const queryClient = useQueryClient();

  async function selectExisting(slug: string) {
    const detail = await queryClient.fetchQuery(modelQueryOptions(slug));
    if (!detail.current_revision) return;
    onExistingTargetChange({
      modelId: detail.id,
      revisionId: detail.current_revision.id,
      slug: detail.slug,
      name: detail.name,
    });
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="space-y-3">
      <RadioGroup
        value={mode}
        onValueChange={(value) => onModeChange(value as TargetMode)}
        className="flex flex-row gap-6"
      >
        <Label className="flex items-center gap-2 font-normal">
          <RadioGroupItem value="new" disabled={disabled} />
          New model
        </Label>
        <Label className="flex items-center gap-2 font-normal">
          <RadioGroupItem value="existing" disabled={disabled} />
          Existing model
        </Label>
      </RadioGroup>

      {mode === "new" ? (
        <div className="max-w-sm space-y-1.5">
          <Label htmlFor="upload-new-model-name">Model name</Label>
          <Input
            id="upload-new-model-name"
            value={newModelName}
            onChange={(event) => onNewModelNameChange(event.target.value)}
            disabled={disabled}
            placeholder="e.g. Articulated dragon"
          />
        </div>
      ) : (
        <div className="max-w-sm space-y-1.5">
          <Label htmlFor="upload-existing-model-search">Model</Label>
          {/* Inline dropdown rather than a Radix Popover: the search field
              needs to keep focus while the results are open, but a Popover
              portals its content into a focus scope that yanks focus off an
              external trigger input after the first keystroke. A plain
              absolutely-positioned list under the input keeps focus where the
              user is typing. Closes when focus leaves the whole widget. */}
          <div
            className="relative"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
            }}
          >
            <Input
              id="upload-existing-model-search"
              value={existingTarget ? existingTarget.name : query}
              onChange={(event) => {
                onExistingTargetChange(null);
                setQuery(event.target.value);
                setOpen(true);
              }}
              onFocus={() => {
                if (!existingTarget && query.trim().length > 0) setOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
              disabled={disabled}
              placeholder="Search models…"
              autoComplete="off"
            />
            {open && (
              <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
                {(searchQuery.data?.items ?? []).length === 0 ? (
                  <p className="p-2 text-sm text-muted-foreground">
                    {debouncedQuery ? "No matching models" : "Type to search"}
                  </p>
                ) : (
                  <ul className="max-h-56 overflow-y-auto">
                    {searchQuery.data?.items.map((summary) => (
                      <li key={summary.id}>
                        <button
                          type="button"
                          className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                          onClick={() => void selectExisting(summary.slug)}
                        >
                          {summary.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
