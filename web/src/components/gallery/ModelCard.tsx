import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ClockIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { FORMAT_LABELS, formatIcon } from "@/lib/formatMeta";
import { formatDate, humanizeDuration } from "@/lib/format";
import type { ModelSummary } from "@/api/types";

const VISIBLE_TAGS = 3;

export function ModelCard({ model }: { model: ModelSummary }) {
  const [coverErrored, setCoverErrored] = useState(false);
  const visibleTags = model.tags.slice(0, VISIBLE_TAGS);
  const overflowCount = model.tags.length - visibleTags.length;
  const primaryFormat = model.formats[0];
  const Icon = formatIcon(primaryFormat);
  const showCover = model.cover !== null && !coverErrored;

  return (
    <Link to="/models/$slug" params={{ slug: model.slug }} className="block">
      <Card className="h-full gap-3 overflow-hidden transition-shadow hover:shadow-md">
        <div className="flex aspect-square items-center justify-center bg-muted">
          {showCover ? (
            <img
              src={model.cover ?? undefined}
              alt={model.name}
              className="h-full w-full object-cover"
              onError={() => setCoverErrored(true)}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-muted-foreground" data-testid="format-thumb">
              <Icon className="size-10" />
              <span className="text-xs font-semibold tracking-wide">
                {primaryFormat ? FORMAT_LABELS[primaryFormat] : "—"}
              </span>
            </div>
          )}
        </div>
        <CardContent className="flex flex-col gap-2">
          <h3 className="truncate text-sm font-medium" title={model.name}>
            {model.name}
          </h3>
          <div className="flex min-h-5 flex-wrap gap-1">
            {visibleTags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
            {overflowCount > 0 && <Badge variant="outline">+{overflowCount}</Badge>}
          </div>
          <div className="flex flex-wrap gap-1" data-testid="format-badges">
            {model.formats.map((format) => (
              <Badge key={format} variant="outline">
                {FORMAT_LABELS[format]}
              </Badge>
            ))}
          </div>
          {(model.has_sliced || model.print_time_s !== null) && (
            <div className="flex flex-wrap gap-1" data-testid="status-badges">
              {model.has_sliced && <Badge variant="secondary">Sliced</Badge>}
              {model.print_time_s !== null && (
                <Badge variant="outline">
                  <ClockIcon className="size-3" /> {humanizeDuration(model.print_time_s)}
                </Badge>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">Updated {formatDate(model.updated_at)}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
