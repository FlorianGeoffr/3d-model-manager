import { useState } from "react";
import { FolderPlusIcon, FolderIcon } from "lucide-react";
import { useProjects } from "@/api/projects";
import { ProjectDialog } from "@/components/projects/ProjectDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { tagColorClass } from "@/lib/tagColors";
import { cn } from "@/lib/utils";

const NONE_VALUE = "__none__";
const NEW_PROJECT_VALUE = "__new_project__";

export function ProjectPicker({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (projectId: number | null) => void;
  disabled?: boolean;
}) {
  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? [];
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  function handleValueChange(next: string) {
    if (next === NEW_PROJECT_VALUE) {
      setCreateDialogOpen(true);
      return;
    }
    onChange(next === NONE_VALUE ? null : Number(next));
  }

  return (
    <>
      <Select
        value={value !== null ? String(value) : NONE_VALUE}
        onValueChange={handleValueChange}
        disabled={disabled}
      >
        <SelectTrigger aria-label="Project" className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <FolderIcon className="size-3.5" />
              No project
            </span>
          </SelectItem>
          {projects.map((project) => (
            <SelectItem key={project.id} value={String(project.id)}>
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn("size-2 shrink-0 rounded-full", tagColorClass(project.color) ?? "bg-muted-foreground")}
                />
                <span className="truncate">{project.name}</span>
              </span>
            </SelectItem>
          ))}
          <SelectItem value={NEW_PROJECT_VALUE} className="border-t border-border mt-1 pt-1 font-medium text-primary">
            <span className="flex items-center gap-1.5">
              <FolderPlusIcon className="size-3.5" />
              + New project…
            </span>
          </SelectItem>
        </SelectContent>
      </Select>

      <ProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSuccess={(created) => {
          onChange(created.id);
        }}
      />
    </>
  );
}
