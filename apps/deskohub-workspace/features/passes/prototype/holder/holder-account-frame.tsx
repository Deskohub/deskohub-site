"use client";

// PROTOTYPE ONLY (#1361): AccountFrame with the real navigation look plus a
// "Passes" section, which the production AccountShell can't add yet.
import {
  Bot,
  CalendarDays,
  CreditCard,
  Gift,
  KeyRound,
  ShieldCheck,
  Ticket,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { AccountFrame } from "@/features/account/components/shell/account-frame";
import { SignOutButton } from "@/features/account/components/sign-out-button";
import {
  type AccountSection,
  accountSectionLabel,
} from "@/features/account/sections";
import { type Locale, m } from "@/features/i18n";
import { NavItem } from "@/shared/components/ui/nav-item";

type HolderSection = AccountSection | "passes";

export function HolderAccountFrame({
  activeSection,
  children,
  locale,
  passCount,
  showPassesSection,
}: {
  readonly activeSection: HolderSection;
  readonly children: ReactNode;
  readonly locale: Locale;
  readonly passCount: number;
  readonly showPassesSection: boolean;
}) {
  const sections = [
    { icon: CalendarDays, key: "reservations" as HolderSection, badge: 2 },
    ...(showPassesSection
      ? [{ icon: Ticket, key: "passes" as HolderSection, badge: passCount }]
      : []),
    { icon: Gift, key: "referrals" as HolderSection },
    { icon: UserRound, key: "profile" as HolderSection },
    { icon: KeyRound, key: "security" as HolderSection },
    { icon: Bot, key: "assistants" as HolderSection },
    { icon: CreditCard, key: "billing" as HolderSection },
    { icon: ShieldCheck, key: "legal" as HolderSection },
    { icon: TriangleAlert, key: "danger" as HolderSection },
  ];
  const label = (key: HolderSection) =>
    key === "passes" ? "Passes" : accountSectionLabel(key, locale);
  const href = (key: HolderSection) =>
    key === "passes"
      ? `/${locale}/prototype-passes/account`
      : `/${locale}/prototype-passes/account?variant=in-reservations`;

  return (
    <AccountFrame
      navigation={
        <nav
          aria-label={m.accountNavigationLabel({}, { locale })}
          className="-mx-4 min-w-0 rounded-none border-0 bg-white p-0 sm:-mx-6 md:mx-0 md:rounded-[20px] md:border md:border-[#dfe4ec] md:p-4"
        >
          <div className="md:hidden">
            <div className="flex min-w-0 flex-nowrap gap-2 overflow-x-auto">
              {sections.map((section) => (
                <NavItem
                  active={activeSection === section.key}
                  asChild
                  className="shrink-0"
                  key={section.key}
                  layout="tab"
                  tone={section.key === "danger" ? "danger" : "neutral"}
                >
                  <a href={href(section.key)}>{label(section.key)}</a>
                </NavItem>
              ))}
            </div>
          </div>
          <div className="hidden md:block">
            <div className="grid gap-[6px]">
              {sections.map((section) => {
                const Icon = section.icon;
                return (
                  <NavItem
                    active={activeSection === section.key}
                    asChild
                    key={section.key}
                    tone={section.key === "danger" ? "danger" : "neutral"}
                  >
                    <a href={href(section.key)}>
                      <Icon aria-hidden="true" />
                      <span className="min-w-0 break-words">
                        {label(section.key)}
                      </span>
                      {section.badge !== undefined && (
                        <span className="ml-auto min-w-9 shrink-0 whitespace-nowrap rounded-full bg-[#b06147] px-2.5 py-1 text-center text-sm font-bold leading-none text-white [font-family:var(--font-sculpin,Arial),sans-serif]">
                          {section.badge}
                        </span>
                      )}
                    </a>
                  </NavItem>
                );
              })}
            </div>
          </div>
        </nav>
      }
      signOut={<SignOutButton locale={locale} />}
      title={m.accountTitle({}, { locale })}
    >
      {children}
    </AccountFrame>
  );
}
