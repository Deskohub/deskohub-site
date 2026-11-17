"use client";

// PROTOTYPE ONLY: mock-prop lookalikes of the reservation checkout pieces,
// shared by the Entry pack and Unlimited purchase prototypes (#1360). Built
// from the same primitives and classes as the real flow; nothing here talks
// to a backend.

import {
  Check,
  Clock3,
  Coffee,
  Info,
  KeyRound,
  type LucideIcon,
  Mail,
  Monitor,
  Users,
  Wifi,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useId } from "react";
import {
  getWorkspaceProductMessage,
  workspaceProductMonitorDescriptionMessages,
  workspaceProductTierCardMessages,
} from "@/features/checkout/product-catalog.i18n";
import openSpaceArtwork from "@/features/cowork/assets/open-space.png";
import reservedDeskArtwork from "@/features/cowork/assets/reserved-desk.png";
import reservedDeskWorkstationArtwork from "@/features/cowork/assets/reserved-desk-workstation.png";
import type { Locale } from "@/features/i18n";
import {
  ReservationTypeInput,
  ReservationTypeOption,
} from "@/features/reservation/components/reservation-type-input";
import { Button } from "@/shared/components/ui/button";
import { Checkbox } from "@/shared/components/ui/checkbox";
import { ChoiceCard } from "@/shared/components/ui/choice-card";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { NavItem } from "@/shared/components/ui/nav-item";
import { Switch } from "@/shared/components/ui/switch";
import { cn } from "@/shared/utils";
import {
  formatCzk,
  MONITOR_OPTIONS,
  PASS_TIERS,
  type PassTierKey,
} from "../mock-passes";
import { PROTOTYPE_BUYER } from "./purchase-mock";

// ---------------------------------------------------------------------------
// URL-backed prototype state

export function usePrototypeParams() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const hrefWith = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) params.delete(key);
      else params.set(key, value);
    }
    return `${pathname}?${params.toString()}`;
  };

  return {
    get: (key: string, fallback: string) => searchParams.get(key) ?? fallback,
    has: (key: string) => searchParams.has(key),
    hrefWith,
    /** Changes a selection in place. */
    set: (patch: Record<string, string | undefined>) =>
      router.replace(hrefWith(patch), { scroll: false }),
    /** Moves to another step. */
    go: (patch: Record<string, string | undefined>) =>
      router.push(hrefWith(patch)),
  };
}

// ---------------------------------------------------------------------------
// Steps (CheckoutSteps lookalike with pass step labels)

export type PassStep = { readonly key: string; readonly label: string };

export function PassCheckoutSteps({
  activeKey,
  hrefFor,
  steps,
}: {
  readonly activeKey: string;
  readonly hrefFor: (key: string) => string;
  readonly steps: readonly PassStep[];
}) {
  const activeIndex = steps.findIndex((step) => step.key === activeKey);

  return (
    <ol className="grid gap-2 sm:grid-cols-3" aria-label="Purchase steps">
      {steps.map((step, index) => {
        const isCurrent = index === activeIndex;
        const isCompleted = index < activeIndex;
        const content = (
          <>
            <span
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                isCompleted && "bg-aquamarine-green text-aquamarine-ink",
                isCurrent && "bg-burned-orange text-white",
                !isCompleted &&
                  !isCurrent &&
                  "border border-white/18 text-white/64"
              )}
            >
              {isCompleted ? (
                <Check aria-hidden="true" className="size-4" />
              ) : (
                index + 1
              )}
            </span>
            <span className={cn("min-w-0", isCurrent && "text-white")}>
              {step.label}
            </span>
          </>
        );

        return (
          <li
            key={step.key}
            className="min-w-0"
            aria-current={isCurrent ? "step" : undefined}
          >
            {isCompleted ? (
              <NavItem asChild layout="step" tone="translucent">
                <Link href={hrefFor(step.key)}>{content}</Link>
              </NavItem>
            ) : (
              <div className="flex h-full min-w-0 items-center gap-3 rounded-2xl border border-white/12 bg-white/7 px-4 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-white/68 lg:gap-2 lg:px-3 lg:text-xs lg:tracking-[0.08em]">
                {content}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Labels and notes

export function FieldLabel({
  children,
  htmlFor,
  id,
  required,
}: {
  readonly children: ReactNode;
  readonly htmlFor?: string;
  readonly id?: string;
  readonly required?: boolean;
}) {
  return (
    <Label
      className={cn(
        "text-sm font-semibold uppercase tracking-[0.14em] text-navy-blue/72",
        required && "after:content-['_*']"
      )}
      htmlFor={htmlFor}
      id={id}
    >
      {children}
    </Label>
  );
}

export function FlowNote({
  children,
  icon: Icon = Info,
}: {
  readonly children: ReactNode;
  readonly icon?: LucideIcon;
}) {
  return (
    <p className="flex items-start gap-2 text-sm leading-6 text-navy-blue/66">
      <Icon
        aria-hidden="true"
        className="mt-1 h-4 w-4 shrink-0 text-burned-orange"
      />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export function PriceSuffix({ children }: { readonly children: ReactNode }) {
  return (
    <span className="ml-1 text-sm font-normal normal-case tracking-normal text-navy-blue/60">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tier cards (the reservation flow's illustrated ReservationTypeInput)

const tierArtwork = {
  "open-space": openSpaceArtwork,
  "reserved-desk": reservedDeskArtwork,
  workstation: reservedDeskWorkstationArtwork,
} as const;

/** Workstation copy is new; the other two tiers reuse the real card copy. */
const workstationCard = {
  description: "A Reserved Desk with two monitors set up for you.",
};

/**
 * Pass cards list only what the tier itself gives. The real Reserved Desk
 * card also names day add-ons (coffee, optional workstation), which the
 * pass tiers settle differently.
 */
const passPerks: Record<PassTierKey, readonly string[]> = {
  "open-space": ["High-speed Wi-Fi", "Any free desk, until 17:00"],
  "reserved-desk": ["24/7 code access", "Your own desk all day"],
  workstation: ["24/7 code access", "Your own desk all day", "Two monitors ready"],
};

export function TierArtwork({
  className,
  tier,
}: {
  readonly className?: string;
  readonly tier: PassTierKey;
}) {
  return (
    <Image
      aria-hidden="true"
      alt=""
      className={className}
      height={941}
      sizes="340px"
      src={tierArtwork[tier]}
      width={1672}
    />
  );
}

export function PassTierOptions({
  locale,
  onChange,
  price,
  value,
}: {
  readonly locale: Locale;
  readonly onChange: (tier: PassTierKey) => void;
  readonly price: (tier: PassTierKey) => ReactNode;
  readonly value: PassTierKey;
}) {
  return (
    <div className="space-y-2" data-shot-part="tiers">
      <FieldLabel required>Workspace</FieldLabel>
      <ReservationTypeInput
        aria-required="true"
        className="lg:grid-cols-3"
        idPrefix="pass-tier"
        onChange={onChange}
        presentation="illustrated"
        value={value}
      >
        {PASS_TIERS.map((tier) => (
          <ReservationTypeOption
            key={tier.key}
            illustration={
              <TierArtwork
                className={cn(
                  "absolute top-0 right-0 h-auto w-[280%] max-w-[440px] -translate-y-[25%] object-contain object-right-top @min-[400px]/card:translate-x-0",
                  {
                    "open-space": "translate-x-[10%]",
                    "reserved-desk": "translate-x-[20%]",
                    workstation: "translate-x-[20%]",
                  }[tier.key]
                )}
                tier={tier.key}
              />
            }
            price={price(tier.key)}
            title={tier.label}
            value={tier.key}
          >
            <TierDescription locale={locale} tier={tier.key} />
            <TierPerks locale={locale} tier={tier.key} />
          </ReservationTypeOption>
        ))}
      </ReservationTypeInput>
    </div>
  );
}

export function TierDescription({
  locale,
  tier,
}: {
  readonly locale: Locale;
  readonly tier: PassTierKey;
}) {
  const text =
    tier === "workstation"
      ? workstationCard.description
      : getWorkspaceProductMessage(
          workspaceProductTierCardMessages[tier].description,
          locale
        );

  return (
    <div className="relative z-10 col-start-1 row-start-3 mb-3 min-h-[5.625rem] max-w-full break-words pt-1 text-sm leading-5 text-navy-blue/70">
      <span className="box-decoration-clone rounded-sm bg-white/85 px-1 py-0.5 group-has-[input:checked]:bg-[color:color-mix(in_srgb,var(--color-burned-orange)_8%,white)]/85">
        {text}
      </span>
    </div>
  );
}

export function TierPerks({
  context = "pass",
  locale,
  tier,
}: {
  /** `day` shows the real single-day card perks. */
  readonly context?: "day" | "pass";
  readonly locale: Locale;
  readonly tier: PassTierKey;
}) {
  const perks =
    context === "pass" || tier === "workstation"
      ? passPerks[tier].map((text) => ({ text, highlighted: false }))
      : workspaceProductTierCardMessages[tier].perks.map((perk) => ({
          text: getWorkspaceProductMessage(perk.message, locale),
          highlighted: Boolean(perk.highlighted),
        }));
  const icons = {
    "open-space": context === "pass" ? [Wifi, Clock3] : [Wifi],
    "reserved-desk":
      context === "pass" ? [KeyRound, Clock3] : [Clock3, Coffee, Monitor],
    workstation: [KeyRound, Clock3, Monitor],
  }[tier];

  return (
    <div className="relative z-10 col-start-1 col-end-3 row-start-4 pb-1 text-sm leading-5 text-navy-blue/70">
      <ul className="space-y-2">
        {perks.map((perk, index) => {
          const PerkIcon = icons[index];
          return (
            <li
              key={perk.text}
              className={cn(
                "flex items-center gap-2 leading-6",
                perk.highlighted && "text-burned-orange"
              )}
            >
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-blue/7 text-navy-blue"
              >
                {PerkIcon && <PerkIcon className="h-4 w-4" />}
              </span>
              <span className="min-w-0 break-words">{perk.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-on toggle (CoworkOptionalAddonToggle lookalike without RHF)

export function AddonToggle({
  checked,
  children,
  icon: Icon,
  label,
  onCheckedChange,
  priceLabel,
}: {
  readonly checked: boolean;
  readonly children?: ReactNode;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly priceLabel: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-y-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <ChoiceCard align="center" htmlFor={id}>
        <span className="flex items-center gap-3">
          <Icon className="h-5 w-5 shrink-0 text-burned-orange" />
          <Switch
            checked={checked}
            id={id}
            onCheckedChange={(next) => onCheckedChange(Boolean(next))}
          />
        </span>
        <span className="ml-auto text-sm font-semibold text-navy-blue before:content-['+']">
          {priceLabel}
        </span>
      </ChoiceCard>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monitor setup (the workstation field's radio cards)

export function MonitorSetupOptions({
  locale,
  onChange,
  unavailable,
  unavailableReason,
  value,
}: {
  readonly locale: Locale;
  readonly onChange: (value: string) => void;
  readonly unavailable?: string;
  readonly unavailableReason?: string;
  readonly value: string;
}) {
  const labelId = useId();
  return (
    <div className="rounded-3xl border border-aquamarine-green/25 bg-aquamarine-green/8 p-4">
      <Label
        id={labelId}
        className="block pt-1 pb-3 text-sm text-navy-blue/60"
      >
        Monitor setup, the same on all 30 days
      </Label>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        {MONITOR_OPTIONS.map((option) => {
          const isSelected = value === option.key;
          const isDisabled = option.key === unavailable;
          return (
            <label
              key={option.key}
              className={cn(
                "cursor-pointer rounded-[1.1rem] border p-3 transition hover:-translate-y-0.5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-navy-blue",
                isDisabled &&
                  "cursor-not-allowed opacity-45 hover:translate-y-0",
                isSelected
                  ? "border-aquamarine-green bg-white ring-4 ring-aquamarine-green/15"
                  : "border-navy-blue/10 bg-white/75 hover:border-aquamarine-green/55"
              )}
            >
              <input
                type="radio"
                className="sr-only"
                checked={isSelected}
                disabled={isDisabled}
                name="monitor-setup"
                onChange={() => onChange(option.key)}
                value={option.key}
              />
              <span className="block font-semibold text-navy-blue">
                {option.label}
              </span>
              <span className="mt-1 block text-sm leading-5 text-navy-blue/60">
                {isDisabled
                  ? unavailableReason
                  : getWorkspaceProductMessage(
                      workspaceProductMonitorDescriptionMessages[
                        `2x${option.key}` as keyof typeof workspaceProductMonitorDescriptionMessages
                      ],
                      locale
                    )}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selection summary (ReservationSelectionSummary lookalike)

export function PassSelectionSummary({
  changeHref,
  rows,
  title,
}: {
  readonly changeHref: string;
  readonly rows: ReadonlyArray<{ readonly label: string; readonly value: ReactNode }>;
  readonly title: string;
}) {
  return (
    <section className="space-y-4 rounded-[1.4rem] border border-navy-blue/10 bg-white p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-navy-blue/72">
            Your pass
          </h3>
          <p className="text-lg font-semibold text-navy-blue">{title}</p>
        </div>
        <Button asChild className="shrink-0" variant="link">
          <Link href={changeHref}>Change</Link>
        </Button>
      </div>
      <dl className="grid gap-4 text-navy-blue sm:grid-cols-2 md:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-navy-blue/55">
              {row.label}
            </dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Buyer and holder

export function SignedInBuyer() {
  const initials = PROTOTYPE_BUYER.name
    .split(" ")
    .map((part) => part[0])
    .join("");
  return (
    <div className="space-y-2">
      <FieldLabel>Buyer</FieldLabel>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[1.4rem] border border-navy-blue/10 bg-navy-blue/2.5 p-4">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-navy-blue text-sm font-semibold text-white"
        >
          {initials}
        </span>
        <span className="min-w-0">
          <span className="block font-semibold text-navy-blue">
            {PROTOTYPE_BUYER.name}
          </span>
          <span className="block break-words text-sm text-navy-blue/60">
            {PROTOTYPE_BUYER.email}
          </span>
        </span>
        <span className="ml-13 shrink-0 rounded-full bg-aquamarine-green/15 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.12em] text-aquamarine-ink sm:ml-auto">
          Signed in
        </span>
      </div>
      <p className="text-sm leading-6 text-navy-blue/60">
        You pay for the pass, and your account discounts apply to it.
      </p>
    </div>
  );
}

export function PassHolderField({
  email,
  holder,
  onEmailChange,
  onHolderChange,
}: {
  readonly email: string;
  readonly holder: "me" | "other";
  readonly onEmailChange: (email: string) => void;
  readonly onHolderChange: (holder: "me" | "other") => void;
}) {
  const emailId = useId();
  const options = [
    {
      key: "me",
      icon: Check,
      title: "Me",
      detail: "The pass goes to your account.",
    },
    {
      key: "other",
      icon: Users,
      title: "Someone else",
      detail: "A colleague, friend or employee uses it.",
    },
  ] as const;

  return (
    <div className="space-y-3">
      <FieldLabel required>Who will use the pass?</FieldLabel>
      <div role="radiogroup" className="grid gap-3 sm:grid-cols-2">
        {options.map((option) => (
          <ChoiceCard key={option.key} tone="plain">
            <input
              checked={holder === option.key}
              className="mt-1 size-4 shrink-0"
              name="pass-holder"
              onChange={() => onHolderChange(option.key)}
              type="radio"
              value={option.key}
            />
            <span className="min-w-0">
              <span className="block font-semibold">{option.title}</span>
              <span className="block text-sm leading-6 text-navy-blue/60">
                {option.detail}
              </span>
            </span>
          </ChoiceCard>
        ))}
      </div>
      {holder === "other" && (
        <div className="space-y-3 rounded-3xl border border-aquamarine-green/25 bg-aquamarine-green/8 p-4">
          <div className="flex flex-col gap-y-2">
            <FieldLabel htmlFor={emailId} required>
              Holder's email
            </FieldLabel>
            <Input
              autoComplete="off"
              className="h-12 rounded-full bg-white px-5"
              id={emailId}
              onChange={(event) => onEmailChange(event.target.value)}
              placeholder="name@example.com"
              type="email"
              value={email}
            />
          </div>
          <FlowNote icon={Mail}>
            We email them an invitation once you've paid. They sign in with
            this email (we create an account if they don't have one) and
            confirm it before booking. Only they can use the pass.
          </FlowNote>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payment pieces (pay page lookalikes)

export function SummarySection({
  children,
  title,
}: {
  readonly children: ReactNode;
  readonly title: string;
}) {
  return (
    <div className="rounded-2xl border border-navy-blue/10 bg-white p-4">
      <div className="mb-3 text-sm font-semibold uppercase tracking-[0.12em] text-navy-blue/58">
        {title}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

export function SummaryLine({
  amount,
  detail,
  discount,
  label,
  originalAmount,
  strong,
}: {
  readonly amount: number;
  readonly detail?: ReactNode;
  readonly discount?: ReactNode;
  readonly label: ReactNode;
  readonly originalAmount?: number;
  readonly strong?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div
        className={cn(
          "flex flex-wrap items-start justify-between gap-x-4 gap-y-1 text-sm leading-6",
          strong && "text-base font-semibold"
        )}
      >
        <span className="min-w-0">{label}</span>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {originalAmount !== undefined && (
            <del className="text-navy-blue/45 decoration-navy-blue/40">
              {formatCzk(originalAmount)}
            </del>
          )}
          <span className="shrink-0 font-semibold tabular-nums">
            {formatCzk(amount)}
          </span>
        </span>
      </div>
      {discount && (
        <p className="text-sm leading-6 font-semibold text-aquamarine-ink">
          {discount}
        </p>
      )}
      {detail && (
        <p className="text-sm leading-6 text-navy-blue/60">{detail}</p>
      )}
    </div>
  );
}

export function DiscountCodeField({
  appliedCode,
  appliedLabel,
  draft,
  onApply,
  onDraftChange,
  onRemove,
}: {
  readonly appliedCode?: string;
  readonly appliedLabel?: string;
  readonly draft: string;
  readonly onApply: () => void;
  readonly onDraftChange: (value: string) => void;
  readonly onRemove: () => void;
}) {
  const inputId = useId();
  if (appliedCode) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border border-aquamarine-green/40 bg-aquamarine-green/12 px-4 py-3 text-sm font-semibold text-aquamarine-ink ring-1 ring-aquamarine-green/10">
        <output>{appliedLabel}</output>
        <Button onClick={onRemove} size="sm" type="button" variant="link">
          Remove
        </Button>
      </div>
    );
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onApply();
      }}
    >
      <Label htmlFor={inputId}>Discount, voucher, or referral code</Label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          autoCapitalize="characters"
          autoComplete="off"
          className="h-12 rounded-full px-5 uppercase"
          id={inputId}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Enter code"
          spellCheck={false}
          value={draft}
        />
        <Button caps size="lg" type="submit">
          Apply
        </Button>
      </div>
    </form>
  );
}

/**
 * The express early-start request with the pro-rated refund acknowledgement.
 * Owner rule (#1354): unticked by default, required for both products.
 */
export function EarlyStartConsent({
  checked,
  children,
  example,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly children: ReactNode;
  readonly example: ReactNode;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <ChoiceCard htmlFor={id} tone="warning">
      <Checkbox
        checked={checked}
        className="mt-1"
        id={id}
        onCheckedChange={(next) => onCheckedChange(Boolean(next))}
      />
      <span className="min-w-0 space-y-2">
        <span className="block text-navy-blue/80">{children}</span>
        <span className="block text-navy-blue/60">{example}</span>
      </span>
    </ChoiceCard>
  );
}
