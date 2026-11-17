"use client";

// PROTOTYPE ONLY: cancel, reassign and extend dialogs for one pass (#1362).
// Each opens from ?action=cancel|reassign|extend on the pass detail route.
// Extend Unlimited takes ?days=<n> (default 5).

import { Minus, Plus } from "lucide-react";
import { useState } from "react";
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
  type EntryPackPass,
  type PrototypePass,
  type UnlimitedPass,
} from "../mock-passes";
import {
  firstUseDate,
  formatCzk,
  formatPrototypeDate,
  formatShortDate,
  formatWeekdayDate,
  isComplimentary,
  refundQuote,
  unlimitedExtensionCheck,
} from "./admin-pass-data";
import { passDialogClassName } from "./grant-pass-dialog";

type DialogProps = {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly pass: PrototypePass;
};

const fieldLabel = "text-sm font-semibold text-navy-blue";

function SummaryRows({
  rows,
}: {
  readonly rows: readonly { label: string; value: React.ReactNode; strong?: boolean }[];
}) {
  return (
    <dl className="overflow-hidden rounded-xl border border-navy-blue/10">
      {rows.map((row) => (
        <div
          className={
            row.strong
              ? "flex items-baseline justify-between gap-4 bg-navy-blue/[0.04] px-4 py-3"
              : "flex flex-col gap-0.5 border-b border-navy-blue/8 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
          }
          key={row.label}
        >
          <dt className={row.strong ? "font-semibold" : "shrink-0 text-sm text-navy-blue/70"}>{row.label}</dt>
          <dd className={row.strong ? "text-lg font-semibold" : "min-w-0 text-sm font-semibold sm:text-right"}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function CancelPassDialog({ onOpenChange, open, pass }: DialogProps) {
  const locale = useRouteLocale();
  const quote = refundQuote(pass);
  const [notify, setNotify] = useState(true);
  const complimentary = isComplimentary(pass);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className={passDialogClassName} locale={locale}>
        <DialogHeader>
          <DialogTitle>Cancel this pass?</DialogTitle>
          <DialogDescription>
            {pass.product === "entry-pack"
              ? "No more entries can be booked. Booked future dates are cancelled and their entries refunded."
              : "Future daily reservations are cancelled and released."}
            {quote.todayStaysValid && " Today's access code stays valid until it ends."}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 grid gap-4">
          {complimentary ? (
            <SummaryRows rows={[{ label: "Refund", value: "None, complimentary pass", strong: true }]} />
          ) : (
            <SummaryRows
              rows={[
                { label: "Paid", value: formatCzk(quote.paid) },
                { label: "Basis", value: quote.basis },
                { label: "Calculation", value: `${quote.formula}, rounded down` },
                { label: "Refund", value: formatCzk(quote.refund), strong: true },
              ]}
            />
          )}

          {quote.releasedDates.length > 0 && (
            <div className="text-sm">
              <p className="font-semibold">
                {pass.product === "entry-pack" ? "Booked dates to cancel" : "Reservations to release"}
              </p>
              <p className="mt-1 text-navy-blue/70">
                {pass.product === "entry-pack"
                  ? quote.releasedDates.map(formatWeekdayDate).join(", ")
                  : `${quote.releasedDates.length} dates, ${formatShortDate(quote.releasedDates[0] as string)} – ${formatPrototypeDate(quote.releasedDates.at(-1) as string)}${(pass as UnlimitedPass).deskLabel ? ` · ${(pass as UnlimitedPass).deskLabel} freed` : ""}`}
              </p>
            </div>
          )}

          {!complimentary && (
            <AdministrationAlert status="warning">
              <strong className="font-semibold">The refund isn't sent automatically.</strong> Cancelling marks{" "}
              {formatCzk(quote.refund)} as a refund to process. Send it in the Nexi back office for order
              NX-{pass.id.slice(5)}-01, then confirm it on this pass.
            </AdministrationAlert>
          )}

          <label className="grid gap-2" htmlFor="cancel-reason">
            <span className={fieldLabel}>Reason</span>
            <Textarea
              defaultValue={pass.product === "entry-pack" ? "Customer moved abroad" : "Withdrawal request by email"}
              id="cancel-reason"
              rows={2}
            />
          </label>

          <ChoiceCard tone="plain">
            <Checkbox checked={notify} onCheckedChange={(checked) => setNotify(checked === true)} />
            <span className="leading-6 text-navy-blue/70">
              Email the cancellation to {pass.holder.name}
              {pass.buyer && pass.buyer.id !== pass.holder.id && ` and ${pass.buyer.name}`}
            </span>
          </ChoiceCard>
        </div>

        <DialogFooter className="mt-2">
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Keep pass
            </Button>
          </DialogClose>
          <Button tone="burned-orange-ink" type="button">
            {complimentary ? "Cancel pass" : `Cancel and mark ${formatCzk(quote.refund)} refund`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReassignHolderDialog({ onOpenChange, open, pass }: DialogProps) {
  const locale = useRouteLocale();
  const usedOn = firstUseDate(pass);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className={passDialogClassName} locale={locale}>
        <DialogHeader>
          <DialogTitle>Reassign holder</DialogTitle>
          <DialogDescription>
            Moves the pass to another person. Allowed only before the pass is first used.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 grid gap-4">
          <SummaryRows
            rows={[
              {
                label: "Current holder",
                value: (
                  <span className="block min-w-0 break-words">
                    {pass.holder.name}
                    <span className="block text-xs font-normal text-navy-blue/60">{pass.holder.email}</span>
                  </span>
                ),
              },
              ...(pass.buyer ? [{ label: "Bought by", value: pass.buyer.name }] : []),
            ]}
          />

          {usedOn ? (
            <AdministrationAlert role="alert" status="error">
              <strong className="font-semibold">This pass can't be reassigned.</strong>{" "}
              {pass.product === "entry-pack"
                ? `${pass.holder.name} first booked an entry for ${formatPrototypeDate(usedOn)}.`
                : `It started on ${formatPrototypeDate(usedOn)}.`}{" "}
              To move the remaining value, cancel the pass with a refund and grant a new one.
            </AdministrationAlert>
          ) : (
            <>
              <label className="grid gap-2" htmlFor="reassign-email">
                <span className={fieldLabel}>New holder's email</span>
                <Input defaultValue="tomas.novak@example.com" id="reassign-email" type="email" />
                <span className="text-xs font-normal leading-5 text-navy-blue/60">
                  An existing account is matched by email. Otherwise an unverified account is created. The new
                  holder gets an invitation and must verify before booking.
                </span>
              </label>
              <label className="grid gap-2" htmlFor="reassign-reason">
                <span className={fieldLabel}>Reason</span>
                <Textarea defaultValue="Buyer asked to give the pass to a colleague" id="reassign-reason" rows={2} />
              </label>
              <p className="text-sm text-navy-blue/70">
                {pass.holder.name} loses access. Their pending invitation link stops working.
              </p>
            </>
          )}
        </div>

        <DialogFooter className="mt-2">
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              {usedOn ? "Close" : "Cancel"}
            </Button>
          </DialogClose>
          {!usedOn && <Button type="button">Reassign and send invitation</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ExtendPassDialog({
  days,
  onOpenChange,
  open,
  pass,
}: DialogProps & { readonly days: number }) {
  const locale = useRouteLocale();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className={passDialogClassName} locale={locale}>
        <DialogHeader>
          <DialogTitle>Extend validity</DialogTitle>
          <DialogDescription>
            {pass.product === "entry-pack"
              ? "Moves the expiry date later. The number of entries stays the same."
              : "Adds days after the current end date and reserves them for the holder."}
          </DialogDescription>
        </DialogHeader>
        {pass.product === "entry-pack" ? (
          <ExtendEntryPack pass={pass} />
        ) : (
          <ExtendUnlimited initialDays={days} pass={pass} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ExtendEntryPack({ pass }: { readonly pass: EntryPackPass }) {
  const [expiry, setExpiry] = useState(addDays(pass.validUntil, 30));
  return (
    <>
      <div className="mt-4 grid gap-4">
        <SummaryRows
          rows={[
            { label: "Current expiry", value: formatPrototypeDate(pass.validUntil) },
            {
              label: "Entries left",
              value: `${pass.size - pass.entriesUsed - pass.entriesBooked} of ${pass.size}`,
            },
          ]}
        />
        <div className="grid gap-2">
          <span className={fieldLabel} id="extend-expiry-label">
            New expiry date
          </span>
          <DateInput
            aria-labelledby="extend-expiry-label"
            displayValue={false}
            id="extend-expiry"
            label="New expiry date"
            onChange={setExpiry}
            value={expiry}
          />
          <span className="text-xs text-navy-blue/60">Must be after {formatPrototypeDate(pass.validUntil)}.</span>
        </div>
        <label className="grid gap-2" htmlFor="extend-reason">
          <span className={fieldLabel}>Reason</span>
          <Textarea defaultValue="Holder was ill for three weeks" id="extend-reason" rows={2} />
        </label>
      </div>
      <DialogFooter className="mt-2">
        <DialogClose asChild>
          <Button type="button" variant="secondary">
            Cancel
          </Button>
        </DialogClose>
        <Button type="button">Extend to {formatPrototypeDate(expiry)}</Button>
      </DialogFooter>
    </>
  );
}

function ExtendUnlimited({
  initialDays,
  pass,
}: {
  readonly initialDays: number;
  readonly pass: UnlimitedPass;
}) {
  const [days, setDays] = useState(initialDays);
  const check = unlimitedExtensionCheck(pass, days);
  const blocked = check.blocking.length > 0;
  const resource = pass.deskLabel ?? "Open Space";
  return (
    <>
      <div className="mt-4 grid gap-4">
        <SummaryRows
          rows={[
            { label: "Current end", value: formatPrototypeDate(pass.endDate) },
            { label: "Seat", value: pass.deskLabel ? `${pass.deskLabel} (same desk required)` : "Open Space" },
          ]}
        />
        <div className="grid gap-2">
          <label className={fieldLabel} htmlFor="extend-days">
            Days to add
          </label>
          <div className="flex items-center gap-2">
            <Button
              aria-label="One day fewer"
              disabled={days <= 1}
              onClick={() => setDays(days - 1)}
              size="icon"
              type="button"
              variant="secondary"
            >
              <Minus aria-hidden />
            </Button>
            <Input
              className="w-20 text-center"
              id="extend-days"
              inputMode="numeric"
              onChange={(event) => setDays(Math.max(1, Number(event.target.value) || 1))}
              value={days}
            />
            <Button
              aria-label="One more day"
              onClick={() => setDays(days + 1)}
              size="icon"
              type="button"
              variant="secondary"
            >
              <Plus aria-hidden />
            </Button>
          </div>
          <span className="text-sm text-navy-blue/70">
            Adds {formatShortDate(check.addedDates[0] as string)} – {formatPrototypeDate(check.newEnd)}. <span className="whitespace-nowrap">
              New end: <span className="font-semibold text-navy-blue">{formatPrototypeDate(check.newEnd)}</span>
            </span>
          </span>
        </div>

        {blocked ? (
          <AdministrationAlert role="alert" status="error">
            <p>
              <strong className="font-semibold">Can't extend by {days} days.</strong> Every added date needs{" "}
              {pass.deskLabel ? `${resource} free` : "Open Space capacity"}; these aren't:
            </p>
            <ul className="mt-2 list-disc space-y-0.5 pl-5">
              {check.blocking.map((entry) => (
                <li key={entry.date}>
                  <span className="font-semibold">{formatWeekdayDate(entry.date)}</span>: {entry.reason}
                </li>
              ))}
            </ul>
            <p className="mt-2">
              Choose fewer days
              {check.blocking[0] &&
                ` (up to ${check.addedDates.indexOf(check.blocking[0].date)} would fit)`}
              , or cancel the pass and refund instead.
            </p>
          </AdministrationAlert>
        ) : (
          <AdministrationAlert role="status" status="success">
            All {days} added dates are available. {pass.deskLabel ? `${resource} stays reserved.` : ""}
          </AdministrationAlert>
        )}

        <label className="grid gap-2" htmlFor="extend-reason">
          <span className={fieldLabel}>Reason</span>
          <Textarea defaultValue="Compensation for the 12 Nov heating outage" id="extend-reason" rows={2} />
        </label>
      </div>
      <DialogFooter className="mt-2">
        <DialogClose asChild>
          <Button type="button" variant="secondary">
            Cancel
          </Button>
        </DialogClose>
        <Button disabled={blocked} type="button">
          Reserve {days} more days
        </Button>
      </DialogFooter>
    </>
  );
}
