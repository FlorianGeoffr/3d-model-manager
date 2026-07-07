import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { StorageConfigIn, StorageConfigOut, StorageScheme } from "@/api/types";

type FieldKind = "text" | "password" | "number" | "checkbox" | "select";

interface SelectOption {
  value: string;
  label: string;
}

interface FieldSpec {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  placeholder?: string;
  options?: SelectOption[];
}

export const BACKEND_LABELS: Record<StorageScheme, string> = {
  local: "Local disk",
  smb: "SMB / CIFS network share",
  s3: "S3-compatible object storage",
};

/** Secret fields per backend -- the ones a save/test/migrate payload must
 * drop when left blank instead of overwriting the stored value (Task 7
 * brief: "leave blank = keep"). */
export const SECRET_FIELDS: Record<StorageScheme, string[]> = {
  local: [],
  smb: ["password"],
  s3: ["secret_key"],
};

const SMB_FIELDS: FieldSpec[] = [
  { name: "host", label: "Host", kind: "text", required: true, placeholder: "192.168.1.50 or nas.lan" },
  { name: "share", label: "Share", kind: "text", required: true },
  { name: "root", label: "Root path", kind: "text", placeholder: "(share root)" },
  { name: "username", label: "Username", kind: "text", required: true },
  { name: "password", label: "Password", kind: "password", required: true },
  { name: "port", label: "Port", kind: "number", placeholder: "445" },
  { name: "encrypt", label: "Encrypt (SMB3)", kind: "checkbox" },
];

const S3_FIELDS: FieldSpec[] = [
  { name: "bucket", label: "Bucket", kind: "text", required: true },
  { name: "access_key", label: "Access key", kind: "text", required: true },
  { name: "secret_key", label: "Secret key", kind: "password", required: true },
  { name: "endpoint_url", label: "Endpoint URL", kind: "text", placeholder: "(AWS default)" },
  { name: "region", label: "Region", kind: "text" },
  { name: "prefix", label: "Key prefix", kind: "text", placeholder: "(bucket root)" },
  {
    name: "addressing",
    label: "Addressing",
    kind: "select",
    options: [
      { value: "path", label: "Path-style (required for MinIO)" },
      { value: "virtual", label: "Virtual-hosted-style" },
    ],
  },
];

export const FIELDS_BY_BACKEND: Record<StorageScheme, FieldSpec[]> = {
  local: [],
  smb: SMB_FIELDS,
  s3: S3_FIELDS,
};

/** Required fields still blank in `draft`, skipping any secret field that's
 * allowed to stay blank because the backend already has one stored (Task 7:
 * "leave blank = keep" for a secret belonging to the currently-active
 * backend). Returns field labels for display; empty means the candidate is
 * ready to test/save/migrate. */
export function missingRequiredFields(draft: StorageConfigIn, active: StorageConfigOut | undefined): string[] {
  const secretFields = SECRET_FIELDS[draft.backend];
  const activeHasSecret = (name: string) =>
    active !== undefined && active.backend === draft.backend && active.config[name] === "***";

  return FIELDS_BY_BACKEND[draft.backend]
    .filter((field) => field.required)
    .filter((field) => {
      const raw = draft.config[field.name];
      const blank = raw === undefined || raw === "";
      if (!blank) return false;
      return !(secretFields.includes(field.name) && activeHasSecret(field.name));
    })
    .map((field) => field.label);
}

/** Drops blank secret fields from a candidate config before it's sent to
 * `/settings/storage`, `/settings/storage/test`, or `/settings/storage/migrate`
 * -- a blank secret field means "keep whatever is already stored", not
 * "set it to empty". */
export function stripBlankSecrets(draft: StorageConfigIn): StorageConfigIn {
  const secretFields = SECRET_FIELDS[draft.backend];
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft.config)) {
    if (secretFields.includes(key) && (value === undefined || value === "")) continue;
    config[key] = value;
  }
  return { backend: draft.backend, config };
}

/** Replaces the redacted `"***"` GET returns for a set secret with `""` so
 * the form never puts the sentinel into an input's value (Task 7: "secrets
 * are never displayed"). Pairs with `stripBlankSecrets` above: a field left
 * at `""` here is what "leave unchanged" looks like. */
export function seedDraft(out: StorageConfigOut): StorageConfigIn {
  const config = { ...out.config };
  for (const field of SECRET_FIELDS[out.backend]) {
    if (config[field] === "***") config[field] = "";
  }
  return { backend: out.backend, config };
}

interface StorageBackendFormProps {
  value: StorageConfigIn;
  onChange: (next: StorageConfigIn) => void;
  disabled?: boolean;
  idPrefix?: string;
}

/** Backend picker + per-backend connection fields (Task 7 brief). Fully
 * controlled: the caller (`SettingsPage`) owns the draft config so it can
 * feed the same value into Test/Save/Migrate. */
export function StorageBackendForm({ value, onChange, disabled, idPrefix = "storage" }: StorageBackendFormProps) {
  const fields = FIELDS_BY_BACKEND[value.backend];

  function setField(name: string, fieldValue: unknown) {
    onChange({ ...value, config: { ...value.config, [name]: fieldValue } });
  }

  return (
    <div className="space-y-4">
      <div className="flex max-w-xs flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-backend`}>Backend</Label>
        <Select
          value={value.backend}
          onValueChange={(next) => onChange({ backend: next as StorageScheme, config: {} })}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-backend`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(BACKEND_LABELS) as StorageScheme[]).map((scheme) => (
              <SelectItem key={scheme} value={scheme}>
                {BACKEND_LABELS[scheme]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No configuration needed -- files are stored under the server&apos;s local library root.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map((field) => {
            const id = `${idPrefix}-${field.name}`;
            const raw = value.config[field.name];

            if (field.kind === "checkbox") {
              return (
                <Label key={field.name} className="flex items-center gap-2 font-normal">
                  <Checkbox
                    id={id}
                    checked={raw === undefined ? true : Boolean(raw)}
                    onCheckedChange={(checked) => setField(field.name, checked === true)}
                    disabled={disabled}
                  />
                  {field.label}
                </Label>
              );
            }

            if (field.kind === "select" && field.options) {
              const current = typeof raw === "string" ? raw : field.options[0].value;
              return (
                <div key={field.name} className="flex flex-col gap-1.5">
                  <Label htmlFor={id}>{field.label}</Label>
                  <Select value={current} onValueChange={(next) => setField(field.name, next)} disabled={disabled}>
                    <SelectTrigger id={id}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {field.options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            }

            const stringValue = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
            return (
              <div key={field.name} className="flex flex-col gap-1.5">
                <Label htmlFor={id}>
                  {field.label}
                  {field.required ? " *" : ""}
                </Label>
                <Input
                  id={id}
                  type={field.kind === "password" ? "password" : field.kind === "number" ? "number" : "text"}
                  value={stringValue}
                  placeholder={field.kind === "password" ? "••• (unchanged)" : field.placeholder}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (field.kind === "number") {
                      setField(field.name, next === "" ? undefined : Number(next));
                    } else {
                      setField(field.name, next);
                    }
                  }}
                  disabled={disabled}
                  autoComplete={field.kind === "password" ? "new-password" : "off"}
                />
              </div>
            );
          })}
        </div>
      )}

      {value.backend === "s3" ? (
        <p className="text-xs text-muted-foreground">
          Set a bucket lifecycle rule to expire incomplete multipart uploads.
        </p>
      ) : null}
      {value.backend === "smb" ? (
        <p className="text-xs text-muted-foreground">
          Use an IP or a resolvable DNS name; container needs <code>extra_hosts:</code> for LAN names.
        </p>
      ) : null}
    </div>
  );
}
