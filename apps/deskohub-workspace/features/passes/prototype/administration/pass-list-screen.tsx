"use client";

// PROTOTYPE ONLY: administration pass list (#1362). Filters work on the mock
// list through search params; "Grant pass" opens the grant dialog (?action=grant).

import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  AdministrationDataTable,
  type AdministrationDataTableColumn,
} from "@/features/administration/data-table";
import { EmptyState } from "@/features/administration/empty-state";
import {
  AdministrationFilterField,
  AdministrationFilterForm,
  AdministrationFilterInput,
  AdministrationFilterSelect,
} from "@/features/administration/filter-controls";
import { AdministrationPage } from "@/features/administration/page-frame";
import {
  AdministrationTableCount,
  AdministrationTableToolbar,
} from "@/features/administration/table-toolbar";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { Button } from "@/shared/components/ui/button";
import { PASS_TIERS, type PrototypePass } from "../mock-passes";
import {
  ADMIN_PASSES,
  customerHref,
  formatPrototypeDate,
  paidLabel,
  passHref,
  productName,
  productSizeLabel,
  remainingDetail,
  remainingLabel,
  tierLabel,
  validityEnd,
  validityLabel,
  validityStart,
} from "./admin-pass-data";
import { GrantPassDialog } from "./grant-pass-dialog";
import { PassBadges, PassStatusBadge, UnverifiedHolderBadge, useActionParam } from "./pass-presentation";
import { PrototypeAdminShell } from "./prototype-admin-shell";

const filterKeys = ["q", "product", "tier", "status", "source"] as const;

const matches = (pass: PrototypePass, params: URLSearchParams) => {
  const q = params.get("q")?.trim().toLowerCase();
  const product = params.get("product");
  const tier = params.get("tier");
  const status = params.get("status");
  const source = params.get("source");
  if (q) {
    const haystack = [pass.id, pass.holder.name, pass.holder.email, pass.buyer?.name, pass.buyer?.email]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (product && pass.product !== product) return false;
  if (tier && pass.tier !== tier) return false;
  if (status && pass.status !== status) return false;
  if (source === "paid" && pass.buyer === null) return false;
  if (source === "complimentary" && pass.buyer !== null) return false;
  if (source === "gift" && (pass.buyer === null || pass.buyer.id === pass.holder.id)) return false;
  return true;
};

export function PassListScreen() {
  const locale = useRouteLocale();
  const router = useRouter();
  const pathname = usePathname();
  const { action, searchParams, setAction } = useActionParam();
  const passes = ADMIN_PASSES.filter((pass) => matches(pass, searchParams));
  const filtered = filterKeys.some((key) => searchParams.get(key));

  const setFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const columns: readonly AdministrationDataTableColumn<PrototypePass>[] = [
    {
      accessorFn: (pass) => pass.holder.name,
      cell: ({ row }) => <HolderCell locale={locale} pass={row.original} />,
      enableSorting: false,
      header: "Holder",
      id: "holder",
    },
    {
      accessorFn: (pass) => productName(pass),
      cell: ({ row }) => (
        <div>
          <p className="whitespace-nowrap font-medium">
            {productName(row.original)}, {productSizeLabel(row.original)}
          </p>
          <p className="mt-0.5 text-xs text-navy-blue/60">{tierLabel(row.original.tier)}</p>
        </div>
      ),
      enableSorting: false,
      header: "Product",
      id: "product",
      meta: { cellClassName: "max-w-[13rem]" },
    },
    {
      accessorFn: (pass) => remainingLabel(pass),
      cell: ({ row }) => (
        <div className="whitespace-nowrap">
          <p className="font-medium">{remainingLabel(row.original)}</p>
          {remainingDetail(row.original) && (
            <p className="mt-0.5 text-xs text-navy-blue/60">{remainingDetail(row.original)}</p>
          )}
        </div>
      ),
      enableSorting: false,
      header: "Remaining",
      id: "remaining",
    },
    {
      accessorFn: (pass) => validityLabel(pass),
      cell: ({ row }) => (
        <div className="whitespace-nowrap">
          <p>to {formatPrototypeDate(validityEnd(row.original))}</p>
          <p className="mt-0.5 text-xs text-navy-blue/60">from {formatPrototypeDate(validityStart(row.original))}</p>
        </div>
      ),
      enableSorting: false,
      header: "Valid",
      id: "validity",
      meta: { cellClassName: "text-navy-blue/80" },
    },
    {
      accessorFn: (pass) => paidLabel(pass),
      cell: ({ row }) =>
        row.original.buyer ? (
          <span className="font-medium">{paidLabel(row.original)}</span>
        ) : (
          <span className="text-navy-blue/60">Granted</span>
        ),
      enableSorting: false,
      header: "Paid",
      id: "paid",
      meta: { cellClassName: "whitespace-nowrap text-right", headClassName: "text-right" },
    },
    {
      accessorFn: (pass) => pass.status,
      cell: ({ row }) => <PassStatusBadge pass={row.original} />,
      enableSorting: false,
      header: "Status",
      id: "status",
    },
  ];

  return (
    <PrototypeAdminShell active="passes" crumbs={[{ label: "Passes" }]}>
      <AdministrationPage>
        <h1 className="sr-only">Passes</h1>
        <AdministrationTableToolbar
          actions={
            <Button onClick={() => setAction("grant")} size="sm" type="button">
              <Plus aria-hidden />
              Grant pass
            </Button>
          }
          count={<AdministrationTableCount count={passes.length} label={`${passes.length} passes`} />}
          filters={
            <AdministrationFilterForm className="grid-cols-2 lg:grid-cols-4" onSubmit={(event) => event.preventDefault()}>
              <AdministrationFilterField htmlFor="pass-product" label="Product">
                <AdministrationFilterSelect
                  id="pass-product"
                  onChange={(event) => setFilter("product", event.target.value)}
                  value={searchParams.get("product") ?? ""}
                >
                  <option value="">All products</option>
                  <option value="entry-pack">Entry pack</option>
                  <option value="unlimited">Unlimited</option>
                </AdministrationFilterSelect>
              </AdministrationFilterField>
              <AdministrationFilterField htmlFor="pass-tier" label="Tier">
                <AdministrationFilterSelect
                  id="pass-tier"
                  onChange={(event) => setFilter("tier", event.target.value)}
                  value={searchParams.get("tier") ?? ""}
                >
                  <option value="">All tiers</option>
                  {PASS_TIERS.map((tier) => (
                    <option key={tier.key} value={tier.key}>
                      {tier.label}
                    </option>
                  ))}
                </AdministrationFilterSelect>
              </AdministrationFilterField>
              <AdministrationFilterField htmlFor="pass-status" label="Status">
                <AdministrationFilterSelect
                  id="pass-status"
                  onChange={(event) => setFilter("status", event.target.value)}
                  value={searchParams.get("status") ?? ""}
                >
                  <option value="">All statuses</option>
                  <option value="active">Active</option>
                  <option value="scheduled">Scheduled</option>
                  <option value="used-up">Used up</option>
                  <option value="expired">Expired</option>
                  <option value="cancelled">Cancelled</option>
                </AdministrationFilterSelect>
              </AdministrationFilterField>
              <AdministrationFilterField htmlFor="pass-source" label="Source">
                <AdministrationFilterSelect
                  id="pass-source"
                  onChange={(event) => setFilter("source", event.target.value)}
                  value={searchParams.get("source") ?? ""}
                >
                  <option value="">All sources</option>
                  <option value="paid">Paid</option>
                  <option value="gift">Bought for others</option>
                  <option value="complimentary">Granted</option>
                </AdministrationFilterSelect>
              </AdministrationFilterField>
            </AdministrationFilterForm>
          }
          label="Pass table controls"
          search={
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-navy-blue/45"
              />
              <AdministrationFilterInput
                aria-label="Search holder or buyer"
                className="pl-9"
                defaultValue={searchParams.get("q") ?? ""}
                onChange={(event) => setFilter("q", event.target.value)}
                placeholder="Name, email or pass ID"
                type="search"
              />
            </div>
          }
        />
        <section className="mt-7">
          {passes.length === 0 ? (
            <EmptyState message={filtered ? "No passes match these filters." : "No passes yet."} />
          ) : (
            <AdministrationDataTable
              ariaLabel="Passes"
              columns={columns}
              data={passes}
              getRowId={(pass) => pass.id}
              mobile={
                <ul className="divide-y divide-navy-blue/10">
                  {passes.map((pass) => (
                    <li key={pass.id}>
                      <Link
                        className="block px-4 py-4 transition-colors hover:bg-navy-blue/[0.025]"
                        href={passHref(locale, pass.id)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-semibold">{pass.holder.name}</p>
                            <p className="mt-0.5 text-sm text-navy-blue/65">
                              {productName(pass)} · {productSizeLabel(pass)}
                            </p>
                            <p className="text-sm text-navy-blue/65">{tierLabel(pass.tier)}</p>
                          </div>
                          <span className="shrink-0 pt-0.5 text-sm font-semibold">
                            {pass.buyer ? paidLabel(pass) : "CZK 0"}
                          </span>
                        </div>
                        <div className="mt-3">
                          <PassBadges pass={pass} />
                        </div>
                        <p className="mt-2.5 text-xs text-navy-blue/60">
                          <span className="font-semibold text-navy-blue">{remainingLabel(pass)}</span>
                          {" · "}
                          {validityLabel(pass)}
                        </p>
                        {pass.buyer && pass.buyer.id !== pass.holder.id && (
                          <p className="mt-1 text-xs text-navy-blue/60">Bought by {pass.buyer.name}</p>
                        )}
                        {!pass.buyer && <p className="mt-1 text-xs text-navy-blue/60">Granted by an administrator</p>}
                      </Link>
                    </li>
                  ))}
                </ul>
              }
              tableClassName="min-w-[880px]"
            />
          )}
        </section>
      </AdministrationPage>
      <GrantPassDialog onOpenChange={(open) => setAction(open ? "grant" : null)} open={action === "grant"} />
    </PrototypeAdminShell>
  );
}

function HolderCell({ locale, pass }: { readonly locale: string; readonly pass: PrototypePass }) {
  const { buyer, holder } = pass;
  return (
    <div className="min-w-0">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link
          className="font-semibold underline decoration-navy-blue/20 underline-offset-4 before:absolute before:inset-0 before:content-[''] hover:decoration-navy-blue"
          href={passHref(locale, pass.id)}
        >
          {holder.name}
        </Link>
        {!pass.holderVerified && <UnverifiedHolderBadge />}
      </span>
      <p className="mt-0.5 text-xs text-navy-blue/60">{holder.email}</p>
      {buyer && buyer.id !== holder.id && (
        <p className="mt-1 text-xs text-navy-blue/60">
          Bought by{" "}
          <Link
            className="relative z-10 font-medium text-navy-blue underline decoration-navy-blue/20 underline-offset-4"
            href={customerHref(locale, buyer.id)}
          >
            {buyer.name}
          </Link>
        </p>
      )}
      {!buyer && <p className="mt-1 text-xs text-navy-blue/60">Granted by an administrator</p>}
    </div>
  );
}
