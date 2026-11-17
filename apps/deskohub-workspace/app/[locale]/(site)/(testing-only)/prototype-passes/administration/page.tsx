// PROTOTYPE ONLY: administration pass list (#1362). Mock data, no backend.
import type { Metadata } from "next";
import { Suspense } from "react";
import { PassListScreen } from "@/features/passes/prototype/administration/pass-list-screen";

export const metadata: Metadata = {
  title: "Prototype · Pass administration",
  robots: { index: false, follow: false },
};

export default function PrototypePassAdministrationPage() {
  return (
    <Suspense fallback={null}>
      <PassListScreen />
    </Suspense>
  );
}
