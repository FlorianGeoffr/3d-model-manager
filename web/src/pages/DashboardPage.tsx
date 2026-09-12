/**
 * Dashboard page (R11-B item 13): a read-only overview of the library --
 * stat tiles, a format histogram, storage-by-backend breakdown, 7-day
 * activity, and printer job counts. Backed by the single cached
 * `GET /api/stats` aggregate (`@/api/stats`); no chart library, everything
 * is CSS bars per the Global Constraints "BUNDLE RULE".
 */
import { Link } from "@tanstack/react-router";

import { ApiError } from "@/api/client";
import { useStats } from "@/api/stats";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageContainer } from "@/components/ui/page-container";
import { Skeleton } from "@/components/ui/skeleton";
import { humanizeBytes } from "@/lib/format";

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <Card size="sm">
      <CardContent className="space-y-1">
        <p className="text-2xl font-semibold tabular-nums text-foreground">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

/** A labeled horizontal bar, its width relative to `max` -- the CSS-only
 * "chart" the Global Constraints bundle rule calls for. */
function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-foreground">{label}</span>
        <span className="text-muted-foreground">{value}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function DashboardPage() {
  const statsQuery = useStats();

  return (
    <PageContainer width="default">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground">An overview of your library, storage, and prints.</p>
      </div>

      {statsQuery.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : statsQuery.isError || !statsQuery.data ? (
        <Card className="mx-auto mt-12 max-w-md">
          <CardHeader className="items-center text-center">
            <CardTitle>Couldn&apos;t load the dashboard</CardTitle>
            <CardDescription>
              {statsQuery.error instanceof ApiError ? statsQuery.error.detail : "Something went wrong."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <DashboardContent stats={statsQuery.data} />
      )}
    </PageContainer>
  );
}

function DashboardContent({ stats }: { stats: NonNullable<ReturnType<typeof useStats>["data"]> }) {
  const formatEntries = Object.entries(stats.files.by_format).sort(([, a], [, b]) => b - a);
  const maxFormatCount = Math.max(1, ...formatEntries.map(([, count]) => count));
  const backendEntries = Object.entries(stats.files.bytes_by_backend).sort(([, a], [, b]) => b - a);
  const maxBackendBytes = Math.max(1, ...backendEntries.map(([, bytes]) => bytes));

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Models" value={stats.models.total} />
        <StatTile label="Favorites" value={stats.models.favorites} />
        <StatTile label="Archived" value={stats.models.archived} />
        <StatTile label="Drafts" value={stats.models.drafts} />
        <StatTile label="Files" value={stats.files.total} />
        <StatTile label="Storage used" value={humanizeBytes(stats.files.bytes_total)} />
        <StatTile label="Tags" value={stats.tags} />
        <StatTile label="Followed collections" value={stats.collections} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Prints</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-xl font-semibold tabular-nums">{stats.prints.total}</p>
                <p className="text-xs text-muted-foreground">Logged</p>
              </div>
              <div>
                <p className="text-xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {stats.prints.succeeded}
                </p>
                <p className="text-xs text-muted-foreground">Succeeded</p>
              </div>
              <div>
                <p className="text-xl font-semibold tabular-nums text-destructive">{stats.prints.failed}</p>
                <p className="text-xs text-muted-foreground">Failed</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {Math.round(stats.prints.filament_g_total)} g filament ·{" "}
              {Math.round(stats.prints.duration_s_total / 3600)} h print time (all-time)
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity (7 days)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="font-semibold tabular-nums">{stats.recent.models_added_7d}</span>{" "}
              <span className="text-muted-foreground">models added</span>
            </p>
            <p>
              <span className="font-semibold tabular-nums">{stats.recent.prints_7d}</span>{" "}
              <span className="text-muted-foreground">prints logged</span>
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Files by format</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {formatEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No files yet.</p>
            ) : (
              formatEntries.map(([format, count]) => (
                <Bar key={format} label={format} value={count} max={maxFormatCount} />
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Storage by backend</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {backendEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No files yet.</p>
            ) : (
              backendEntries.map(([name, bytes]) => (
                <Bar key={name} label={`${name} — ${humanizeBytes(bytes)}`} value={bytes} max={maxBackendBytes} />
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Printer jobs</CardTitle>
          <CardDescription>
            <Link to="/jobs" className="underline">
              View all jobs
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-xl font-semibold tabular-nums">{stats.jobs.running}</p>
              <p className="text-xs text-muted-foreground">Running</p>
            </div>
            <div>
              <p className="text-xl font-semibold tabular-nums">{stats.jobs.queued}</p>
              <p className="text-xs text-muted-foreground">Queued</p>
            </div>
            <div>
              <p className="text-xl font-semibold tabular-nums text-destructive">{stats.jobs.failed_24h}</p>
              <p className="text-xs text-muted-foreground">Failed (24h)</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
