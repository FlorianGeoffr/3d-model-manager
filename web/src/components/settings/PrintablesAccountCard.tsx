/**
 * Printables account connect card (Workstream A task A1; mirrors
 * `BambuAccountCard`'s card structure/conventions). Printables has no login
 * flow this app can drive itself -- the Prusa OAuth client/`redirect_uri`
 * belong to Printables -- so "connect" means pasting the browser's
 * `auth.refresh_token` cookie value, which the backend validates, rotates,
 * and stores encrypted (`backend/app/services/printables_auth.py`).
 *
 * The refresh-token field is write-only: it makes one connect POST and is
 * never echoed back by any response. No token is ever rendered here --
 * status only ever carries `connected`/`username`/`user_id`
 * (`PrintablesStatusOut`), never an access/refresh token.
 */
import { useState } from "react";

import { ApiError } from "@/api/client";
import { usePrintablesConnect, usePrintablesDisconnect, usePrintablesStatus } from "@/api/printables";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export function PrintablesAccountCard() {
  const status = usePrintablesStatus();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Printables account</CardTitle>
        <CardDescription>
          Connect a Printables account so your saved collections and liked prints can sync.
          Printables has no login this app can drive itself -- paste your browser&apos;s refresh
          token cookie instead.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.isLoading ? (
          <Skeleton className="h-32 w-full rounded-lg" />
        ) : status.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {status.error instanceof ApiError ? status.error.detail : "Couldn't load Printables account status."}
          </p>
        ) : status.data?.connected ? (
          <ConnectedView username={status.data.username} />
        ) : (
          <ConnectForm />
        )}
      </CardContent>
    </Card>
  );
}

function ConnectedView({ username }: { username: string | null }) {
  const disconnect = usePrintablesDisconnect();

  return (
    <div className="space-y-3">
      <p className="text-sm text-foreground">
        Connected as <span className="font-medium">{username ?? "unknown account"}</span>
      </p>
      <Button type="button" variant="outline" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
        {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
      </Button>
      {disconnect.isError && (
        <p role="alert" className="text-sm text-destructive">
          {disconnect.error instanceof ApiError ? disconnect.error.detail : "Could not disconnect."}
        </p>
      )}
    </div>
  );
}

function ConnectForm() {
  const [refreshToken, setRefreshToken] = useState("");
  const connect = usePrintablesConnect();

  function submit() {
    connect.mutate(
      { refresh_token: refreshToken.trim() },
      { onSuccess: () => setRefreshToken("") },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="printables-refresh-token">Refresh token</Label>
        <Input
          id="printables-refresh-token"
          type="password"
          value={refreshToken}
          onChange={(e) => setRefreshToken(e.target.value)}
          disabled={connect.isPending}
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          In your browser: DevTools → Application → Cookies → https://www.printables.com → copy
          the value of <code>auth.refresh_token</code>.
        </p>
      </div>
      <Button type="button" disabled={connect.isPending || !refreshToken.trim()} onClick={submit}>
        {connect.isPending ? "Connecting…" : "Connect"}
      </Button>
      {connect.isError && (
        <p role="alert" className="text-sm text-destructive">
          {connect.error instanceof ApiError ? connect.error.detail : "Could not connect."}
        </p>
      )}
    </div>
  );
}
