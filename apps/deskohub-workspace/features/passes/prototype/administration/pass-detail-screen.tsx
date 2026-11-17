"use client";

// PROTOTYPE ONLY: administration pass detail (#1362): facts, usage ledger,
// append-only audit trail, and the action dialogs (?action=…).

import { CalendarPlus, Ban, UserRoundPen } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  AdministrationDataTable,
  type AdministrationDataTableColumn,
} from "@/features/administration/data-table";
import { EmptyState } from "@/features/administration/empty-state";
import { AdministrationAlert } from "@/features/administration/notice";
import { AdministrationPage } from "@/features/administration/page-frame";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { Button } from "@/shared/components/ui/button";
import { StatusBadge } from "@/shared/components/ui/status-badge";
import {
  MONITOR_OPTIONS,
  type EntryPackPass,
  type PassUsageEntry,
  type PrototypePass,
  type UnlimitedPass,
} from "../mock-passes";
import {
  ADMIN_TODAY,
  adminBasePath,
  adminPassById,
  auditActionLabel,
  customerHref,
  entryPackCounts,
  firstUseDate,
  formatAdminDateTime,
  formatCzk,
  formatPrototypeDate,
  formatShortDate,
  formatWeekdayDate,
  isComplimentary,
  listPrice,
  productName,
  productSizeLabel,
  refundQuote,
  tierLabel,
  UNLIMITED_DAYS,
  validityLabel,
} from "./admin-pass-data";
import {
  CancelPassDialog,
  ExtendPassDialog,
  ReassignHolderDialog,
} from "./pass-action-dialogs";
import {
  EntryPackMeter,
  FactRows,
  PassBadges,
  UnlimitedDayStrip,
  useActionParam,
} from "./pass-presentation";
import { PrototypeAdminShell } from "./prototype-admin-shell";

const daysBetween = (from: string, to: string) =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000
  );

export function PassDetailScreen({ passId }: { readonly passId: string }) {
  const locale = useRouteLocale();
  const { action, searchParams, setAction } = useActionParam();
  const pass = adminPassById(passId);

  if (!pass) {
    return (
      <PrototypeAdminShell active="passes" crumbs={[{ label: "Passes", href: adminBasePath(locale) }, { label: passId }]}>
        <AdministrationPage>
          <EmptyState message={`No mock pass ${passId}.`} />
        </AdministrationPage>
      </PrototypeAdminShell>
    );
  }

  const open = (name: string) => (next: boolean) => setAction(next ? name : null);
  const live = pass.status === "active" || pass.status === "scheduled";
  const usedOn = firstUseDate(pass);
  const refundEvent = pass.audit.find((event) => event.action === "refund-marked");

  return (
    <PrototypeAdminShell
      active="passes"
      crumbs={[
        { label: "Passes", href: adminBasePath(locale) },
        { label: `${productName(pass)} · ${pass.holder.name}` },
      ]}
    >
      <AdministrationPage>
        <div data-shot="upper" className="mb-7 flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-burned-orange-ink">
              Pass {pass.id}
            </p>
            <h1 className="text-3xl leading-tight tracking-[-0.025em] sm:text-4xl">
              {productName(pass)} · {productSizeLabel(pass)}
            </h1>
            <p className="mt-2 text-sm leading-6 text-navy-blue/62">
              {tierLabel(pass.tier)} · held by{" "}
              <Link className="font-semibold text-navy-blue underline underline-offset-4" href={customerHref(locale, pass.holder.id)}>
                {pass.holder.name}
              </Link>
            </p>
            <div className="mt-3">
              <PassBadges pass={pass} />
            </div>
          </div>
          {live && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setAction("extend")} size="sm" type="button" variant="secondary">
                <CalendarPlus aria-hidden />
                Extend validity
              </Button>
              <Button onClick={() => setAction("reassign")} size="sm" type="button" variant="secondary">
                <UserRoundPen aria-hidden />
                Reassign holder
              </Button>
              <Button onClick={() => setAction("cancel")} size="sm" tone="burned-orange-ink" type="button" variant="secondary">
                <Ban aria-hidden />
                Cancel pass
              </Button>
            </div>
          )}
        </div>

        {live && usedOn && (
          <p data-shot="upper" className="-mt-4 mb-6 text-xs text-navy-blue/60">
            Holder can't be reassigned: first used {formatPrototypeDate(usedOn)}.
          </p>
        )}

        {pass.status === "cancelled" && refundEvent && (
          <AdministrationAlert className="mb-6" status="warning">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
              <p>
                <strong className="font-semibold">Refund to process: {formatCzk(refundQuote(pass).refund)}.</strong>{" "}
                Marked {formatAdminDateTime(refundEvent.at)}. Send it in the Nexi back office for order{" "}
                <span className="whitespace-nowrap">NX-{pass.id.slice(5)}-01</span>, then mark it refunded here.
              </p>
              <Button className="shrink-0 self-start sm:self-center" size="sm" type="button" variant="secondary">
                Mark as refunded
              </Button>
            </div>
          </AdministrationAlert>
        )}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-7">
            <div className="space-y-7" data-shot="upper">
              {pass.product === "entry-pack" ? <EntryPackUsage pass={pass} /> : <UnlimitedUsage pass={pass} />}
            </div>
            <div data-shot="lower">
              <AuditTrail pass={pass} />
            </div>
          </div>
          <PassFacts pass={pass} />
        </div>
      </AdministrationPage>

      {pass.status !== "cancelled" && (
        <>
          <CancelPassDialog onOpenChange={open("cancel")} open={action === "cancel"} pass={pass} />
          <ReassignHolderDialog onOpenChange={open("reassign")} open={action === "reassign"} pass={pass} />
          <ExtendPassDialog
            days={Number(searchParams.get("days") ?? 5)}
            onOpenChange={open("extend")}
            open={action === "extend"}
            pass={pass}
          />
        </>
      )}
    </PrototypeAdminShell>
  );
}

function SectionHeading({ children, aside }: { readonly children: ReactNode; readonly aside?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="text-xl">{children}</h2>
      {aside && <p className="text-sm text-navy-blue/65">{aside}</p>}
    </div>
  );
}

const ledgerEvent: Record<PassUsageEntry["kind"], { label: string; tone: "attention" | "neutral" | "positive" | "progress" }> = {
  "entry-used": { label: "Used", tone: "neutral" },
  "entry-booked": { label: "Booked", tone: "progress" },
  "entry-released": { label: "Released", tone: "attention" },
  "day-used": { label: "Visited", tone: "neutral" },
  "day-reserved": { label: "Reserved", tone: "progress" },
  "day-released": { label: "Released", tone: "attention" },
};

function EntryPackUsage({ pass }: { readonly pass: EntryPackPass }) {
  const counts = entryPackCounts(pass);
  const daysLeft = daysBetween(ADMIN_TODAY, pass.validUntil);
  const rows = [...pass.usage].sort((a, b) => b.date.localeCompare(a.date));
  const columns: readonly AdministrationDataTableColumn<PassUsageEntry>[] = [
    {
      accessorKey: "date",
      cell: ({ row }) => <span className="whitespace-nowrap font-medium">{formatWeekdayDate(row.original.date)}</span>,
      enableSorting: false,
      header: "Date",
      id: "date",
    },
    {
      accessorFn: (entry) => entry.kind,
      cell: ({ row }) => (
        <StatusBadge tone={ledgerEvent[row.original.kind].tone}>{ledgerEvent[row.original.kind].label}</StatusBadge>
      ),
      enableSorting: false,
      header: "Entry",
      id: "kind",
    },
    {
      accessorFn: (entry) => entry.note ?? "",
      cell: ({ row }) => <span className="text-navy-blue/68">{row.original.note ?? "—"}</span>,
      enableSorting: false,
      header: "Booking",
      id: "note",
    },
    {
      accessorFn: (entry) => entry.addonsPaid ?? 0,
      cell: ({ row }) => (row.original.addonsPaid ? formatCzk(row.original.addonsPaid) : "CZK 0"),
      enableSorting: false,
      header: "Add-ons paid",
      id: "paid",
      meta: { cellClassName: "whitespace-nowrap text-right", headClassName: "whitespace-nowrap text-right" },
    },
  ];

  return (
    <>
      <section>
        <SectionHeading
          aside={
            pass.status === "active"
              ? `Valid until ${formatPrototypeDate(pass.validUntil)} · ${daysLeft} days left`
              : `Valid ${validityLabel(pass)}`
          }
        >
          Usage
        </SectionHeading>
        <div className="rounded-xl border border-navy-blue/10 bg-white p-5">
          <EntryPackMeter
            counts={counts}
            freeLabel={{ cancelled: "Refunded", expired: "Expired unused" }[pass.status as string] ?? "Free"}
          />
        </div>
      </section>
      <section>
        <SectionHeading aside="Each booked date claims one entry; a failed payment releases it.">Entries</SectionHeading>
        {rows.length === 0 ? (
          <EmptyState message="No entries booked yet." />
        ) : (
          <AdministrationDataTable
            ariaLabel="Entry ledger"
            columns={columns}
            data={rows}
            getRowId={(entry) => `${entry.date}-${entry.kind}`}
            mobile={
              <ul className="divide-y divide-navy-blue/10">
                {rows.map((entry) => (
                  <li className="flex items-start justify-between gap-3 px-4 py-3" key={`${entry.date}-${entry.kind}`}>
                    <div className="min-w-0">
                      <p className="font-medium">{formatWeekdayDate(entry.date)}</p>
                      {entry.note && <p className="mt-0.5 text-sm text-navy-blue/65">{entry.note}</p>}
                      <p className="mt-0.5 text-xs text-navy-blue/55">
                        Add-ons paid {entry.addonsPaid ? formatCzk(entry.addonsPaid) : "CZK 0"}
                      </p>
                    </div>
                    <StatusBadge className="shrink-0" tone={ledgerEvent[entry.kind].tone}>
                      {ledgerEvent[entry.kind].label}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            }
            tableClassName="min-w-[520px]"
          />
        )}
      </section>
    </>
  );
}

function UnlimitedUsage({ pass }: { readonly pass: UnlimitedPass }) {
  const codes = pass.usage.filter((entry) => entry.kind === "day-used" || entry.note?.includes("code"));
  return (
    <>
      <section>
        <SectionHeading aside={`${formatShortDate(pass.startDate)} – ${formatPrototypeDate(pass.endDate)}`}>
          Usage
        </SectionHeading>
        <div className="rounded-xl border border-navy-blue/10 bg-white p-5">
          <UnlimitedDayStrip pass={pass} />
        </div>
      </section>
      <section>
        <SectionHeading aside="Grouped as one purchase">Reservations</SectionHeading>
        <div className="overflow-hidden rounded-xl border border-navy-blue/10 bg-white">
          <div className="grid gap-3 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0">
              <p className="font-semibold">{UNLIMITED_DAYS} daily reservations, one purchase</p>
              <p className="mt-1 text-sm text-navy-blue/65">
                {tierLabel(pass.tier)}
                {pass.deskLabel && ` · ${pass.deskLabel}`} ·{" "}
                {pass.deskLabel ? "midnight to midnight, same desk every day" : "00:00–17:00 each day"}
              </p>
              <p className="mt-0.5 text-sm text-navy-blue/65">Funded by this pass, CZK 0 each</p>
            </div>
            <StatusBadge className="w-fit" tone={pass.status === "scheduled" ? "progress" : "positive"}>
              {pass.status === "scheduled" ? "All 30 reserved" : "Reserved in Dotypos"}
            </StatusBadge>
          </div>
          <details className="border-t border-navy-blue/10">
            <summary className="cursor-pointer px-5 py-3 text-sm font-semibold">Show the {UNLIMITED_DAYS} reservations</summary>
            <p className="px-5 pb-4 text-sm text-navy-blue/65">R-{pass.id.slice(5)}-01 … R-{pass.id.slice(5)}-30</p>
          </details>
          <div className="border-t border-navy-blue/10 px-5 py-4">
            <p className="text-xs font-semibold uppercase tracking-[0.1em] text-navy-blue/65">Access codes issued</p>
            {codes.length === 0 ? (
              <p className="mt-2 text-sm text-navy-blue/65">
                None yet. The first code is created on {formatPrototypeDate(pass.startDate)} when the holder opens the
                access page.
              </p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-2 text-sm">
                {codes.map((entry) => (
                  <li className="rounded-lg bg-navy-blue/[0.05] px-2.5 py-1" key={entry.date}>
                    {formatShortDate(entry.date)}
                    {entry.date === ADMIN_TODAY && " (today)"}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function AuditTrail({ pass }: { readonly pass: PrototypePass }) {
  const events = pass.audit
    .map((event, index) => ({ ...event, index }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.index - a.index);
  return (
    <section>
      <SectionHeading aside="Append-only">Audit trail</SectionHeading>
      <ol className="rounded-xl border border-navy-blue/10 bg-white px-5 py-2">
        {events.map((event, index) => (
          <li className="relative grid grid-cols-[1rem_minmax(0,1fr)] gap-3 py-3" key={`${event.at}-${index}`}>
            <span aria-hidden className="relative flex justify-center">
              <span className="mt-1.5 size-2.5 rounded-full bg-burned-orange" />
              {index < events.length - 1 && (
                <span className="absolute bottom-[-1.25rem] top-5 w-px bg-navy-blue/15" />
              )}
            </span>
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold">{auditActionLabel[event.action]}</span>
                <span className="text-xs text-navy-blue/55">{formatAdminDateTime(event.at)}</span>
              </p>
              <p className="mt-0.5 break-words text-sm text-navy-blue/75">{event.detail}</p>
              <p className="mt-0.5 break-all text-xs text-navy-blue/55">by {event.actor}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PassFacts({ pass }: { readonly pass: PrototypePass }) {
  const locale = useRouteLocale();
  const monitor =
    pass.product === "unlimited" && pass.monitorOption
      ? MONITOR_OPTIONS.find((option) => option.key === pass.monitorOption)?.label
      : undefined;
  return (
    <aside className="space-y-5 xl:sticky xl:top-24 xl:h-fit" data-shot="lower">
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.1em] text-navy-blue/65">Holder</h2>
        <div className="rounded-xl border border-navy-blue/10 bg-white px-4 py-3">
          <Link className="font-semibold underline underline-offset-4" href={customerHref(locale, pass.holder.id)}>
            {pass.holder.name}
          </Link>
          <p className="mt-0.5 break-all text-sm text-navy-blue/65">{pass.holder.email}</p>
          <p className="mt-2 text-sm">
            {pass.holderVerified ? (
              <StatusBadge tone="positive">Email verified</StatusBadge>
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <StatusBadge tone="progress">Not verified</StatusBadge>
                <span className="text-xs text-navy-blue/60">Can't book until verified</span>
              </span>
            )}
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.1em] text-navy-blue/65">Pass</h2>
        <FactRows
          rows={[
            { label: "Product", value: `${productName(pass)}, ${productSizeLabel(pass)}` },
            { label: "Tier", value: tierLabel(pass.tier) },
            { label: "Valid", value: validityLabel(pass) },
            ...(pass.product === "unlimited" && pass.deskLabel ? [{ label: "Desk", value: pass.deskLabel }] : []),
            ...(monitor ? [{ label: "Monitors", value: monitor }] : []),
            ...(pass.product === "unlimited" ? [{ label: "Coffee", value: pass.coffee ? "Included" : "No" }] : []),
          ]}
        />
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.1em] text-navy-blue/65">Purchase</h2>
        <FactRows
          rows={
            isComplimentary(pass)
              ? [
                  { label: "Source", value: "Granted by an administrator" },
                  { label: "Total", value: "CZK 0" },
                  { label: "Granted", value: formatAdminDateTime(pass.purchasedAt) },
                ]
              : [
                  {
                    label: "Bought by",
                    value: pass.buyer && (
                      <Link className="underline underline-offset-4" href={customerHref(locale, pass.buyer.id)}>
                        {pass.buyer.name}
                      </Link>
                    ),
                    hint: pass.buyer?.id === pass.holder.id ? "Same as holder" : "For someone else",
                  },
                  {
                    label: "Paid",
                    value: formatCzk(pass.paid),
                    hint:
                      pass.discountLabel ??
                      (pass.product === "unlimited" && pass.coffee ? "Incl. coffee CZK 690" : undefined),
                  },
                  ...(listPrice(pass) !== pass.paid ? [{ label: "List price", value: formatCzk(listPrice(pass)) }] : []),
                  { label: "Purchased", value: formatAdminDateTime(pass.purchasedAt) },
                  { label: "Nexi order", value: <span className="font-mono text-xs">NX-{pass.id.slice(5)}-01</span> },
                  { label: "Invoice", value: <span className="font-mono text-xs">FV-2026-{pass.id.slice(5)}</span> },
                ]
          }
        />
      </section>
    </aside>
  );
}
