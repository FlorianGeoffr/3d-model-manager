import { useState } from "react";

import { ApiError } from "@/api/client";
import { useImportTokens, useUpdateImportTokens } from "@/api/imports";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export function SiteTokensCard() {
  const tokens = useImportTokens();
  const update = useUpdateImportTokens();
  const [token, setToken] = useState("");

  if (tokens.isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
  const isSet = tokens.data?.thingiverse_token === "***";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gallery site tokens</CardTitle>
        <CardDescription>
          Thingiverse needs a personal App Token to download files. Create a &quot;Desktop app&quot; at
          thingiverse.com/apps/create and paste the token here. Printables needs no token.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="thingiverse-token">Thingiverse App Token</Label>
          <Input
            id="thingiverse-token"
            type="password"
            autoComplete="new-password"
            value={token}
            placeholder={isSet ? "•• (stored — leave blank to keep)" : "paste your app token"}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <Button
          type="button"
          disabled={update.isPending}
          onClick={() => update.mutate({ thingiverse_token: token }, { onSuccess: () => setToken("") })}
        >
          {update.isPending ? "Saving…" : "Save token"}
        </Button>
        {update.isError && (
          <p role="alert" className="text-sm text-destructive">
            {update.error instanceof ApiError ? update.error.detail : "Could not save the token."}
          </p>
        )}
        {update.isSuccess && <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>}
      </CardContent>
    </Card>
  );
}
