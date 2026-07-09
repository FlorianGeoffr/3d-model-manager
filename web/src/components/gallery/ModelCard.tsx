import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ClockIcon, FileStackIcon, XIcon } from "lucide-react";

import { usePatchModel } from "@/api/library";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { SpecRow, type SpecItem } from "@/components/ui/spec-row";
import { FORMAT_LABELS, formatIcon } from "@/lib/formatMeta";
import { formatDate, humanizeDuration } from "@/lib/format";
import type { ModelSummary } from "@/api/types";

const VISIBLE_TAGS = 3;

export function ModelCard({ model }: { model: ModelSummary }) {
  const [coverErrored, setCoverErrored] = useState(false);
  const patchModel = usePatchModel(model.slug);
  const visibleTags = model.tags.slice(0, VISIBLE_TAGS);
  const overflowCount = model.tags.length - visibleTags.length;
  const primaryFormat = model.formats[0];
  const Icon = formatIcon(primaryFormat);
  const showCover = model.cover !== null && !coverErrored;
  const needsReview = model.review_state === "adopted";

  // Datasheet spec row: only the fields the gallery summary actually carries
  // (filament colors/material live in per-blob plate metadata, off the gallery
  // hot path — those chips appear on the model detail + viewer instead).
  const specItems: Array<SpecItem | null> = [
    model.print_time_s !== null
      ? { icon: <ClockIcon />, label: humanizeDuration(model.print_time_s) }
      : null,
    model.has_sliced ? { label: "Sliced" } : null,
    model.file_count > 0
      ? {
          icon: <FileStackIcon />,
          label: `${model.file_count} ${model.file_count === 1 ? "file" : "files"}`,
        }
      : null,
  ];

  // The card body is a `<Link>` (whole-card navigation); dismissing the
  // badge must not also trigger that navigation, so stop the click before
  // it reaches the anchor's handler.
  function dismissReview(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    patchModel.mutate({ review_state: null });
  }

  return (
    <Link to="/models/$slug" params={{ slug: model.slug }} className="group block">
      <Card className="h-full gap-3 overflow-hidden py-0 pb-4 transition-shadow hover:shadow-md">
        <div className="relative aspect-square overflow-hidden bg-muted">
          {showCover ? (
            <img
              src={model.cover ?? undefined}
              alt={model.name}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
              onError={() => setCoverErrored(true)}
            />
          ) : (
            <div
              className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground"
              data-testid="format-thumb"
            >
              <Icon className="size-10" />
              <span className="text-xs font-semibold tracking-wide">
                {primaryFormat ? FORMAT_LABELS[primaryFormat] : "—"}
              </span>
            </div>
          )}
          {model.source_site && (
            <Badge
              variant="secondary"
              className="absolute top-2 left-2 capitalize backdrop-blur-sm"
              data-testid="source-badge"
            >
              {model.source_site}
            </Badge>
          )}
          {needsReview && (
            <Badge
              variant="secondary"
              className="absolute top-2 right-2 gap-1 pr-1 backdrop-blur-sm"
              data-testid="review-badge"
            >
              Needs review
              <button
                type="button"
                aria-label="Dismiss needs review"
                className="rounded-full hover:opacity-70"
                onClick={dismissReview}
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          )}
        </div>
        <CardContent className="flex flex-col gap-2 px-4">
          <h3 className="truncate text-sm font-medium" title={model.name}>
            {model.name}
          </h3>

          <SpecRow data-testid="model-spec" items={specItems} />

          {visibleTags.length > 0 && (
            <div className="flex min-h-5 flex-wrap gap-1">
              {visibleTags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
              {overflowCount > 0 && <Badge variant="outline">+{overflowCount}</Badge>}
            </div>
          )}

          <div className="flex flex-wrap gap-1" data-testid="format-badges">
            {model.formats.map((format) => (
              <Badge key={format} variant="outline">
                {FORMAT_LABELS[format]}
              </Badge>
            ))}
          </div>

          <p className="font-mono text-xs text-muted-foreground">
            Updated {formatDate(model.updated_at)}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
