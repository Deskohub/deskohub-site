"use client";

// PROTOTYPE ONLY: grant a complimentary Entry pack or Unlimited (#1362).
// Opens with ?action=grant; ?product=unlimited and ?customer=<id> preset it.

import { CheckCircle2, Search, X } from "lucide-react";
import { useState } from "react";
import { AdministrationFilterSelect } from "@/features/administration/filter-controls";
import { AdministrationAlert } from "@/features/administration/notice";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { DateInput } from "@/shared/components/date-time/date-input";
import { Button } from "@/shared/components/ui/button";
import { Checkbox } from "@/shared/components/ui/checkbox";
import { ChoiceCard } from "@/shared/components/ui/choice-card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Textarea } from "@/shared/components/ui/textarea";
import {
  addDays,
  ENTRY_PACK_VALIDITY_MONTHS,
  type EntryPackSize,
  PASS_TIERS,
  type PassTierKey,
} from "../mock-passes";
import {
  ADMIN_TODAY,
  adminCustomerById,
  adminCustomers,
  formatPrototypeDate,
  formatShortDate,
  UNLIMITED_DAYS,
} from "./admin-pass-data";
import { useActionParam } from "./pass-presentation";

export const passDialogClassName =
  "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl";

const fieldLabel = "text-sm font-semibold text-navy-blue";

/** GUESS: validity starts on the grant date and ends the day before the same date N months later. */
const addMonthsMinusDay = (isoDate: string, months: number) => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return addDays(date.toISOString().slice(0, 10), -1);
};

export function GrantPassDialog({
  onOpenChange,
  open,
}: {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  const locale = useRouteLocale();
  const { searchParams } = useActionParam();
  const presetCustomer = adminCustomerById(searchParams.get("customer") ?? "");
  const [customerId, setCustomerId] = useState<string | null>(presetCustomer?.id ?? null);
  const [query, setQuery] = useState("");
  const [product, setProduct] = useState<"entry-pack" | "unlimited">(
    searchParams.get("product") === "unlimited" ? "unlimited" : "entry-pack"
  );
  const [tier, setTier] = useState<PassTierKey>(
    searchParams.get("product") === "unlimited" ? "reserved-desk" : "open-space"
  );
  const [size, setSize] = useState<EntryPackSize>(5);
  const [startDate, setStartDate] = useState("2026-11-23");
  const [coffee, setCoffee] = useState(false);
  const [reason, setReason] = useState(
    searchParams.get("product") === "unlimited"
      ? "Hosts the December community meetups"
      : "Apology for the 12 Nov heating outage"
  );

  const customer = customerId ? adminCustomerById(customerId) : undefined;
  const results = query.trim()
    ? adminCustomers.filter((candidate) =>
        `${candidate.name} ${candidate.email}`.toLowerCase().includes(query.trim().toLowerCase())
      )
    : [];
  const unlimitedEnd = addDays(startDate, UNLIMITED_DAYS - 1);
  const packEnd = addMonthsMinusDay(ADMIN_TODAY, ENTRY_PACK_VALIDITY_MONTHS[size]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className={passDialogClassName} locale={locale}>
        <DialogHeader>
          <DialogTitle>Grant a complimentary pass</DialogTitle>
          <DialogDescription>
            Creates a zero-total pass for the customer. It's recorded in the pass's audit trail with your
            reason.
          </DialogDescription>
        </DialogHeader>

        <form className="mt-4 grid gap-5" onSubmit={(event) => event.preventDefault()}>
          <fieldset className="grid gap-2">
            <legend className={`${fieldLabel} mb-2`}>Customer (holder)</legend>
            {customer ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-navy-blue/12 bg-navy-blue/[0.03] px-4 py-3">
                <div className="min-w-0">
                  <p className="font-semibold">{customer.name}</p>
                  <p className="break-all text-sm text-navy-blue/65">{customer.email}</p>
                </div>
                <Button
                  aria-label="Change customer"
                  onClick={() => setCustomerId(null)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden />
                </Button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search
                    aria-hidden
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-navy-blue/45"
                  />
                  <Input
                    aria-label="Find customer"
                    className="pl-9"
                    id="grant-customer-search"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Name or email"
                    type="search"
                    value={query}
                  />
                </div>
                {results.length > 0 && (
                  <ul className="overflow-hidden rounded-xl border border-navy-blue/12 bg-white">
                    {results.map((candidate) => (
                      <li className="border-b border-navy-blue/8 last:border-b-0" key={candidate.id}>
                        <button
                          className="block w-full px-4 py-2.5 text-left hover:bg-navy-blue/[0.04]"
                          onClick={() => setCustomerId(candidate.id)}
                          type="button"
                        >
                          <span className="block font-semibold">{candidate.name}</span>
                          <span className="block break-all text-sm text-navy-blue/65">{candidate.email}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-navy-blue/60">
                  Not a customer yet? Enter an email to create an unverified account and send a sign-in
                  invitation.
                </p>
              </>
            )}
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className={`${fieldLabel} mb-2`}>Product</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["entry-pack", "Entry pack", "5 or 10 entries"],
                  ["unlimited", "Unlimited", `${UNLIMITED_DAYS} consecutive days`],
                ] as const
              ).map(([value, label, hint]) => (
                <ChoiceCard align="center" key={value} tone="plain">
                  <input
                    checked={product === value}
                    className="size-4 accent-burned-orange"
                    name="grant-product"
                    onChange={() => setProduct(value)}
                    type="radio"
                    value={value}
                  />
                  <span>
                    <span className="block font-semibold">{label}</span>
                    <span className="block text-sm text-navy-blue/65">{hint}</span>
                  </span>
                </ChoiceCard>
              ))}
            </div>
          </fieldset>

          <label className="grid gap-2" htmlFor="grant-tier">
            <span className={fieldLabel}>Tier</span>
            <AdministrationFilterSelect
              className="h-12 rounded-[1.1rem] border-navy-blue/45 px-4 text-base"
              id="grant-tier"
              onChange={(event) => setTier(event.target.value as PassTierKey)}
              value={tier}
            >
              {PASS_TIERS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </AdministrationFilterSelect>
          </label>

          {product === "entry-pack" ? (
            <fieldset className="grid gap-2">
              <legend className={`${fieldLabel} mb-2`}>Size</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {([5, 10] as const).map((option) => (
                  <ChoiceCard align="center" key={option} tone="plain">
                    <input
                      checked={size === option}
                      className="size-4 accent-burned-orange"
                      name="grant-size"
                      onChange={() => setSize(option)}
                      type="radio"
                      value={option}
                    />
                    <span>
                      <span className="block font-semibold">{option} entries</span>
                      <span className="block text-sm text-navy-blue/65">
                        Valid {ENTRY_PACK_VALIDITY_MONTHS[option]} months
                      </span>
                    </span>
                  </ChoiceCard>
                ))}
              </div>
              <p className="text-sm text-navy-blue/65">
                Valid from today, {formatShortDate(ADMIN_TODAY)}, until{" "}
                <span className="font-semibold text-navy-blue">{formatPrototypeDate(packEnd)}</span>.
              </p>
            </fieldset>
          ) : (
            <div className="grid gap-3">
              <div className="grid gap-2">
                <span className={fieldLabel} id="grant-start-label">
                  Start date
                </span>
                <DateInput
                  aria-labelledby="grant-start-label"
                  displayValue={false}
                  id="grant-start"
                  label="Start date"
                  onChange={setStartDate}
                  value={startDate}
                />
              </div>
              <AdministrationAlert role="status" status="success">
                All {UNLIMITED_DAYS} dates have capacity, {formatShortDate(startDate)} –{" "}
                {formatPrototypeDate(unlimitedEnd)}.
                {tier !== "open-space" && " Desk 7 will be held for the whole period."}
              </AdministrationAlert>
              <ChoiceCard align="center" tone="plain">
                <Checkbox checked={coffee} onCheckedChange={(checked) => setCoffee(checked === true)} />
                <span>
                  <span className="block font-semibold">Include coffee</span>
                  <span className="block text-sm text-navy-blue/65">Complimentary too</span>
                </span>
              </ChoiceCard>
            </div>
          )}

          <label className="grid gap-2" htmlFor="grant-reason">
            <span className={fieldLabel}>Reason</span>
            <Textarea
              id="grant-reason"
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why this pass is granted, e.g. community event host"
              rows={2}
              value={reason}
            />
            <span className="text-xs font-normal text-navy-blue/60">
              Required. Saved in the audit trail; the customer doesn't see it.
            </span>
          </label>

          {customer && (
            <p className="flex items-start gap-2 text-sm text-navy-blue/70">
              <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-aquamarine-ink" />
              {customer.name.split(" ")[0]} gets an email that the pass is ready to use.
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button disabled={!(customer && reason.trim())} type="submit">
              Grant pass · CZK 0
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
