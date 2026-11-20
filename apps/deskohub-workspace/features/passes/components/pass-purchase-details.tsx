import { effectSchemaResolver } from "@deskohub/effect-schema-resolver";
import { Gift } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { type Locale, m } from "@/features/i18n";
import { ReservationBillingFields } from "@/features/reservation/components/reservation-billing-fields";
import { ReservationFormCard } from "@/features/reservation/components/reservation-form-card";
import { defaultReservationBillingSelection } from "@/features/reservation/reservation-billing";
import { Button } from "@/shared/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/shared/components/ui/form";
import { Input } from "@/shared/components/ui/input";
import {
  type PassPurchaseBuyer,
  passPurchaseDetailsSchema,
} from "../pass-purchase-details";
import { PassCheckoutContinue } from "./pass-checkout-continue";

export type PassPurchaseDetailsProps = {
  readonly buyer: PassPurchaseBuyer;
  readonly locale: Locale;
  readonly initialValues?: ReturnType<
    typeof passPurchaseDetailsSchema
  >["Encoded"];
  readonly error?: string;
  readonly onChangeSelection: () => void;
  readonly onSubmit: (
    values: ReturnType<typeof passPurchaseDetailsSchema>["Type"]
  ) => Promise<void>;
};

export function PassPurchaseDetails({
  buyer,
  locale,
  initialValues,
  error,
  signInPath,
  signInNote,
  buyerNote,
  holderLabel,
  summaryTitle,
  summary,
  onChangeSelection,
  onSubmit,
}: PassPurchaseDetailsProps & {
  readonly signInPath: string;
  readonly signInNote: string;
  readonly buyerNote: string;
  readonly holderLabel: string;
  readonly summaryTitle: string;
  readonly summary: ReactNode;
}) {
  const schema = passPurchaseDetailsSchema(locale);
  const form = useForm<typeof schema.Encoded, unknown, typeof schema.Type>({
    resolver: effectSchemaResolver(schema),
    defaultValues: initialValues ?? {
      billing: defaultReservationBillingSelection,
      ...(buyer.kind === "profile-required" && {
        buyerProfile: { firstName: "", lastName: "" },
      }),
    },
  });
  const [gift, setGift] = useState(initialValues?.holderEmail !== undefined);
  const pending = form.formState.isSubmitting;
  return (
    <ReservationFormCard>
      <div className="space-y-7">
        <section className="rounded-3xl border border-navy-blue/10 bg-white p-4">
          <div className="flex items-start justify-between gap-4">
            <h2 className="font-semibold text-lg">{summaryTitle}</h2>
            <button
              className="cursor-pointer font-semibold text-burned-orange underline underline-offset-4"
              disabled={pending}
              onClick={onChangeSelection}
              type="button"
            >
              {m.reservationSelectionChange({}, { locale })}
            </button>
          </div>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">{summary}</dl>
        </section>
        {buyer.kind === "signed-out" && (
          <div className="space-y-3">
            <p className="text-sm text-navy-blue/75">{signInNote}</p>
            <Button asChild>
              <Link href={signInPath}>
                {m.accountSignInTitle({}, { locale })}
              </Link>
            </Button>
          </div>
        )}
        {buyer.kind === "unavailable" && (
          <p role="alert">{m.actionFailedUnexpectedly({}, { locale })}</p>
        )}
        {(buyer.kind === "linked" || buyer.kind === "profile-required") && (
          <Form {...form}>
            <form className="space-y-7" onSubmit={form.handleSubmit(onSubmit)}>
              <fieldset disabled={pending} className="space-y-3">
                <legend className="font-semibold text-sm uppercase tracking-widest text-navy-blue/75">
                  {m.entryPackCheckoutBuyer({}, { locale })}
                </legend>
                <div className="rounded-3xl border border-navy-blue/10 bg-navy-blue/3 p-4">
                  {buyer.kind === "linked" && (
                    <p className="font-semibold">{buyer.name}</p>
                  )}
                  <p className="break-all text-sm text-navy-blue/75">
                    {buyer.email}
                  </p>
                </div>
                {buyer.kind === "profile-required" && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="buyerProfile.firstName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            {m.accountProfileFirstNameLabel({}, { locale })}
                          </FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              autoComplete="given-name"
                              required
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="buyerProfile.lastName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            {m.accountProfileLastNameLabel({}, { locale })}
                          </FormLabel>
                          <FormControl>
                            <Input {...field} autoComplete="family-name" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}
                <p className="text-sm leading-6 text-navy-blue/75">
                  {buyerNote}
                </p>
              </fieldset>
              <fieldset disabled={pending} className="space-y-3">
                <legend className="sr-only">{holderLabel}</legend>
                <label className="flex cursor-pointer items-center gap-2 font-semibold text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-burned-orange"
                    checked={gift}
                    onChange={(event) => {
                      setGift(event.currentTarget.checked);
                      if (!event.currentTarget.checked)
                        form.unregister("holderEmail");
                    }}
                  />
                  {m.entryPackCheckoutGift({}, { locale })}
                </label>
                {gift && (
                  <div className="space-y-3 rounded-3xl border border-aquamarine-green/40 bg-aquamarine-green/10 p-4">
                    <FormField
                      control={form.control}
                      name="holderEmail"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            {m.entryPackCheckoutHolderEmail({}, { locale })}
                          </FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              value={field.value ?? ""}
                              autoComplete="section-holder email"
                              type="email"
                              required
                              maxLength={254}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <p className="flex items-start gap-2 text-sm leading-6 text-navy-blue/75">
                      <Gift
                        aria-hidden="true"
                        size={16}
                        className="mt-1 shrink-0 text-burned-orange"
                      />
                      {m.entryPackCheckoutGiftNote({}, { locale })}
                    </p>
                  </div>
                )}
              </fieldset>
              <fieldset disabled={pending}>
                <legend className="sr-only">
                  {m.entryPackCheckoutBilling({}, { locale })}
                </legend>
                <ReservationBillingFields locale={locale} />
              </fieldset>
              <p
                role="alert"
                className="empty:sr-only text-sm font-semibold text-burned-orange"
              >
                {error}
              </p>
              <PassCheckoutContinue locale={locale} pending={pending} />
            </form>
          </Form>
        )}
      </div>
    </ReservationFormCard>
  );
}

export function PassPurchaseSummaryItem({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt className="font-semibold text-xs uppercase tracking-widest text-navy-blue/65">
        {label}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}
