// PROTOTYPE ONLY (#1360, #1361, #1362): index of the Entry pack / Unlimited
// screen prototypes. Mock data only; lives under the testing-only route group.
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Pass prototypes",
  robots: { index: false, follow: false },
};

const SCREENS: { group: string; links: { href: string; label: string }[] }[] = [
  {
    group: "#1360 Purchase flows",
    links: [
      { href: "prototype-passes/entry-pack", label: "Entry pack purchase" },
      { href: "prototype-passes/unlimited", label: "Unlimited purchase" },
      { href: "prototype-passes/pricing", label: "Price page section" },
      { href: "prototype-passes/single-day-link", label: "Single-day flow link" },
    ],
  },
  {
    group: "#1361 Holder screens",
    links: [
      { href: "prototype-passes/account", label: "Account: passes" },
      { href: "prototype-passes/account/book", label: "Book a date with a pack entry" },
      { href: "prototype-passes/account/unlimited-access", label: "Unlimited access" },
      { href: "prototype-passes/emails/holder-invitation", label: "Holder invitation email" },
      { href: "prototype-passes/emails/purchase-confirmation", label: "Purchase confirmation email" },
    ],
  },
  {
    group: "#1362 Administration",
    links: [
      { href: "prototype-passes/administration", label: "Passes list" },
      { href: "prototype-passes/administration/pass_7Q2K", label: "Pass detail" },
      { href: "prototype-passes/administration/customers/cus_1001", label: "Customer detail with passes" },
    ],
  },
];

export default function PassPrototypesIndexPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-3xl">Pass prototypes</h1>
      <p className="mt-2 text-sm opacity-70">
        Throwaway screens with mock data. Not production.
      </p>
      {SCREENS.map((section) => (
        <section key={section.group} className="mt-8">
          <h2 className="text-lg">{section.group}</h2>
          <ul className="mt-2 list-disc pl-5">
            {section.links.map((link) => (
              <li key={link.href}>
                <Link className="underline" href={link.href}>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
