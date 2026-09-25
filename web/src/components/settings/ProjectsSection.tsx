import { useState } from "react";
import { FolderIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useDeleteProject, useProjects } from "@/api/projects";
import type { ProjectOut } from "@/api/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProjectDialog } from "@/components/projects/ProjectDialog";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { tagColorClass } from "@/lib/tagColors";
import { cn } from "@/lib/utils";

function ProjectTableRow({ project }: { project: ProjectOut }) {
  const deleteProject = useDeleteProject();
  const [editOpen, setEditOpen] = useState(false);

  return (
    <>
      <TableRow>
        <TableCell className="font-medium">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn("size-2.5 shrink-0 rounded-full", tagColorClass(project.color) ?? "bg-muted-foreground")}
            />
            <span>{project.name}</span>
          </div>
          {project.description && (
            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{project.description}</p>
          )}
        </TableCell>
        <TableCell className="tabular-mono text-center">{project.model_count}</TableCell>
        <TableCell>
          <div className="flex flex-col gap-1 w-32">
            <div className="flex justify-between text-xs tabular-mono">
              <span>
                {project.total_quantity_printed}/{project.total_quantity_target}
              </span>
              <span className="font-medium">{project.progress_pct}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all duration-300 rounded-full"
                style={{ width: `${project.progress_pct}%` }}
              />
            </div>
          </div>
        </TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${project.name}`}
              onClick={() => setEditOpen(true)}
            >
              <PencilIcon className="size-3.5" />
            </Button>
            <ConfirmDialog
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${project.name}`}
                  disabled={deleteProject.isPending}
                >
                  <Trash2Icon className="size-3.5 text-destructive" />
                </Button>
              }
              title={`Delete project "${project.name}"?`}
              description="Models assigned to this project will remain in your library but will no longer be attached to this project."
              confirmLabel="Delete project"
              onConfirm={() => deleteProject.mutate(project.id)}
            />
          </div>
        </TableCell>
      </TableRow>

      <ProjectDialog project={project} open={editOpen} onOpenChange={setEditOpen} />
    </>
  );
}

export function ProjectsSection() {
  const { data: projects, isLoading } = useProjects();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FolderIcon className="size-5" />
              Projects
            </CardTitle>
            <CardDescription>
              Organize models into multi-part projects and track printing progress toward completion targets.
            </CardDescription>
          </div>
          <CardAction>
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
              <PlusIcon className="size-4" />
              New project
            </Button>
          </CardAction>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2 py-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : !projects || projects.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No projects yet. Create a project to group parts and track print completion.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead className="text-center">Models</TableHead>
                <TableHead>Print progress</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => (
                <ProjectTableRow key={project.id} project={project} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <ProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Card>
  );
}
