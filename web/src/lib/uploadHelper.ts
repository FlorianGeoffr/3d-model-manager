import { toast } from "sonner";
import { api } from "@/api/client";
import { DuplicateUploadError, uploadFile } from "@/api/upload";
import type { ModelCreate, ModelDetail, ProjectOut } from "@/api/types";
import type { QueryClient } from "@tanstack/react-query";

export interface UploadFilesOptions {
  files: File[];
  targetProjectId: number | null;
  projects: ProjectOut[];
  createModel: (data: ModelCreate) => Promise<ModelDetail>;
  queryClient: QueryClient;
  onNavigate?: (slug: string) => void;
}

export async function uploadFilesWithDuplicateHandling({
  files,
  targetProjectId,
  projects,
  createModel,
  queryClient,
  onNavigate,
}: UploadFilesOptions): Promise<void> {
  if (files.length === 0) return;

  const targetProject = projects.find((p) => p.id === targetProjectId);
  const targetName = targetProject ? `"${targetProject.name}"` : "la bibliothèque générale";
  const toastId = toast.loading(
    `Importation de ${files.length} fichier${files.length > 1 ? "s" : ""} dans ${targetName}...`,
  );

  let successCount = 0;
  const duplicates: Array<{
    file: File;
    existing: { slug: string; name: string; url: string };
    suggestedName: string;
  }> = [];
  const errors: string[] = [];

  for (const file of files) {
    let createdModel: ModelDetail | null = null;
    try {
      const modelName = file.name.replace(/\.[^/.]+$/, "");
      createdModel = await createModel({
        name: modelName,
        project_id: targetProjectId ?? undefined,
      });

      if (createdModel.current_revision) {
        await uploadFile({
          modelId: createdModel.id,
          revisionId: createdModel.current_revision.id,
          relPath: file.name,
          file,
        });
        successCount++;
      }
    } catch (err) {
      if (createdModel) {
        try {
          await api.delete(`/models/${createdModel.slug}`);
        } catch {
          // ignore cleanup errors
        }
      }

      if (err instanceof DuplicateUploadError) {
        duplicates.push({
          file,
          existing: err.existing,
          suggestedName: err.suggestedName,
        });
      } else {
        console.error("Erreur lors de l'upload:", err);
        errors.push(file.name);
      }
    }
  }

  await queryClient.invalidateQueries({ queryKey: ["models"] });
  await queryClient.invalidateQueries({ queryKey: ["projects"] });

  if (successCount > 0) {
    toast.success(
      `${successCount} fichier${successCount > 1 ? "s" : ""} importé${successCount > 1 ? "s" : ""} dans ${targetName}`,
      { id: toastId },
    );
  } else {
    toast.dismiss(toastId);
  }

  if (duplicates.length === 1) {
    const dup = duplicates[0];
    if (targetProjectId !== null && targetProject) {
      toast.warning(`"${dup.file.name}" existe déjà dans la bibliothèque`, {
        description: `Ce fichier est déjà dans le modèle "${dup.existing.name}". Voulez-vous classer ce modèle dans "${targetProject.name}" ?`,
        action: {
          label: "Classer dans ce dossier",
          onClick: async () => {
            try {
              await api.patch(`/models/${dup.existing.slug}`, { project_id: targetProjectId });
              await queryClient.invalidateQueries({ queryKey: ["models"] });
              await queryClient.invalidateQueries({ queryKey: ["projects"] });
              toast.success(`Modèle "${dup.existing.name}" classé dans "${targetProject.name}"`);
            } catch {
              toast.error("Impossible de classer le modèle");
            }
          },
        },
        duration: 8000,
      });
    } else {
      toast.warning(`"${dup.file.name}" existe déjà dans la bibliothèque`, {
        description: `Identique au modèle existant "${dup.existing.name}".`,
        action: onNavigate
          ? {
              label: "Voir le modèle",
              onClick: () => onNavigate(dup.existing.slug),
            }
          : undefined,
        duration: 7000,
      });
    }
  } else if (duplicates.length > 1) {
    toast.warning(`${duplicates.length} fichiers existent déjà dans la bibliothèque`, {
      description: duplicates.map((d) => `"${d.file.name}" (dans "${d.existing.name}")`).join(", "),
      duration: 8000,
    });
  }

  if (errors.length > 0) {
    toast.error(`Échec de l'importation pour ${errors.length} fichier(s) : ${errors.join(", ")}`);
  }
}
