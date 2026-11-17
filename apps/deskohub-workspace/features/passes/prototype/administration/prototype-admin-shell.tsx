"use client";

// PROTOTYPE ONLY: a copy of AdminShell (features/administration/admin-shell.tsx)
// whose navigation adds a "Passes" entry under Operations. The real navigation
// list is a module constant, so the prototype can't add the entry without
// editing the shared shell. Breadcrumbs are static.

import {
  BadgePercent,
  CalendarRange,
  ChevronRight,
  CircleGauge,
  FileText,
  Gift,
  KeyRound,
  Layers,
  ListFilter,
  Mail,
  Menu,
  ShieldCheck,
  SquareTerminal,
  Ticket,
  Users,
} from "lucide-react";
import Link from "next/link";
import { type ComponentType, type ReactNode, type SVGProps, useId } from "react";
import { AdministrationLink } from "@/features/administration/admin-link";
import {
  administrationAreas,
  administrationOverview,
} from "@/features/administration/administration-areas";
import { AdministrationLocaleSwitcher } from "@/features/administration/administration-locale-switcher";
import { m } from "@/features/administration/i18n";
import type { Locale } from "@/features/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { SkipLink } from "@/shared/components/skip-link";
import { Button } from "@/shared/components/ui/button";
import { NavItem } from "@/shared/components/ui/nav-item";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/shared/components/ui/sheet";
import { cn } from "@/shared/utils";
import { adminBasePath } from "./admin-pass-data";

type Entry = {
  readonly key: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>;
  readonly label: (locale: Locale) => string;
  readonly href: (locale: Locale) => string;
  readonly prototype?: boolean;
};

const area = (
  key: string,
  icon: Entry["icon"],
  page: { href: string; label: (a: object, o: { locale: Locale }) => string }
): Entry => ({
  key,
  icon,
  label: (locale) => page.label({}, { locale }),
  href: (locale) => `/${locale}${page.href}`,
});

const navigation: readonly {
  label: (locale: Locale) => string;
  items: readonly Entry[];
}[] = [
  {
    label: (locale) => m.shellNavigationSectionOperations({}, { locale }),
    items: [
      area("overview", CircleGauge, administrationOverview),
      area("reservations", CalendarRange, administrationAreas.reservations),
      {
        key: "passes",
        icon: Layers,
        label: () => "Passes",
        href: (locale) => adminBasePath(locale),
        prototype: true,
      },
      area("customers", Users, administrationAreas.customers),
    ],
  },
  {
    label: (locale) => m.shellNavigationSectionDiscounts({}, { locale }),
    items: [
      area("codes", Ticket, administrationAreas.codes),
      area("vouchers", Gift, administrationAreas.vouchers),
      area("sales", BadgePercent, administrationAreas.sales),
    ],
  },
  {
    label: (locale) => m.shellNavigationSectionEmail({}, { locale }),
    items: [
      area("campaigns", Mail, administrationAreas["email-campaigns"]),
      area("audiences", ListFilter, administrationAreas["email-audiences"]),
    ],
  },
  {
    label: (locale) => m.shellNavigationSectionAdministration({}, { locale }),
    items: [
      area("invoices", FileText, administrationAreas.invoices),
      area("access-codes", KeyRound, administrationAreas["access-codes"]),
      area("administrators", ShieldCheck, administrationAreas.administrators),
      area("cli", SquareTerminal, {
        href: administrationAreas.cli.pages.sessions.href,
        label: m.shellNavigationCliSessions,
      }),
    ],
  },
];

export type PrototypeNavigationKey = "passes" | "customers";

function Navigation({
  active,
  mobile = false,
}: {
  readonly active: PrototypeNavigationKey;
  readonly mobile?: boolean;
}) {
  const locale = useRouteLocale();
  const id = useId();
  return (
    <nav aria-label={m.shellNavigationLabel({}, { locale })} className="space-y-7">
      {navigation.map((section, index) => (
        <div key={section.items[0]?.key}>
          <p
            className="mb-2 px-3 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-navy-blue/65"
            id={`${id}-${index}`}
          >
            {section.label(locale)}
          </p>
          <ul aria-labelledby={`${id}-${index}`} className="space-y-1">
            {section.items.map((item) => {
              const Icon = item.icon;
              const link = (
                <NavItem active={item.key === active} asChild>
                  <Link href={item.href(locale)}>
                    <Icon aria-hidden />
                    {item.label(locale)}
                  </Link>
                </NavItem>
              );
              return (
                <li key={item.key}>
                  {mobile ? <SheetClose asChild>{link}</SheetClose> : link}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export type PrototypeCrumb = { label: string; href?: string };

function Breadcrumbs({ crumbs }: { readonly crumbs: readonly PrototypeCrumb[] }) {
  const locale = useRouteLocale();
  const trail: PrototypeCrumb[] = [
    { label: m.shellBreadcrumbOverview({}, { locale }), href: `/${locale}/admin` },
    ...crumbs,
  ];
  return (
    <nav aria-label={m.shellBreadcrumbLabel({}, { locale })} className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm text-navy-blue/65 max-lg:flex-wrap max-lg:gap-y-1">
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          const phoneRoot = index === 0 && !last;
          return (
            <li
              className={cn(
                "flex min-w-0 items-center gap-1.5 max-lg:max-w-full",
                phoneRoot && "max-sm:hidden"
              )}
              key={crumb.label}
            >
              {index > 0 && (
                <ChevronRight
                  aria-hidden
                  className={cn("size-3.5 max-lg:shrink-0", index === 1 && "max-sm:hidden")}
                />
              )}
              {last || !crumb.href ? (
                <span className="truncate font-semibold text-navy-blue">{crumb.label}</span>
              ) : (
                <Link className="truncate hover:text-navy-blue" href={crumb.href}>
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Brand({
  labelClassName,
  locale,
}: {
  readonly labelClassName?: string;
  readonly locale: Locale;
}) {
  return (
    <AdministrationLink className="flex min-w-0 items-center gap-3" href={administrationOverview.href}>
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-burned-orange text-sm font-semibold text-white">
        D
      </span>
      <span className={cn("min-w-0", labelClassName)}>
        <span className="block truncate text-sm font-semibold leading-none">Deskohub</span>
        <span className="mt-1 block overflow-hidden text-ellipsis text-xs text-navy-blue/65">
          {m.shellBrandSubtitle({}, { locale })}
        </span>
      </span>
    </AdministrationLink>
  );
}

export function PrototypeAdminShell({
  active,
  children,
  crumbs,
}: {
  readonly active: PrototypeNavigationKey;
  readonly children: ReactNode;
  readonly crumbs: readonly PrototypeCrumb[];
}) {
  const locale = useRouteLocale();
  const breadcrumb = <Breadcrumbs crumbs={crumbs} />;
  return (
    <div className="min-h-screen bg-[#f6f6f3] text-navy-blue lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <SkipLink label={m.shellSkipToMainContent({}, { locale })} />
      <aside className="hidden border-r border-navy-blue/10 bg-white lg:block">
        <div className="sticky top-0 max-h-screen overflow-y-auto px-4 py-5">
          <Brand locale={locale} />
          <div className="mt-9">
            <Navigation active={active} />
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-40 border-b border-navy-blue/10 bg-white/95 backdrop-blur">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
            <Sheet>
              <SheetTrigger asChild>
                <Button
                  aria-label={m.shellOpenNavigation({}, { locale })}
                  className="shrink-0 lg:hidden"
                  size="icon"
                  variant="ghost"
                >
                  <Menu aria-hidden className="size-5" />
                </Button>
              </SheetTrigger>
              <SheetContent className="overflow-y-auto px-4 py-5" locale={locale} side="left">
                <SheetHeader className="sr-only">
                  <SheetTitle>{m.shellMobileNavigationTitle({}, { locale })}</SheetTitle>
                  <SheetDescription>
                    {m.shellMobileNavigationDescription({}, { locale })}
                  </SheetDescription>
                </SheetHeader>
                <Brand locale={locale} />
                <div className="mt-9">
                  <Navigation active={active} mobile />
                </div>
              </SheetContent>
            </Sheet>
            <div className="min-w-0 lg:hidden">
              <Brand labelClassName="max-[379px]:sr-only" locale={locale} />
            </div>
            <div className="hidden min-w-0 lg:block">{breadcrumb}</div>
            <div className="ml-auto shrink-0">
              <AdministrationLocaleSwitcher />
            </div>
          </div>
        </header>
        <div className="border-b border-navy-blue/10 bg-white px-4 py-3 lg:hidden">{breadcrumb}</div>
        {children}
      </div>
    </div>
  );
}
