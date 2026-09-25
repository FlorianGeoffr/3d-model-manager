import { usePatchModel } from "@/api/library";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineEdit } from "@/components/InlineEdit";
import { renderMarkdown, MARKDOWN_CLASSNAME } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import type { ModelDetail } from "@/api/types";

/** Left-column card for the model description (moved out of `ModelHeader`
 * in R13a) -- edit-gated `InlineEdit` in edit mode, markdown
 * render otherwise. Owns its own `usePatchModel` mutation, same posture as
 * `TagEditor`. */
export function DescriptionCard({ model, editMode }: { model: ModelDetail; editMode: boolean }) {
  const patchModel = usePatchModel(model.slug);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Description</CardTitle>
      </CardHeader>
      <CardContent>
        {editMode ? (
          <InlineEdit
            value={model.description ?? ""}
            placeholder="Add a description… (markdown supported)"
            aria-label="description"
            multiline
            onSave={(description) => patchModel.mutate({ description: description || null })}
            displayClassName="text-sm text-muted-foreground w-full"
            renderDisplay={(val) =>
              val ? (
                <div
                  className={cn("text-muted-foreground", MARKDOWN_CLASSNAME)}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(val) }}
                />
              ) : null
            }
          />
        ) : model.description ? (
          <div
            className={cn("text-muted-foreground", MARKDOWN_CLASSNAME)}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(model.description) }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No description yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
