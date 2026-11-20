import { CalendarPlus, Gift, Ticket } from "lucide-react";
import { Suspense, use } from "react";
import type {
  AccountBoughtEntryPack,
  AccountEntryPack,
  AccountPasses,
} from "@/features/account/account-passes.server";
import { AccountSectionPanel } from "@/features/account/components/shell/account-section-panel";
import { type Locale, m } from "@/features/i18n";
import { EntryPackMeter } from "@/features/passes/components/entry-pack-meter";
import { entryPackCheckoutPath } from "@/features/passes/routes";
import { GuardedLink } from "@/shared/components/guarded-link";
import { Button } from "@/shared/components/ui/button";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { StatusBadge } from "@/shared/components/ui/status-badge";
import { textLink } from "@/shared/components/ui/text-link";
import { FocusedGiftPassCard, GiftInvitationResend } from "./account-pass-gift";

type PassesPanelProps = {
  readonly packs: Promise<AccountPasses>;
  readonly locale: Locale;
};

export function AccountPassesPanel({ packs, locale }: PassesPanelProps) {
  return (
    <AccountSectionPanel
      actions={
        <Button asChild size="sm" variant="secondary" wrap>
          <GuardedLink href={`/${locale}${entryPackCheckoutPath}`}>
            <Ticket aria-hidden="true" className="size-4 shrink-0" />
            {m.entryPackCheckoutTitle({}, { locale })}
          </GuardedLink>
        </Button>
      }
      title={m.accountSectionPasses({}, { locale })}
      titleId="account-passes-title"
    >
      <Suspense
        fallback={
          <div role="status">
            <span className="sr-only">
              {m.accountContentLoading({}, { locale })}
            </span>
            <Skeleton aria-hidden="true" className="h-40 rounded-2xl" />
          </div>
        }
      >
        <AccountPassesBody locale={locale} packs={packs} />
      </Suspense>
    </AccountSectionPanel>
  );
}

function AccountPassesBody({ packs, locale }: PassesPanelProps) {
  const loaded = use(packs);
  if (
    loaded === "unavailable" ||
    (loaded.held.length === 0 && loaded.boughtForOthers.length === 0)
  ) {
    return (
      <p className="text-sm text-slate-600">
        {loaded === "unavailable"
          ? m.accountPassesUnavailable({}, { locale })
          : m.accountPassesEmpty({}, { locale })}
      </p>
    );
  }

  const active = loaded.held.filter((pack) => pack.status === "active");
  const past = loaded.held.filter((pack) => pack.status !== "active");
  return (
    <div className="@container space-y-8">
      {active.length > 0 && (
        <EntryPackGroup
          locale={locale}
          packs={active}
          title={m.accountPassesActive({}, { locale })}
        />
      )}
      {loaded.boughtForOthers.length > 0 && (
        <BoughtEntryPackGifts gifts={loaded.boughtForOthers} locale={locale} />
      )}
      {past.length > 0 && (
        <EntryPackGroup
          locale={locale}
          packs={past}
          title={m.accountPassesPast({}, { locale })}
        />
      )}
    </div>
  );
}

function BoughtEntryPackGifts({
  gifts,
  locale,
}: {
  readonly gifts: readonly AccountBoughtEntryPack[];
  readonly locale: Locale;
}) {
  return (
    <section aria-labelledby="account-bought-entry-packs">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3
          className="text-sm font-semibold uppercase tracking-wider text-slate-600"
          id="account-bought-entry-packs"
        >
          {m.accountPassesBoughtForOthers({}, { locale })}
        </h3>
        <p className="text-sm text-slate-600">
          {m.accountPassesBoughtForOthersNote({}, { locale })}
        </p>
      </div>
      <ul className="space-y-3">
        {gifts.map((gift) => (
          <li
            className="grid gap-3 rounded-2xl border border-dashed border-slate-300 p-4 @2xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @2xl:items-start"
            key={gift.orderId}
          >
            <div className="min-w-0 space-y-1">
              <h4 className="break-words font-semibold">
                {gift.tier} ·{" "}
                {m.entryPackCheckoutPackLabel(
                  { count: gift.entryCount },
                  { locale }
                )}
              </h4>
              {gift.maskedHolderEmail && (
                <p className="break-words text-sm text-slate-600">
                  {m.accountPassGiftFor(
                    { email: gift.maskedHolderEmail },
                    { locale }
                  )}
                </p>
              )}
              <GuardedLink
                className={textLink({ className: "text-sm" })}
                href={gift.statusPath}
              >
                {m.accountPassGiftOrderStatus({}, { locale })}
              </GuardedLink>
            </div>
            <div className="flex flex-wrap items-center gap-2 @2xl:justify-end">
              <StatusBadge tone={gift.claimed ? "positive" : "attention"}>
                {gift.claimed
                  ? m.accountPassGiftClaimed({}, { locale })
                  : m.accountPassGiftNotClaimed({}, { locale })}
              </StatusBadge>
              <StatusBadge
                tone={
                  (
                    {
                      not_sent: "neutral",
                      pending: "progress",
                      sent: "positive",
                      failed: "attention",
                    } as const
                  )[gift.invitation]
                }
              >
                {{
                  not_sent: m.entryPackStatusGiftInvitationNotSent,
                  pending: m.entryPackStatusGiftInvitationPending,
                  sent: m.entryPackStatusGiftInvitationSent,
                  failed: m.entryPackStatusGiftInvitationFailed,
                }[gift.invitation]({}, { locale })}
              </StatusBadge>
              <GiftInvitationResend
                canResend={gift.canResend}
                locale={locale}
                orderId={gift.orderId}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EntryPackGroup({
  locale,
  packs,
  title,
}: {
  readonly locale: Locale;
  readonly packs: readonly AccountEntryPack[];
  readonly title: string;
}) {
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-600">
        {title}
      </h3>
      <ul className="space-y-4">
        {packs.map((pack) => (
          <li key={pack.position}>
            <AccountEntryPackCard locale={locale} pack={pack} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AccountEntryPackCard({
  locale,
  pack,
}: {
  readonly locale: Locale;
  readonly pack: AccountEntryPack;
}) {
  const {
    bookPath,
    boughtOn,
    entriesLeft,
    entryCount,
    gift,
    lastUsableDay,
    status,
    tier,
  } = pack;

  const cardClassName = "overflow-hidden rounded-2xl border border-slate-200";
  const titleId = gift ? `account-gift-pack-title-${pack.position}` : undefined;
  const contents = (
    <>
      <div className="space-y-4 p-4 sm:p-6">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words text-xs font-semibold uppercase tracking-wider text-emerald-900">
              {m.entryPackCheckoutPackLabel({ count: entryCount }, { locale })}
            </p>
            <h4
              className="mt-1 break-words text-lg font-semibold sm:text-2xl"
              id={titleId}
            >
              {tier}
            </h4>
          </div>
          <div className="max-w-[45%] text-end text-sm">
            {gift && (
              <p className="break-words font-semibold text-burned-orange-ink">
                <Gift
                  aria-hidden="true"
                  className="me-1 inline size-4 align-[-0.15em]"
                />
                {gift.buyerName
                  ? m.accountPassBoughtForYouBy(
                      { name: gift.buyerName },
                      { locale }
                    )
                  : m.accountPassBoughtForYou({}, { locale })}
              </p>
            )}
            <p className="text-slate-600">
              {m.accountPassBoughtOn({ date: boughtOn }, { locale })}
            </p>
          </div>
        </header>
        <EntryPackMeter
          className="text-lg"
          entriesLeft={entriesLeft}
          entryCount={entryCount}
          locale={locale}
        />
        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-slate-200 pt-4">
          <dl>
            <dt className="text-xs font-semibold uppercase tracking-wider text-slate-600">
              {m.entryPackCheckoutValidUntil({}, { locale })}
            </dt>
            <dd className="mt-1 text-sm font-semibold">{lastUsableDay}</dd>
          </dl>
          {status !== "active" && (
            <StatusBadge tone="neutral">
              {{
                expired: m.accountPassExpired,
                depleted: m.accountPassDepleted,
                ended: m.accountPassEnded,
              }[status]({}, { locale })}
            </StatusBadge>
          )}
        </div>
      </div>
      {bookPath && (
        <div className="flex justify-end border-t border-slate-200 bg-stone-50 px-4 py-3 sm:px-6">
          <Button asChild size="sm" wrap>
            <GuardedLink href={bookPath}>
              <CalendarPlus aria-hidden="true" className="size-4 shrink-0" />
              {m.accountPassBookDate({}, { locale })}
            </GuardedLink>
          </Button>
        </div>
      )}
    </>
  );

  return gift ? (
    <FocusedGiftPassCard
      className={cardClassName}
      locale={locale}
      orderId={gift.orderId}
      titleId={titleId}
    >
      {contents}
    </FocusedGiftPassCard>
  ) : (
    <article className={cardClassName}>{contents}</article>
  );
}
