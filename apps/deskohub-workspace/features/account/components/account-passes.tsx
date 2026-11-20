import { CalendarPlus, Ticket } from "lucide-react";
import { Suspense, use } from "react";
import type {
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
  if (loaded === "unavailable" || loaded.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        {loaded === "unavailable"
          ? m.accountPassesUnavailable({}, { locale })
          : m.accountPassesEmpty({}, { locale })}
      </p>
    );
  }

  const active = loaded.filter((pack) => pack.status === "active");
  const past = loaded.filter((pack) => pack.status !== "active");
  return (
    <div className="space-y-8">
      {active.length > 0 && (
        <EntryPackGroup
          locale={locale}
          packs={active}
          title={m.accountPassesActive({}, { locale })}
        />
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
    lastUsableDay,
    status,
    tier,
  } = pack;

  return (
    <article className="overflow-hidden rounded-2xl border border-slate-200">
      <div className="space-y-4 p-4 sm:p-6">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words text-xs font-semibold uppercase tracking-wider text-emerald-900">
              {m.entryPackCheckoutPackLabel({ count: entryCount }, { locale })}
            </p>
            <h4 className="mt-1 break-words text-lg font-semibold sm:text-2xl">
              {tier}
            </h4>
          </div>
          <p className="text-end text-sm text-slate-600">
            {m.accountPassBoughtOn({ date: boughtOn }, { locale })}
          </p>
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
    </article>
  );
}
