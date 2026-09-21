import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { useBulkUpdateModels, useCreateModel } from "@/api/library";
import { useDeleteProject, useProjects } from "@/api/projects";
import { uploadFile } from "@/api/upload";
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
import { getProjectIcon } from "@/lib/projectIcons";
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
  const queryClient = useQueryClient();
  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? [];
  const bulkUpdate = useBulkUpdateModels();
  const deleteProject = useDeleteProject();
  const createModel = useCreateModel();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createDialogParentId, setCreateDialogParentId] = useState<number | null>(null);
  const [editingProject, setEditingProject] = useState<ProjectOut | null>(null);
  const [deletingProject, setDeletingProject] = useState<ProjectOut | null>(null);
  const [dragOverProjectId, setDragOverProjectId] = useState<number | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);

  const activeProject = projects.find((p) => p.id === activeProjectId);

  // Compute breadcrumb ancestors
  const ancestors: ProjectOut[] = [];
  if (activeProject) {
    let curr = activeProject;
    const visited = new Set<number>();
    while (curr && curr.parent_id !== null) {
      if (visited.has(curr.parent_id)) break;
      visited.add(curr.parent_id);
      const parent = projects.find((p) => p.id === curr.parent_id);
      if (!parent) break;
      ancestors.unshift(parent);
      curr = parent;
    }
  }

  async function uploadLocalFiles(files: File[], targetProjectId: number | null) {
    const targetProject = projects.find((p) => p.id === targetProjectId);
    const targetName = targetProject ? targetProject.name : "la bibliothèque générale";
    const toastId = toast.loading(`Importation de ${files.length} fichier${files.length > 1 ? "s" : ""} dans "${targetName}"...`);
    let successCount = 0;

    for (const file of files) {
      try {
        const modelName = file.name.replace(/\.[^/.]+$/, "");
        const model = await createModel.mutateAsync({
          name: modelName,
          project_id: targetProjectId ?? undefined,
        });
        if (model.current_revision) {
          await uploadFile({
            modelId: model.id,
            revisionId: model.current_revision.id,
            relPath: file.name,
            file,
          });
          successCount++;
        }
      } catch (err) {
        console.error("Erreur lors de l'upload du fichier:", err);
      }
    }

    await queryClient.invalidateQueries({ queryKey: ["models"] });
    await queryClient.invalidateQueries({ queryKey: ["projects"] });

    if (successCount > 0) {
      toast.success(
        `${successCount} fichier${successCount > 1 ? "s" : ""} importé${successCount > 1 ? "s" : ""} dans "${targetName}"`,
        { id: toastId },
      );
    } else {
      toast.error("Échec de l'importation des fichiers", { id: toastId });
    }
  }

  async function handleDrop(targetProjectId: number | null, event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragOverProjectId(null);
    setDragOverRoot(false);

    // Check if OS files were dropped directly from Windows Explorer
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      const droppedFiles = Array.from(event.dataTransfer.files);
      await uploadLocalFiles(droppedFiles, targetProjectId);
      return;
    }

    // Otherwise, handle moving internal models
    try {
      let ids: number[] = [];
      const rawJson = event.dataTransfer.getData("application/json");
      if (rawJson) {
        try {
          const data = JSON.parse(rawJson);
          if (Array.isArray(data.ids)) ids = data.ids;
        } catch {}
      }
      if (ids.length === 0) {
        const rawText = event.dataTransfer.getData("text/plain");
        if (rawText) {
          try {
            const data = JSON.parse(rawText);
            if (Array.isArray(data.ids)) ids = data.ids;
          } catch {}
        }
      }
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

  function downloadProjectZip(project: ProjectOut) {
    const link = document.createElement("a");
    link.href = `/api/projects/${project.id}/zip`;
    link.download = `${project.name}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Helper to render a folder card (reused for root and subprojects)
  function renderFolderCard(proj: ProjectOut) {
    const style = folderColorStyle(proj.color);
    const IconComp = getProjectIcon(proj.icon);
    const isOver = dragOverProjectId === proj.id;
    const hasTarget = proj.total_quantity_target > 0;
    const subCount = projects.filter((p) => p.parent_id === proj.id).length;

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
        onDrop={(e) => handleDrop(proj.id, e)}
        className={cn(
          "group relative cursor-pointer p-3 flex flex-col justify-between gap-2 transition-all duration-150 border select-none rounded-xl min-h-[96px]",
          isOver
            ? "border-primary bg-primary/10 ring-2 ring-primary shadow-md scale-[1.02]"
            : "hover:border-primary/40 hover:shadow-xs hover:bg-muted/30",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="p-2 rounded-lg bg-background border border-border/80 shadow-2xs shrink-0 group-hover:scale-105 transition-transform">
              <IconComp className={cn("size-4.5", style.icon)} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold truncate text-foreground leading-tight" title={proj.name}>
                {proj.name}
              </h3>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5">
                <span>
                  {proj.model_count} modèle{proj.model_count > 1 ? "s" : ""}
                </span>
                {subCount > 0 && (
                  <>
                    <span>·</span>
                    <span>
                      {subCount} sous-dossier{subCount > 1 ? "s" : ""}
                    </span>
                  </>
                )}
              </div>
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
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => downloadProjectZip(proj)}>
                  <DownloadIcon className="size-3.5 mr-1.5" />
                  Exporter (.zip)
                </DropdownMenuItem>
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

        {proj.description && (
          <p className="text-[11px] text-muted-foreground line-clamp-1 -mt-0.5" title={proj.description}>
            {proj.description}
          </p>
        )}

        {/* Barre de progression ou état du dossier */}
        {hasTarget ? (
          <div className="space-y-1 pt-1.5 border-t border-border/40">
            <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
              <span>
                {proj.total_quantity_printed}/{proj.total_quantity_target} pièce{proj.total_quantity_target > 1 ? "s" : ""}
              </span>
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
          <div className="pt-1.5 border-t border-border/40 flex items-center justify-between text-[11px] text-muted-foreground/70">
            <span className="text-[10px] text-muted-foreground/60">Projet 3D</span>
            <span className="text-[11px] text-primary/70 group-hover:text-primary transition-colors flex items-center gap-0.5 font-medium">
              Ouvrir <ChevronRightIcon className="size-3" />
            </span>
          </div>
        )}

        {/* Message au survol du drag & drop */}
        {isOver && (
          <div className="absolute inset-0 bg-primary/15 backdrop-blur-[1px] rounded-xl flex items-center justify-center p-2 text-center pointer-events-none">
            <span className="text-xs font-semibold text-primary bg-background/90 px-2.5 py-1 rounded-full shadow-xs">
              Déposer pour ranger / importer ici
            </span>
          </div>
        )}
      </Card>
    );
  }

  // --- Vue dossier sélectionné (Intérieur d'un dossier) ---
  if (activeProjectId && activeProject) {
    const style = folderColorStyle(activeProject.color);
    const ActiveIcon = getProjectIcon(activeProject.icon);
    const subProjects = projects.filter((p) => p.parent_id === activeProjectId);

    return (
      <div className="space-y-4">
        {/* Breadcrumb avec support drag & drop */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
          <div className="flex items-center gap-1.5 text-sm flex-wrap">
            <button
              type="button"
              onClick={() => onSelectProject(undefined)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverRoot(true);
              }}
              onDragLeave={() => setDragOverRoot(false)}
              onDrop={(e) => handleDrop(null, e)}
              className={cn(
                "flex items-center gap-1 px-2 py-1 rounded-md transition-all text-muted-foreground hover:text-foreground hover:bg-muted font-medium",
                dragOverRoot && "ring-2 ring-primary bg-primary/10 text-primary font-semibold scale-105",
              )}
            >
              <ArrowLeftIcon className="size-3.5 mr-0.5" />
              <span>Bibliothèque</span>
              {dragOverRoot && (
                <Badge variant="default" className="text-[10px] ml-1 py-0 px-1.5">
                  Déposer à la racine
                </Badge>
              )}
            </button>

            {ancestors.map((anc) => {
              const AncIcon = getProjectIcon(anc.icon);
              const isOverAnc = dragOverProjectId === anc.id;
              return (
                <div key={anc.id} className="flex items-center gap-1.5">
                  <span className="text-muted-foreground/60">/</span>
                  <button
                    type="button"
                    onClick={() => onSelectProject(anc.id)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDragOverProjectId(anc.id);
                    }}
                    onDragLeave={() => setDragOverProjectId(null)}
                    onDrop={(e) => handleDrop(anc.id, e)}
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-1 rounded-md transition-all text-muted-foreground hover:text-foreground hover:bg-muted font-medium text-xs",
                      isOverAnc && "ring-2 ring-primary bg-primary/10 text-primary font-semibold scale-105",
                    )}
                  >
                    <AncIcon className="size-3.5" />
                    <span>{anc.name}</span>
                  </button>
                </div>
              );
            })}

            <span className="text-muted-foreground/60">/</span>

            <div className="flex items-center gap-2 font-semibold text-foreground px-1.5 py-1">
              <ActiveIcon className={cn("size-4", style.icon)} />
              <span>{activeProject.name}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadProjectZip(activeProject)}
              className="gap-1.5 h-8 text-xs"
              title="Télécharger tous les fichiers du projet en .zip"
            >
              <DownloadIcon className="size-3.5" />
              <span>Télécharger (.zip)</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setCreateDialogParentId(activeProject.id);
                setCreateDialogOpen(true);
              }}
              className="gap-1.5 h-8 text-xs"
            >
              <FolderPlusIcon className="size-3.5" />
              <span>Sous-dossier</span>
            </Button>
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

        {/* Bannière de résumé du projet avec zone de drop globale pour ce dossier */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDragOverProjectId(activeProject.id);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDragOverProjectId(null);
            }
          }}
          onDrop={(e) => handleDrop(activeProject.id, e)}
          className={cn(
            "relative flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-border/60 bg-muted/20 transition-all",
            dragOverProjectId === activeProject.id && "border-primary bg-primary/10 ring-2 ring-primary",
          )}
        >
          <div className="flex items-start gap-3 min-w-0">
            <div className="p-2.5 rounded-xl bg-background border border-border/80 shadow-xs shrink-0">
              <ActiveIcon className={cn("size-6", style.icon)} />
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
                {subProjects.length > 0 && (
                  <>
                    <span>•</span>
                    <span>{subProjects.length} sous-dossier{subProjects.length > 1 ? "s" : ""}</span>
                  </>
                )}
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

        {/* Section sous-dossiers si existants */}
        {subProjects.length > 0 && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Sous-dossiers ({subProjects.length})
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCreateDialogParentId(activeProject.id);
                  setCreateDialogOpen(true);
                }}
                className="gap-1 h-6 text-xs text-muted-foreground hover:text-foreground"
              >
                <PlusIcon className="size-3" />
                Nouveau sous-dossier
              </Button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {subProjects.map((sub) => renderFolderCard(sub))}
            </div>
          </div>
        )}

        {/* Drop zone vide si aucun modèle ni sous-dossier dans ce dossier */}
        {totalModelsInView === 0 && subProjects.length === 0 && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOverProjectId(activeProject.id);
            }}
            onDragLeave={() => setDragOverProjectId(null)}
            onDrop={(e) => handleDrop(activeProject.id, e)}
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
              Glissez-déposez des modèles depuis la bibliothèque, ou déposez directement des fichiers .stl / .3mf depuis Windows pour les importer ici.
            </p>
          </div>
        )}

        {/* Modales de création / édition / suppression */}
        <ProjectDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          defaultParentId={createDialogParentId}
          onSuccess={(created) => {
            onSelectProject(created.id);
          }}
        />

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
                  onSelectProject(activeProject.parent_id ?? undefined);
                },
              });
            }}
          />
        )}
      </div>
    );
  }

  // --- Vue racine : Grille des dossiers de projets (parent_id == null) ---
  const rootProjects = projects.filter((p) => p.parent_id == null);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FolderOpenIcon className="size-4 text-muted-foreground" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Dossiers & Projets {rootProjects.length > 0 && `(${rootProjects.length})`}
          </h2>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setCreateDialogParentId(null);
            setCreateDialogOpen(true);
          }}
          className="gap-1.5 h-7 text-xs"
        >
          <FolderPlusIcon className="size-3.5" />
          Nouveau dossier
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {rootProjects.map((proj) => renderFolderCard(proj))}

        {/* Bouton "+ Nouveau dossier" rapide dans la grille */}
        <button
          type="button"
          onClick={() => {
            setCreateDialogParentId(null);
            setCreateDialogOpen(true);
          }}
          className="flex flex-col items-center justify-center gap-2 p-3 rounded-xl border border-dashed border-border/70 text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-muted/30 transition-all min-h-[96px] text-xs font-medium"
        >
          <div className="p-1.5 rounded-full bg-muted shrink-0 text-muted-foreground">
            <PlusIcon className="size-3.5" />
          </div>
          <span>Nouveau dossier</span>
        </button>
      </div>

      {/* Modale de création */}
      <ProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        defaultParentId={createDialogParentId}
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
