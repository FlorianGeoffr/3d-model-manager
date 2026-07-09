/**
 * Bambu Lab account connect card (Workstream B task B3; mirrors
 * `SiteTokensCard`'s masked-secret card style and `PrinterSetupCard`'s
 * draft-state/pending-disable/`role="alert"` conventions). Connecting an
 * account powers MakerWorld's authenticated search + file downloads --
 * anonymous MakerWorld access only sees trending results and can't download
 * files (see `backend/app/services/bambu_auth.py`).
 *
 * The password field is write-only: it makes one login POST and is never
 * echoed back by any response. No token is ever rendered here -- status
 * only ever carries `connected`/`account`/`region` (`BambuStatusOut`), never
 * an access/refresh token.
 */
import { useState } from "react";

import { useBambuDisconnect, useBambuLogin, useBambuStatus, useBambuVerify } from "@/api/bambu";
import { ApiError } from "@/api/client";
import type { BambuRegion } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

const REGIONS: ReadonlyArray<{ value: BambuRegion; label: string }> = [
  { value: "global", label: "Global" },
  { value: "china", label: "China" },
];

export function BambuAccountCard() {
  const status = useBambuStatus();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bambu Lab account</CardTitle>
        <CardDescription>
          Connect a Bambu account so MakerWorld search returns accurate results and file downloads
          aren&apos;t gated. Anonymous MakerWorld access only sees trending models.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.isLoading ? (
          <Skeleton className="h-32 w-full rounded-lg" />
        ) : status.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {status.error instanceof ApiError ? status.error.detail : "Couldn't load Bambu account status."}
          </p>
        ) : status.data?.connected ? (
          <ConnectedView account={status.data.account} />
        ) : (
          <LoginForm />
        )}
      </CardContent>
    </Card>
  );
}

function ConnectedView({ account }: { account: string | null }) {
  const disconnect = useBambuDisconnect();

  return (
    <div className="space-y-3">
      <p className="text-sm text-foreground">
        Connected as <span className="font-medium">{account ?? "unknown account"}</span>
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

function LoginForm() {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [region, setRegion] = useState<BambuRegion>("global");
  const [code, setCode] = useState("");
  // Opaque continuation carried from a `mfa_required` login response into
  // the follow-up verify call -- `BambuLoginOut.mfa_context` echoed back as
  // `BambuVerifyIn.mfa_context` (backend/app/schemas/settings.py). Never a
  // secret itself, just whatever Bambu's login response needs to complete
  // the challenge.
  const [mfaContext, setMfaContext] = useState<Record<string, unknown> | null>(null);

  const login = useBambuLogin();
  const verify = useBambuVerify();

  const mfaRequired = mfaContext !== null;
  const busy = login.isPending || verify.isPending;

  function submitLogin() {
    login.mutate(
      { account: account.trim(), password, region },
      {
        onSuccess: (result) => {
          setPassword("");
          if (result.status === "mfa_required") setMfaContext(result.mfa_context ?? {});
        },
      },
    );
  }

  function submitVerify() {
    verify.mutate(
      { account: account.trim(), code: code.trim(), region, mfa_context: mfaContext ?? {} },
      { onSuccess: () => setCode("") },
    );
  }

  function startOver() {
    setMfaContext(null);
    setCode("");
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bambu-account">Email</Label>
          <Input
            id="bambu-account"
            type="email"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            disabled={busy || mfaRequired}
            autoComplete="username"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bambu-region">Region</Label>
          <Select
            value={region}
            onValueChange={(value) => setRegion(value as BambuRegion)}
            disabled={busy || mfaRequired}
          >
            <SelectTrigger id="bambu-region">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REGIONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="bambu-password">Password</Label>
          <Input
            id="bambu-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy || mfaRequired}
            autoComplete="current-password"
          />
        </div>
      </div>

      {!mfaRequired ? (
        <Button type="button" disabled={busy || !account.trim() || !password} onClick={submitLogin}>
          {login.isPending ? "Connecting…" : "Connect"}
        </Button>
      ) : (
        <div className="space-y-3 border-t pt-4">
          <p className="text-sm text-muted-foreground">
            Bambu sent a verification code to {account}. Enter it below to finish connecting.
          </p>
          <div className="flex max-w-xs flex-col gap-1.5">
            <Label htmlFor="bambu-code">Verification code</Label>
            <Input
              id="bambu-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={verify.isPending}
              placeholder="Code from email/SMS"
              autoComplete="one-time-code"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={verify.isPending || !code.trim()} onClick={submitVerify}>
              {verify.isPending ? "Verifying…" : "Verify"}
            </Button>
            <Button type="button" variant="ghost" disabled={verify.isPending} onClick={startOver}>
              Start over
            </Button>
          </div>
        </div>
      )}

      {login.isError && (
        <p role="alert" className="text-sm text-destructive">
          {login.error instanceof ApiError ? login.error.detail : "Could not connect."}
        </p>
      )}
      {verify.isError && (
        <p role="alert" className="text-sm text-destructive">
          {verify.error instanceof ApiError ? verify.error.detail : "Could not verify the code."}
        </p>
      )}
    </div>
  );
}
