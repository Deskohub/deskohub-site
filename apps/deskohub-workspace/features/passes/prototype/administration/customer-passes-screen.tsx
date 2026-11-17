"use client";

// PROTOTYPE ONLY: the administration customer detail with a Passes section
// (#1362). Mirrors features/administration/customer-detail.tsx with mock
// stats; the reservation activity calendar and real tables are left out.

import { Plus } from "lucide-react";
import Link from "next/link";
import { AdministrationFact } from "@/features/administration/detail-components";
import { EmptyState } from "@/features/administration/empty-state";
import { AdministrationPage, AdministrationPageHeader } from "@/features/administration/page-frame";
import { AdministrationTableFrame } from "@/features/administration/table-frame";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { Button } from "@/shared/components/ui/button";
import { StatusBadge } from "@/shared/components/ui/status-badge";
import type { PrototypePass } from "../mock-passes";
import {
  adminCustomerById,
  formatCzk,
  paidLabel,
  passesBoughtForOthersBy,
  passesHeldBy,
  passHref,
  productName,
  productSizeLabel,
  remainingLabel,
  tierLabel,
  validityLabel,
} from "./admin-pass-data";
import { GrantPassDialog } from "./grant-pass-dialog";
import { PassStatusBadge, UnverifiedHolderBadge, useActionParam } from "./pass-presentation";
import { PrototypeAdminShell } from "./prototype-admin-shell";

export function CustomerPassesScreen({ customerId }: { readonly customerId: string }) {
  const locale = useRouteLocale();
  const { action, setAction } = useActionParam();
  const customer = adminCustomerById(customerId);
  if (!customer) {
    return (
      <PrototypeAdminShell active="customers" crumbs={[{ label: "Customers" }, { label: customerId }]}>
        <AdministrationPage>
          <EmptyState message={`No mock customer ${customerId}.`} />
        </AdministrationPage>
      </PrototypeAdminShell>
    );
  }
  const held = passesHeldBy(customer.id);
  const boughtForOthers = passesBoughtForOthersBy(customer.id);
  const spentOnPasses = [...held, ...boughtForOthers]
    .filter((pass) => pass.buyer?.id === customer.id)
    .reduce((sum, pass) => sum + pass.paid, 0);

  return (
    <PrototypeAdminShell
      active="customers"
      crumbs={[{ label: "Customers", href: `/${locale}/admin/customers` }, { label: customer.name }]}
    >
      <AdministrationPage>
        <AdministrationPageHeader title={customer.name} />

        <div className="mb-7 grid gap-5 lg:grid-cols-2">
          <section>
            <h2 className="mb-3 text-xl">Statistics</h2>
            <dl className="overflow-hidden rounded-xl border border-navy-blue/10 bg-white">
              {[
                ["Reservations", "14"],
                ["Revenue", "CZK 4,870"],
                ["Spent on passes", formatCzk(spentOnPasses)],
                ["Favourite product", "Open Space"],
                ["Discount savings", "CZK 310"],
              ].map(([label, value]) => (
                <div
                  className="flex items-baseline justify-between gap-4 border-b border-navy-blue/8 px-4 py-2.5 last:border-b-0 odd:bg-navy-blue/[0.025]"
                  key={label}
                >
                  <dt className="text-sm text-navy-blue/72">{label}</dt>
                  <dd className="text-right font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <h2 className="mb-3 text-xl">Consents</h2>
            <dl className="overflow-hidden rounded-xl border border-navy-blue/10 bg-white">
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <dt className="font-medium">Marketing emails</dt>
                <dd className="text-sm text-navy-blue/65 sm:text-right">
                  <StatusBadge tone="positive">Granted</StatusBadge> · 2 Oct 2026, 11:14
                </dd>
              </div>
            </dl>
          </section>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-7">
            <section aria-labelledby="customer-passes-heading">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl" id="customer-passes-heading">
                  Passes
                </h2>
                <Button
                  onClick={() => setAction("grant", { customer: customer.id })}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  <Plus aria-hidden />
                  Grant pass
                </Button>
              </div>
              <div className="space-y-5">
                <div>
                  <h3 className="mb-2 font-semibold">Held by {customer.name.split(" ")[0]}</h3>
                  <CustomerPassTable emptyMessage="No passes." passes={held} person="buyer" />
                </div>
                <div>
                  <h3 className="mb-2 font-semibold">Bought for others</h3>
                  <CustomerPassTable
                    emptyMessage="Hasn't bought a pass for anyone else."
                    passes={boughtForOthers}
                    person="holder"
                  />
                </div>
              </div>
            </section>

            <section>
              <h2 className="mb-3 text-xl">Reservations</h2>
              <details className="overflow-hidden rounded-xl border border-navy-blue/10 bg-white">
                <summary className="cursor-pointer px-5 py-4 font-semibold">Past reservations (12)</summary>
              </details>
              <p className="mt-3 text-sm text-navy-blue/60">
                Current reservations and transactions render here as today. Pass-funded dates appear in them with a
                “Pass” badge.
              </p>
            </section>
          </div>

          <aside className="space-y-5 xl:sticky xl:top-24 xl:h-fit">
            <section className="rounded-xl border border-navy-blue/10 bg-white p-5">
              <h2 className="font-semibold">Contact</h2>
              <dl className="mt-4 grid gap-4 text-sm">
                <AdministrationFact label="Email" value={<span className="break-all">{customer.email}</span>} />
                <AdministrationFact label="Phone" value="+420 600 000 000" />
                <AdministrationFact label="Discount group" value="None" />
              </dl>
            </section>
          </aside>
        </div>
      </AdministrationPage>
      <GrantPassDialog onOpenChange={(open) => setAction(open ? "grant" : null)} open={action === "grant"} />
    </PrototypeAdminShell>
  );
}

function CustomerPassTable({
  emptyMessage,
  passes,
  person,
}: {
  readonly emptyMessage: string;
  readonly passes: readonly PrototypePass[];
  /** The other party shown per row: who bought a held pass, or who holds a gift. */
  readonly person: "buyer" | "holder";
}) {
  const locale = useRouteLocale();
  if (passes.length === 0) return <EmptyState message={emptyMessage} />;
  const partyLine = (pass: PrototypePass) =>
    person === "holder"
      ? `Holder: ${pass.holder.name}`
      : pass.buyer === null
        ? "Granted by an administrator"
        : pass.buyer.id === pass.holder.id
          ? "Own purchase"
          : `Bought by ${pass.buyer.name}`;
  return (
    <AdministrationTableFrame>
      <ul className="divide-y divide-navy-blue/10">
        {passes.map((pass) => (
          <li key={pass.id}>
            <Link
              className="grid gap-x-6 gap-y-2.5 px-4 py-4 hover:bg-navy-blue/[0.025] sm:grid-cols-[minmax(0,1fr)_10rem_10.5rem] sm:items-center sm:px-5"
              href={passHref(locale, pass.id)}
            >
              <div className="min-w-0">
                <p className="font-semibold underline decoration-navy-blue/20 underline-offset-4">
                  {productName(pass)}, {productSizeLabel(pass)}
                </p>
                <p className="mt-0.5 text-sm text-navy-blue/65">{tierLabel(pass.tier)}</p>
                <p className="mt-0.5 text-xs text-navy-blue/60">
                  {partyLine(pass)}
                </p>
              </div>
              <div className="min-w-0 text-sm">
                <p className="font-semibold">{remainingLabel(pass)}</p>
                <p className="mt-0.5 text-xs text-navy-blue/60">{validityLabel(pass)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                <span className="flex flex-wrap gap-1.5">
                  <PassStatusBadge pass={pass} />
                  {!pass.holderVerified && <UnverifiedHolderBadge />}
                </span>
                <span className="text-sm font-semibold sm:order-first">
                  {pass.buyer ? paidLabel(pass) : <span className="font-normal text-navy-blue/60">Granted · CZK 0</span>}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </AdministrationTableFrame>
  );
}

