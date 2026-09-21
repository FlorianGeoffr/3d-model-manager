import { useState, type FormEvent } from "react";
import { useCreateProject, useUpdateProject } from "@/api/projects";
import { ApiError } from "@/api/client";
import type { ProjectOut, TagColor } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TAG_COLORS, tagSwatchClass } from "@/lib/tagColors";
import { cn } from "@/lib/utils";

const DEFAULT_COLOR: TagColor = "indigo";

function ProjectColorPicker({ color, onPick }: { color: TagColor; onPick: (color: TagColor) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Project color"
          className={cn("size-6 shrink-0 rounded-full ring-offset-2 ring-offset-background", tagSwatchClass(color))}
        />
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <div className="grid grid-cols-5 gap-1.5">
          {TAG_COLORS.map((option) => (
            <button
              key={option}
              type="button"
              aria-label={`Color ${option}`}
              aria-pressed={color === option}
              className={cn(
                "size-5 rounded-full ring-offset-2 ring-offset-background",
                tagSwatchClass(option),
                color === option && "ring-2 ring-foreground",
              )}
              onClick={() => {
                onPick(option);
                setOpen(false);
              }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ProjectDialog({
  trigger,
  project,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  onSuccess,
}: {
  trigger?: React.ReactNode;
  project?: ProjectOut;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSuccess?: (project: ProjectOut) => void;
}) {
  const isEdit = project !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen;
  const setOpen = controlledOnOpenChange !== undefined ? controlledOnOpenChange : setUncontrolledOpen;

  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [color, setColor] = useState<TagColor>(project?.color ?? DEFAULT_COLOR);

  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const mutation = isEdit ? updateProject : createProject;

  function reset() {
    setName(project?.name ?? "");
    setDescription(project?.description ?? "");
    setColor(project?.color ?? DEFAULT_COLOR);
    createProject.reset();
    updateProject.reset();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const trimmedDesc = description.trim() || null;

    if (isEdit) {
      updateProject.mutate(
        { id: project.id, payload: { name: trimmedName, description: trimmedDesc, color } },
        {
          onSuccess: (data) => {
            setOpen(false);
            onSuccess?.(data);
          },
        },
      );
    } else {
      createProject.mutate(
        { name: trimmedName, description: trimmedDesc, color },
        {
          onSuccess: (data) => {
            setOpen(false);
            onSuccess?.(data);
          },
        },
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? `Edit project "${project.name}"` : "New project"}</DialogTitle>
            <DialogDescription>
              Group models and parts into a project to track manufacturing and print progress.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="project-name">Project name</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Voron 2.4, RC Drone, Helmet..."
                disabled={mutation.isPending}
                required
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="project-desc">Description (optional)</Label>
              <Textarea
                id="project-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Notes about BOM, tolerances, materials..."
                rows={2}
                disabled={mutation.isPending}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Color tag</Label>
              <ProjectColorPicker color={color} onPick={setColor} />
            </div>

            {mutation.isError && (
              <p role="alert" className="text-sm text-destructive">
                {mutation.error instanceof ApiError ? mutation.error.detail : "Could not save project"}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || !name.trim()}>
              {mutation.isPending ? "Saving…" : isEdit ? "Save changes" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
