import { useState, type FormEvent } from "react";
import { useCreateProject, useProjects, useUpdateProject } from "@/api/projects";
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
import { getProjectIcon, PROJECT_ICONS } from "@/lib/projectIcons";
import { cn } from "@/lib/utils";

const DEFAULT_COLOR: TagColor = "indigo";
const DEFAULT_ICON = "folder";

function ProjectColorPicker({ color, onPick }: { color: TagColor; onPick: (color: TagColor) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Project color"
          className={cn("size-7 shrink-0 rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110", tagSwatchClass(color))}
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

function ProjectIconPicker({
  icon,
  onPick,
}: {
  icon: string;
  onPick: (icon: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const CurrentIcon = getProjectIcon(icon);
  const currentMeta = PROJECT_ICONS.find((i) => i.id === icon);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Choisir une icône"
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-input bg-background hover:bg-muted text-xs font-medium transition-colors shadow-2xs"
        >
          <CurrentIcon className="size-4 text-primary shrink-0" />
          <span className="truncate max-w-[100px]">{currentMeta?.label ?? "Icône"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2.5" align="start">
        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">
          Choisir une icône
        </div>
        <div className="grid grid-cols-4 gap-1.5 max-h-56 overflow-y-auto">
          {PROJECT_ICONS.map((option) => {
            const IconComp = option.icon;
            const isSelected = icon === option.id;
            return (
              <button
                key={option.id}
                type="button"
                title={option.label}
                aria-label={option.label}
                className={cn(
                  "flex flex-col items-center justify-center p-2 rounded-lg border transition-all text-muted-foreground hover:text-foreground hover:bg-muted/80",
                  isSelected
                    ? "border-primary bg-primary/10 text-primary font-medium ring-1 ring-primary"
                    : "border-transparent",
                )}
                onClick={() => {
                  onPick(option.id);
                  setOpen(false);
                }}
              >
                <IconComp className="size-5 mb-1" />
                <span className="text-[9px] truncate w-full text-center">{option.label}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ProjectDialog({
  trigger,
  project,
  defaultParentId,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  onSuccess,
}: {
  trigger?: React.ReactNode;
  project?: ProjectOut;
  defaultParentId?: number | null;
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
  const [icon, setIcon] = useState<string>(project?.icon ?? DEFAULT_ICON);
  const [parentId, setParentId] = useState<number | null>(project?.parent_id ?? defaultParentId ?? null);

  const projectsQuery = useProjects();
  const allProjects = projectsQuery.data ?? [];
  const availableParents = allProjects.filter((p) => !isEdit || p.id !== project.id);

  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const mutation = isEdit ? updateProject : createProject;

  function reset() {
    setName(project?.name ?? "");
    setDescription(project?.description ?? "");
    setColor(project?.color ?? DEFAULT_COLOR);
    setIcon(project?.icon ?? DEFAULT_ICON);
    setParentId(project?.parent_id ?? defaultParentId ?? null);
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
        {
          id: project.id,
          payload: {
            name: trimmedName,
            description: trimmedDesc,
            color,
            icon,
            parent_id: parentId,
          },
        },
        {
          onSuccess: (data) => {
            setOpen(false);
            onSuccess?.(data);
          },
        },
      );
    } else {
      createProject.mutate(
        {
          name: trimmedName,
          description: trimmedDesc,
          color,
          icon,
          parent_id: parentId,
        },
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
            <DialogTitle>{isEdit ? `Modifier le dossier "${project.name}"` : "Nouveau dossier"}</DialogTitle>
            <DialogDescription>
              Organisez vos modèles en dossiers et sous-dossiers pour suivre la fabrication et vos impressions.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="project-name">Nom du dossier</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ex: Voron 2.4, Drone RC, Casque Iron Man..."
                disabled={mutation.isPending}
                required
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="project-desc">Description (optionnelle)</Label>
              <Textarea
                id="project-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Notes sur le BOM, matériaux, tolérances..."
                rows={2}
                disabled={mutation.isPending}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Icône personnalisée</Label>
                <ProjectIconPicker icon={icon} onPick={setIcon} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Couleur du dossier</Label>
                <div className="flex items-center h-9">
                  <ProjectColorPicker color={color} onPick={setColor} />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="parent-project">Dossier parent (arborescence)</Label>
              <select
                id="parent-project"
                value={parentId ?? ""}
                onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={mutation.isPending}
              >
                <option value="">Racine (aucun parent)</option>
                {availableParents.map((p) => (
                  <option key={p.id} value={p.id}>
                    📁 {p.name}
                  </option>
                ))}
              </select>
            </div>

            {mutation.isError && (
              <p role="alert" className="text-sm text-destructive">
                {mutation.error instanceof ApiError ? mutation.error.detail : "Impossible d'enregistrer le dossier"}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={mutation.isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={mutation.isPending || !name.trim()}>
              {mutation.isPending ? "Enregistrement…" : isEdit ? "Enregistrer" : "Créer le dossier"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
