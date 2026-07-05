import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

export function CopyableHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(hash).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={hash}
      aria-label={`Copy hash ${hash}`}
      className="inline-flex items-center gap-1 rounded px-1 font-mono text-xs hover:bg-muted"
    >
      {hash.slice(0, 10)}
      {copied ? <CheckIcon className="size-3 text-emerald-600" /> : <CopyIcon className="size-3 text-muted-foreground" />}
    </button>
  );
}
