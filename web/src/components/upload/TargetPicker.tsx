import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { modelQueryOptions, useModelSearchQuery } from "@/api/library";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Input
                id="upload-existing-model-search"
                value={existingTarget ? existingTarget.name : query}
                onChange={(event) => {
                  onExistingTargetChange(null);
                  setQuery(event.target.value);
                  setOpen(true);
                }}
                disabled={disabled}
                placeholder="Search models…"
                autoComplete="off"
              />
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-72 p-1"
              // The Input IS the PopoverTrigger. Radix focuses the content when
              // the popover opens, which yanks focus out of the input after the
              // first keystroke -- making the field impossible to type into.
              // Keep focus in the input; the trigger stays "inside" the
              // dismissable layer so typing doesn't close the popover either.
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
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
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
}
