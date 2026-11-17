// PROTOTYPE ONLY: administration customer detail with passes (#1362). Mock data.
import type { Metadata } from "next";
import { Suspense } from "react";
import { CustomerPassesScreen } from "@/features/passes/prototype/administration/customer-passes-screen";

export const metadata: Metadata = {
  title: "Prototype · Customer passes",
  robots: { index: false, follow: false },
};

type Params = Promise<{ readonly customerId: string }>;

export default function PrototypeCustomerPassesPage({ params }: { readonly params: Params }) {
  return (
    <Suspense fallback={null}>
      <CustomerPasses params={params} />
    </Suspense>
  );
}

async function CustomerPasses({ params }: { readonly params: Params }) {
  const { customerId } = await params;
  return <CustomerPassesScreen customerId={customerId} />;
}
