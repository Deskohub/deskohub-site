"use client";

// PROTOTYPE ONLY (#1361): copies the door code; shows a short confirmation.
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/shared/components/ui/button";

export function CopyCodeButton({ code }: { readonly code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      onClick={() => {
        void navigator.clipboard?.writeText(code);
        setCopied(true);
      }}
      size="lg"
      variant="secondary"
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span aria-live="polite">{copied ? "Copied" : "Copy code"}</span>
    </Button>
  );
}
