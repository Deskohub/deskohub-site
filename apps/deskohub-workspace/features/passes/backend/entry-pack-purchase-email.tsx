import "server-only";

import {
  EmailConfigTag,
  type EmailRecipient,
  EmailServiceTag,
} from "@deskohub/email";
import { Effect, Schema } from "effect";
import type { passPurchases } from "@/db/schema";
import {
  EntryPackPurchaseEmail,
  entryPackPurchaseEmailSubject,
} from "@/emails/entry-pack-purchase";
import { discountQuoteCodec } from "@/features/discounts/contracts";
import { getLegalDocumentPath } from "@/features/legal/legal-document-path";
import { reservationStatusPath } from "@/features/reservation/routes";
import { getWorkspaceRuntimeCallbackOrigin } from "@/shared/backend/config/workspace-url.config";
import { renderWorkspaceEmail } from "@/shared/backend/email/render-react-email";

export const sendEntryPackPurchaseEmail = Effect.fn(
  "sendEntryPackPurchaseEmail"
)(function* (input: {
  readonly purchase: typeof passPurchases.$inferSelect;
  readonly paidAt: Temporal.Instant;
  readonly buyer: EmailRecipient;
  readonly invoiceRequested: boolean;
}) {
  const { purchase, buyer } = input;
  const { locale, id } = purchase;
  const origin = yield* getWorkspaceRuntimeCallbackOrigin;
  const mailer = yield* EmailServiceTag;
  const { defaultFrom } = yield* EmailConfigTag;
  const quote = yield* Schema.decodeUnknownEffect(discountQuoteCodec)(
    purchase.quote
  );
  const rendered = yield* renderWorkspaceEmail(
    <EntryPackPurchaseEmail
      {...purchase}
      orderId={id}
      quote={quote}
      paidAt={input.paidAt}
      statusUrl={
        new URL(`/${locale}${reservationStatusPath}/${id}`, origin).href
      }
      termsUrl={
        new URL(getLegalDocumentPath(locale, "terms-and-conditions"), origin)
          .href
      }
      invoiceRequested={input.invoiceRequested}
    />
  );

  return yield* mailer.send({
    ...rendered,
    from: defaultFrom,
    to: buyer,
    subject: entryPackPurchaseEmailSubject({ locale }),
    idempotencyKey: `entry-pack-purchase:${id}`,
    tags: ["entry_pack_purchase"],
    sensitiveContent: true,
  });
});
