import { type FormEvent, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ImageIcon, RefreshCwIcon } from "lucide-react";

import { ApiError } from "@/api/client";
import {
  useApprovePending,
  useDismissPending,
  useFollowCollection,
  useFollowCollectionByUrl,
  useFollowedCollections,
  usePendingImports,
  useRemoteLists,
  useSetCollectionMode,
  useSyncCollectionsNow,
  useUnfollowCollection,
} from "@/api/collections";
import type { CollectionSyncMode, FollowedCollection, PendingImport, RemoteList } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";

/** "Saved" surface (M8 H): the remote collections/likes you follow, what a sync
 * should do with each (auto-import vs review), the review queue, and a manual
 * "Sync now". Browsing a site's lists needs that site's credential connected in
 * Settings (MakerWorld web token / Thingiverse App Token / Printables account);
 * a site without one contributes nothing, hence the explicit empty state. */
export function SavedPanel() {
  const followed = useFollowedCollections();
  const pending = usePendingImports();
  const syncNow = useSyncCollectionsNow();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Followed collections</CardTitle>
          <CardDescription>
            Lists you follow are re-checked on each sync. New models are imported straight away
            (auto) or queued for you to approve (review).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={syncNow.isPending}
              onClick={() => syncNow.mutate()}
            >
              <RefreshCwIcon />
              {syncNow.isPending ? "Syncing…" : "Sync now"}
            </Button>
            {syncNow.isError && (
              <p role="alert" className="text-sm text-destructive">
                {syncNow.error instanceof ApiError ? syncNow.error.detail : "Could not start the sync."}
              </p>
            )}
          </div>

          {followed.isLoading ? (
            <Skeleton className="h-20 w-full rounded-lg" />
          ) : (followed.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              You aren&apos;t following any collections yet.
            </p>
          ) : (
            <div className="space-y-2">
              {(followed.data ?? []).map((collection) => (
                <FollowedRow key={collection.id} collection={collection} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ReviewQueue items={pending.data ?? []} loading={pending.isLoading} />

      <BrowseLists />
    </div>
  );
}

function FollowedRow({ collection }: { collection: FollowedCollection }) {
  const setMode = useSetCollectionMode();
  const unfollow = useUnfollowCollection();

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{collection.title}</p>
        <p className="font-mono text-xs text-muted-foreground">
          <span className="capitalize">{collection.site}</span> · {collection.kind} ·{" "}
          {collection.last_synced_at ? `synced ${formatDate(collection.last_synced_at)}` : "never synced"}
        </p>
        {collection.last_error && (
          <p role="alert" className="text-xs text-destructive">
            {collection.last_error}
          </p>
        )}
      </div>
      <Select
        value={collection.mode}
        onValueChange={(mode) => setMode.mutate({ id: collection.id, mode: mode as CollectionSyncMode })}
      >
        <SelectTrigger aria-label={`Sync mode for ${collection.title}`} size="sm" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Auto-import</SelectItem>
          <SelectItem value="review">Review</SelectItem>
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={unfollow.isPending}
        onClick={() => unfollow.mutate(collection.id)}
      >
        Unfollow
      </Button>
    </div>
  );
}

function ReviewQueue({ items, loading }: { items: PendingImport[]; loading: boolean }) {
  const approve = useApprovePending();
  const dismiss = useDismissPending();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review queue</CardTitle>
        <CardDescription>
          New models found in your <em>review</em> lists. Nothing enters the library until you
          import it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waiting for review.</p>
        ) : (
          <div
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
            data-testid="review-queue"
          >
            {items.map((item) => (
              <Card key={item.id} className="gap-2 overflow-hidden" size="sm">
                <div className="relative flex aspect-square items-center justify-center bg-muted">
                  {item.thumbnail_url ? (
                    <img src={item.thumbnail_url} alt={item.title} className="h-full w-full object-cover" />
                  ) : (
                    <ImageIcon className="size-8 text-muted-foreground" />
                  )}
                  <Badge variant="secondary" className="absolute top-1.5 left-1.5 capitalize backdrop-blur-sm">
                    {item.site}
                  </Badge>
                </div>
                <CardContent className="flex flex-col gap-1.5">
                  <h3 className="truncate text-sm font-medium" title={item.title}>
                    {item.title}
                  </h3>
                  <div className="flex gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      disabled={approve.isPending}
                      onClick={() => approve.mutate(item.id)}
                    >
                      Import
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={dismiss.isPending}
                      onClick={() => dismiss.mutate(item.id)}
                    >
                      Dismiss
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** MakerWorld's own SSR collections page is intermittently Cloudflare-walled,
 * so `useRemoteLists` can come back without a collection the user actually
 * has -- pasting its URL follows it directly (`POST /collections/from-url`)
 * without needing it to show up in the browsable list first. */
function AddCollectionByUrl() {
  const [url, setUrl] = useState("");
  const followByUrl = useFollowCollectionByUrl();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || followByUrl.isPending) {
      return;
    }
    followByUrl.mutate({ url: trimmed }, { onSuccess: () => setUrl("") });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2" data-testid="add-collection-by-url">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="collection-url" className="sr-only">
          Collection URL
        </Label>
        <Input
          id="collection-url"
          type="url"
          placeholder="https://makerworld.com/…/collections/…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className="h-8 max-w-sm flex-1"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!url.trim() || followByUrl.isPending}>
          {followByUrl.isPending ? "Following…" : "Follow"}
        </Button>
      </div>
      {followByUrl.isError && (
        <p role="alert" className="text-sm text-destructive">
          {followByUrl.error instanceof ApiError ? followByUrl.error.detail : "Could not follow that collection."}
        </p>
      )}
    </form>
  );
}

function BrowseLists() {
  const lists = useRemoteLists();
  const follow = useFollowCollection();
  const followed = useFollowedCollections();
  const followedKeys = new Set((followed.data ?? []).map((c) => `${c.site}:${c.list_id}`));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your collections on each site</CardTitle>
        <CardDescription>Follow a list to keep it synced with your library.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AddCollectionByUrl />
        {lists.isLoading ? (
          <Skeleton className="h-20 w-full rounded-lg" />
        ) : (lists.data ?? []).length === 0 ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              No collections found yet. To sync your saved models, connect each site in{" "}
              <Link to="/settings" className="underline">
                Settings
              </Link>{" "}
              → Imports:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <span className="font-medium text-foreground">MakerWorld</span> — paste your web
                token under Gallery site tokens.
              </li>
              <li>
                <span className="font-medium text-foreground">Thingiverse</span> — paste your App
                Token under Gallery site tokens.
              </li>
              <li>
                <span className="font-medium text-foreground">Printables</span> — connect your
                account.
              </li>
            </ul>
          </div>
        ) : (
          <div className="space-y-2" data-testid="remote-lists">
            {(lists.data ?? []).map((list: RemoteList) => {
              const already = followedKeys.has(`${list.site}:${list.list_id}`);
              return (
                <div
                  key={`${list.site}:${list.list_id}`}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{list.title}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      <span className="capitalize">{list.site}</span> · {list.kind}
                      {list.count !== null ? ` · ${list.count} models` : ""}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={already || follow.isPending}
                    onClick={() =>
                      follow.mutate({
                        site: list.site,
                        list_id: list.list_id,
                        kind: list.kind,
                        title: list.title,
                        mode: "review",
                      })
                    }
                  >
                    {already ? "Following" : "Follow"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
