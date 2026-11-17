"use client";

// PROTOTYPE ONLY (#1361): like the email-preview EmailPreviewFrame, but with
// the envelope (subject, from, to) and an iframe sized to the whole email.
import { useEffect, useRef, useState } from "react";

export function PrototypeEmailFrame({
  from,
  html,
  subject,
  to,
}: {
  readonly from: string;
  readonly html: string;
  readonly subject: string;
  readonly to: string;
}) {
  const [height, setHeight] = useState(1200);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const fit = () => {
    const body = frameRef.current?.contentDocument?.body;
    if (body) setHeight(body.scrollHeight);
  };
  // The frame may finish loading before hydration attaches onLoad.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure once
  useEffect(fit, []);
  return (
    <div
      className="rounded-3xl bg-white/76 p-2 shadow-2xl shadow-navy-blue/12 ring-1 ring-navy-blue/8 sm:p-4"
      data-email-area=""
    >
      <dl className="mb-2 grid gap-1 rounded-2xl bg-navy-blue px-4 py-3 text-sm text-white sm:mb-4 sm:px-5 sm:py-4">
        {[
          ["Subject", subject],
          ["From", from],
          ["To", to],
        ].map(([label, value]) => (
          <div className="flex min-w-0 gap-3" key={label}>
            <dt className="w-16 shrink-0 text-white/60">{label}</dt>
            <dd className="min-w-0 break-words font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <iframe
        className="block w-full rounded-2xl bg-white"
        onLoad={fit}
        ref={frameRef}
        sandbox="allow-same-origin"
        srcDoc={html}
        style={{ height }}
        title={subject}
      />
    </div>
  );
}
