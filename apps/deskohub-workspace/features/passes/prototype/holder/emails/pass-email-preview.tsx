// PROTOTYPE ONLY (#1361): renders a pass email prototype with mock data into
// the preview frame. Server component; no provider, nothing is sent.
import Link from "next/link";
import { render } from "react-email";
import type { Locale } from "@/features/i18n";
import {
  passById,
  type PrototypePass,
} from "@/features/passes/prototype/mock-passes";
import {
  HolderInvitationEmail,
  holderInvitationSubject,
} from "./holder-invitation-email";
import { PrototypeEmailFrame } from "./prototype-email-frame";
import {
  PurchaseConfirmationEmail,
  purchaseConfirmationSubject,
} from "./purchase-confirmation-email";

export const PASS_EMAIL_PRODUCTS = [
  { key: "entry-pack", label: "Entry pack" },
  { key: "unlimited", label: "Unlimited" },
] as const;

const SENDER = "Deskohub Workspace <info@example.com>";
const ORIGIN = "https://workspace.example.com";

export async function PassEmailPreview({
  email,
  locale,
  product,
}: {
  readonly email: "holder-invitation" | "purchase-confirmation";
  readonly locale: Locale;
  readonly product: string;
}) {
  const isPack = product !== "unlimited";
  let html: string;
  let subject: string;
  let to: string;

  if (email === "holder-invitation") {
    // Martin → Lucie (pack); Atelier Nord → Eva (Unlimited)
    const pass = passById(isPack ? "pass_4MZT" : "pass_2BWD") as PrototypePass;
    const props = {
      locale,
      pass,
      signInUrl: `${ORIGIN}/${locale}/account/sign-in?prototype`,
    };
    html = await render(<HolderInvitationEmail {...props} />);
    subject = holderInvitationSubject(props);
    to = pass.holder.email;
  } else {
    // Martin buys a pack for Lucie; Petr buys Unlimited + coffee for himself
    const pass = passById(isPack ? "pass_4MZT" : "pass_9HX3") as PrototypePass;
    const props = {
      accountUrl: `${ORIGIN}/${locale}/account/passes`,
      locale,
      pass,
      refundTermsUrl: `${ORIGIN}/${locale}/terms#passes`,
    };
    html = await render(<PurchaseConfirmationEmail {...props} />);
    subject = purchaseConfirmationSubject(props);
    to = (pass.buyer ?? pass.holder).email;
  }

  return (
    <main className="min-h-screen bg-[#f4f1ea] px-2 py-8 sm:px-4 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-4 px-2 font-black text-3xl text-navy-blue tracking-tight sm:px-0">
          Pass email prototypes
        </h1>
        <nav className="mb-4 flex flex-wrap gap-2 px-2 sm:px-0">
          {(
            [
              ["holder-invitation", "Holder invitation"],
              ["purchase-confirmation", "Purchase confirmation"],
            ] as const
          ).map(([href, label]) => (
            <Link
              className={`rounded-full border px-4 py-2 font-semibold text-sm shadow-sm ${
                href === email
                  ? "border-navy-blue bg-navy-blue text-white"
                  : "border-navy-blue/15 bg-white/70 text-navy-blue"
              }`}
              href={`/${locale}/prototype-passes/emails/${href}?product=${product}`}
              key={href}
            >
              {label}
            </Link>
          ))}
        </nav>
        <PrototypeEmailFrame from={SENDER} html={html} subject={subject} to={to} />
      </div>
    </main>
  );
}
