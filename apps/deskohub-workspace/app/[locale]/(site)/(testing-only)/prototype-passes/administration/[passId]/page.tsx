// PROTOTYPE ONLY: administration pass detail (#1362). Mock data, no backend.
// Dialogs: ?action=cancel | reassign | extend (&days=<n> for Unlimited).
import type { Metadata } from "next";
import { Suspense } from "react";
import { PassDetailScreen } from "@/features/passes/prototype/administration/pass-detail-screen";

export const metadata: Metadata = {
  title: "Prototype · Pass detail",
  robots: { index: false, follow: false },
};

type Params = Promise<{ readonly passId: string }>;

export default function PrototypePassDetailPage({ params }: { readonly params: Params }) {
  return (
    <Suspense fallback={null}>
      <PassDetail params={params} />
    </Suspense>
  );
}

async function PassDetail({ params }: { readonly params: Params }) {
  const { passId } = await params;
  return <PassDetailScreen passId={passId} />;
}
