import { useState } from "react";
import {
  ArrowLeftIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { useBulkUpdateModels } from "@/api/library";
import { useDeleteProject, useProjects } from "@/api/projects";
import type { ProjectOut, TagColor } from "@/api/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProjectDialog } from "@/components/projects/ProjectDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function folderColorStyle(color: TagColor | string | null | undefined) {
  switch (color) {
    case "red":
      return { icon: "text-red-500 fill-red-500/20", progress: "bg-red-500" };
    case "orange":
      return { icon: "text-orange-500 fill-orange-500/20", progress: "bg-orange-500" };
    case "amber":
      return { icon: "text-amber-500 fill-amber-500/20", progress: "bg-amber-500" };
    case "green":
      return { icon: "text-green-500 fill-green-500/20", progress: "bg-green-500" };
    case "teal":
      return { icon: "text-teal-500 fill-teal-500/20", progress: "bg-teal-500" };
    case "blue":
      return { icon: "text-blue-500 fill-blue-500/20", progress: "bg-blue-500" };
    case "indigo":
      return { icon: "text-indigo-500 fill-indigo-500/20", progress: "bg-indigo-500" };
    case "violet":
      return { icon: "text-violet-500 fill-violet-500/20", progress: "bg-violet-500" };
    case "pink":
      return { icon: "text-pink-500 fill-pink-500/20", progress: "bg-pink-500" };
    case "slate":
    default:
      return { icon: "text-slate-500 fill-slate-500/20", progress: "bg-slate-500" };
  }
}

interface ProjectFolderViewProps {
  activeProjectId?: number;
  onSelectProject: (projectId: number | undefined) => void;
  totalModelsInView?: number;
}

export function ProjectFolderView({
  activeProjectId,
  onSelectProject,
  totalModelsInView = 0,
}: ProjectFolderViewProps) {
  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? [];
  const bulkUpdate = useBulkUpdateModels();
  const deleteProject = useDeleteProject();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectOut | null>(null);
  const [deletingProject, setDeletingProject] = useState<ProjectOut | null>(null);
  const [dragOverProjectId, setDragOverProjectId] = useState<number | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);

  const activeProject = projects.find((p) => p.id === activeProjectId);

  function handleModelDrop(targetProjectId: number | null, event: React.DragEvent) {
    event.preventDefault();
    setDragOverProjectId(null);
    setDragOverRoot(false);

    try {
      const rawData = event.dataTransfer.getData("application/json");
      if (!rawData) return;
      const data = JSON.parse(rawData);
      const ids: number[] = Array.isArray(data.ids) ? data.ids : [];
      if (ids.length === 0) return;

      const targetProject = projects.find((p) => p.id === targetProjectId);
      const targetName = targetProject ? targetProject.name : "la bibliothèque générale";

      bulkUpdate.mutate(
        { ids, project_id: targetProjectId ?? 0 },
        {
          onSuccess: (res) => {
            toast.success(
              `${res.updated} modèle${res.updated > 1 ? "s" : ""} déplacé${res.updated > 1 ? "s" : ""} vers ${targetName}`,
            );
          },
        },
      );
    } catch {
      // Ignorer les formats de drag invalides
    }
  }

  // --- Vue dossier sélectionné (Intérieur d'un dossier) ---
  if (activeProjectId && activeProject) {
    const style = folderColorStyle(activeProject.color);
    return (
      <div className="space-y-4">
        {/* Breadcrumb avec drop zone vers la racine */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => onSelectProject(undefined)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverRoot(true);
              }}
              onDragLeave={() => setDragOverRoot(false)}
              onDrop={(e) => handleModelDrop(null, e)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all text-muted-foreground hover:text-foreground hover:bg-muted font-medium",
                dragOverRoot && "ring-2 ring-primary bg-primary/10 text-primary font-semibold scale-105",
              )}
            >
              <ArrowLeftIcon className="size-3.5" />
              <span>Bibliothèque</span>
              {dragOverRoot && (
                <Badge variant="default" className="text-[10px] ml-1 py-0 px-1.5">
                  Déposer pour sortir du dossier
                </Badge>
              )}
            </button>

            <span className="text-muted-foreground">/</span>

            <div className="flex items-center gap-2 font-semibold text-foreground">
              <FolderIcon className={cn("size-4", style.icon)} />
              <span>{activeProject.name}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditingProject(activeProject)}
              className="gap-1.5 h-8 text-xs"
            >
              <PencilIcon className="size-3" />
              Modifier
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setDeletingProject(activeProject)}
              aria-label="Supprimer le dossier"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* Bannière de résumé du projet */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-border/60 bg-muted/20">
          <div className="flex items-start gap-3 min-w-0">
            <div className="p-2.5 rounded-xl bg-background border border-border/80 shadow-xs shrink-0">
              <FolderIcon className={cn("size-6", style.icon)} />
            </div>
            <div className="space-y-1 min-w-0">
              <h2 className="text-base font-semibold truncate text-foreground">{activeProject.name}</h2>
              {activeProject.description && (
                <p className="text-xs text-muted-foreground line-clamp-2">{activeProject.description}</p>
              )}
              <div className="flex items-center gap-2 pt-0.5 text-xs text-muted-foreground">
                <span>{activeProject.model_count} modèle{activeProject.model_count > 1 ? "s" : ""}</span>
                <span>•</span>
                <span className="font-mono">
                  {activeProject.total_quantity_printed} / {activeProject.total_quantity_target} pièce{activeProject.total_quantity_target > 1 ? "s" : ""} imprimée{activeProject.total_quantity_printed > 1 ? "s" : ""}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:items-end gap-1.5 shrink-0 sm:min-w-44">
            <div className="flex items-center justify-between sm:justify-end gap-2 text-xs font-mono font-medium">
              <span>Progression :</span>
              <span className={cn(activeProject.progress_pct === 100 && "text-emerald-500 font-bold")}>
                {Math.round(activeProject.progress_pct)}%
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full transition-all duration-300", style.progress)}
                style={{ width: `${Math.min(100, Math.max(0, activeProject.progress_pct))}%` }}
              />
            </div>
          </div>
        </div>

        {/* Drop zone vide si aucun modèle dans ce dossier */}
        {totalModelsInView === 0 && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOverProjectId(activeProject.id);
            }}
            onDragLeave={() => setDragOverProjectId(null)}
            onDrop={(e) => handleModelDrop(activeProject.id, e)}
            className={cn(
              "flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-xl transition-all text-center gap-2",
              dragOverProjectId === activeProject.id
                ? "border-primary bg-primary/10 ring-2 ring-primary scale-[1.01]"
                : "border-border/70 hover:border-border",
            )}
          >
            <FolderOpenIcon className={cn("size-10", style.icon)} />
            <h3 className="font-semibold text-sm">Ce dossier est vide</h3>
            <p className="text-xs text-muted-foreground max-w-sm">
              Glissez-déposez des modèles ici depuis la bibliothèque pour les organiser dans ce projet.
            </p>
          </div>
        )}

        {/* Modales d'édition et de confirmation */}
        {editingProject && (
          <ProjectDialog
            open={Boolean(editingProject)}
            onOpenChange={(open) => !open && setEditingProject(null)}
            project={editingProject}
          />
        )}
        {deletingProject && (
          <ConfirmDialog
            open={Boolean(deletingProject)}
            onOpenChange={(open) => !open && setDeletingProject(null)}
            title={`Supprimer le dossier "${deletingProject.name}" ?`}
            description="Les modèles associés ne seront pas supprimés, ils seront simplement retirés de ce dossier."
            confirmLabel="Supprimer"
            destructive
            onConfirm={() => {
              deleteProject.mutate(deletingProject.id, {
                onSuccess: () => {
                  toast.success(`Dossier "${deletingProject.name}" supprimé`);
                  onSelectProject(undefined);
                },
              });
            }}
          />
        )}
      </div>
    );
  }

  // --- Vue racine : Grille des dossiers de projets ---
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FolderIcon className="size-4 text-muted-foreground" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Dossiers & Projets {projects.length > 0 && `(${projects.length})`}
          </h2>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setCreateDialogOpen(true)}
          className="gap-1.5 h-7 text-xs"
        >
          <FolderPlusIcon className="size-3.5" />
          Nouveau dossier
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
        {projects.map((proj) => {
          const style = folderColorStyle(proj.color);
          const isOver = dragOverProjectId === proj.id;
          const hasTarget = proj.total_quantity_target > 0;
          return (
            <Card
              key={proj.id}
              onClick={() => onSelectProject(proj.id)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverProjectId(proj.id);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOverProjectId(null);
                }
              }}
              onDrop={(e) => handleModelDrop(proj.id, e)}
              className={cn(
                "group relative cursor-pointer p-3.5 flex flex-col justify-between gap-2.5 transition-all duration-150 border select-none rounded-xl min-h-[105px]",
                isOver
                  ? "border-primary bg-primary/10 ring-2 ring-primary shadow-md scale-[1.02]"
                  : "hover:border-primary/40 hover:shadow-xs hover:bg-muted/30",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <div className="p-2 rounded-lg bg-background border border-border/80 shadow-2xs shrink-0 group-hover:scale-105 transition-transform">
                    <FolderIcon className={cn("size-5", style.icon)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold truncate text-foreground leading-tight" title={proj.name}>
                      {proj.name}
                    </h3>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {proj.model_count} modèle{proj.model_count > 1 ? "s" : ""}
                    </p>
                  </div>
                </div>

                <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label="Options du dossier"
                        className="p-1 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                      >
                        <MoreVerticalIcon className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-36">
                      <DropdownMenuItem onClick={() => setEditingProject(proj)}>
                        <PencilIcon className="size-3.5 mr-1.5" />
                        Modifier
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setDeletingProject(proj)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2Icon className="size-3.5 mr-1.5" />
                        Supprimer
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* Barre de progression des pièces (uniquement si un objectif est défini) */}
              {hasTarget ? (
                <div className="space-y-1.5 pt-1.5 border-t border-border/40">
                  <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground">
                    <span>{proj.total_quantity_printed}/{proj.total_quantity_target} imprimé{proj.total_quantity_target > 1 ? "s" : ""}</span>
                    <span className={cn(proj.progress_pct === 100 && "text-emerald-500 font-semibold")}>
                      {Math.round(proj.progress_pct)}%
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn("h-full transition-all duration-300", style.progress)}
                      style={{ width: `${Math.min(100, Math.max(0, proj.progress_pct))}%` }}
                    />
                  </div>
                </div>
              ) : (
                <div className="pt-1 border-t border-border/40 flex items-center justify-between text-[11px] text-muted-foreground/80">
                  <span>Dossier</span>
                  <span className="text-[10px] uppercase font-mono tracking-wider text-muted-foreground/60">Projet</span>
                </div>
              )}

              {/* Message au survol du drag & drop */}
              {isOver && (
                <div className="absolute inset-0 bg-primary/15 backdrop-blur-[1px] rounded-xl flex items-center justify-center p-2 text-center pointer-events-none">
                  <span className="text-xs font-semibold text-primary bg-background/90 px-2.5 py-1 rounded-full shadow-xs">
                    Déposer pour ranger ici
                  </span>
                </div>
              )}
            </Card>
          );
        })}

        {/* Bouton "+ Nouveau dossier" rapide dans la grille */}
        <button
          type="button"
          onClick={() => setCreateDialogOpen(true)}
          className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border border-dashed border-border/70 text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-muted/30 transition-all min-h-[105px] text-xs font-medium"
        >
          <div className="p-1.5 rounded-full bg-muted shrink-0 text-muted-foreground">
            <PlusIcon className="size-4" />
          </div>
          <span>Nouveau dossier</span>
        </button>
      </div>

      {/* Modale de création */}
      <ProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSuccess={(created) => {
          onSelectProject(created.id);
        }}
      />

      {/* Modale d'édition */}
      {editingProject && (
        <ProjectDialog
          open={Boolean(editingProject)}
          onOpenChange={(open) => !open && setEditingProject(null)}
          project={editingProject}
        />
      )}

      {/* Modale de suppression */}
      {deletingProject && (
        <ConfirmDialog
          open={Boolean(deletingProject)}
          onOpenChange={(open) => !open && setDeletingProject(null)}
          title={`Supprimer le dossier "${deletingProject.name}" ?`}
          description="Les modèles associés ne seront pas supprimés, ils seront simplement retirés de ce dossier."
          confirmLabel="Supprimer"
          destructive
          onConfirm={() => {
            deleteProject.mutate(deletingProject.id, {
              onSuccess: () => {
                toast.success(`Dossier "${deletingProject.name}" supprimé`);
              },
            });
          }}
        />
      )}
    </div>
  );
}
