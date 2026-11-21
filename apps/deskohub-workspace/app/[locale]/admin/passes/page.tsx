import { Suspense } from "react";
import { AdministrationRouteLoading } from "@/features/administration/loading";
import { AdminPassListScreen } from "@/features/passes/admin/pass-list-screen";

export default function AdminPassesPage() {
  return (
    <Suspense fallback={<AdministrationRouteLoading />}>
      <AdminPassListScreen />
    </Suspense>
  );
}
