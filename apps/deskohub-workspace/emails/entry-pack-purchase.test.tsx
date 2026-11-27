import { expect, test } from "bun:test";
import { Effect } from "effect";
import { orderIdSchema } from "@/features/order";
import {
  getEntryPackPrice,
  getEntryPackValidity,
  getUnlimitedPassPrice,
} from "@/features/passes/pass-offer";
import { getUnlimitedPassEndDate } from "@/features/passes/unlimited-pass";
import { renderWorkspaceEmail } from "@/shared/backend/email/render-react-email";
import { currencyCZK } from "@/shared/money/currencies";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { EntryPackGiftInvitationEmail } from "./entry-pack-gift-invitation";
import { EntryPackPurchaseEmail } from "./entry-pack-purchase";

test("renders the buyer-only order link, consent terms and pack amount", async () => {
  const orderId = orderIdSchema.make("019ac0e6-f461-77de-9492-26af32cc74a3");
  const paidAt = Temporal.Instant.from("2026-11-18T09:30:00Z");
  const product = { kind: "entry-pack", tier: "open-space", size: 10 } as const;
  const statusUrl = `https://example.com/en-US/reservation/status/${orderId}`;
  const termsUrl = "https://example.com/en-US/terms-and-conditions";
  const { html, text } = await Effect.runPromise(
    renderWorkspaceEmail(
      <EntryPackPurchaseEmail
        orderId={orderId}
        paidAt={paidAt}
        tier={product.tier}
        entryCount={product.size}
        {...getEntryPackValidity(paidAt, product.size)}
        locale="en-US"
        quote={{
          product,
          discountableSubtotal: getEntryPackPrice(product),
          discountedSubtotal: getEntryPackPrice(product),
          totalDiscount: currencyCZK(0),
          discounts: [],
        }}
        holderEmail={null}
        invoiceRequested
        statusUrl={statusUrl}
        termsUrl={termsUrl}
      />
    )
  );
  expect(html).toContain(`href="${statusUrl}"`);
  expect(html).toContain(`href="${termsUrl}"`);
  expect(html).not.toContain("/reservation/access/");
  expect(text).toContain(orderId);
  expect(text).toContain("2,190");
});

test("uses membership copy for the gift purchase and invitation", async () => {
  const orderId = orderIdSchema.make("019ac0e6-f461-77de-9492-26af32cc74a3");
  const product = { kind: "unlimited", tier: "open-space" } as const;
  const price = getUnlimitedPassPrice(product);
  const validFrom = plainDateStringSchema.make("2026-11-18");
  const gift = {
    entryCount: null,
    holderEmail: "recipient@example.com",
    locale: "en-US",
    tier: product.tier,
    validUntil: getUnlimitedPassEndDate(validFrom),
  } as const;

  const purchase = await Effect.runPromise(
    renderWorkspaceEmail(
      <EntryPackPurchaseEmail
        {...gift}
        gift
        invitationSent
        invoiceRequested={false}
        orderId={orderId}
        paidAt={Temporal.Instant.from("2026-11-18T09:30:00Z")}
        quote={{
          product,
          discountableSubtotal: price,
          discountedSubtotal: price,
          totalDiscount: currencyCZK(0),
          discounts: [],
        }}
        statusUrl={`https://example.com/en-US/reservation/status/${orderId}`}
        termsUrl="https://example.com/en-US/terms-and-conditions"
        validFrom={validFrom}
      />
    )
  );
  const invitation = await Effect.runPromise(
    renderWorkspaceEmail(
      <EntryPackGiftInvitationEmail
        {...gift}
        buyerName={null}
        claimUrl="https://example.com/en-US/account/passes"
      />
    )
  );

  expect(purchase.text).toContain("YOUR UNLIMITED MEMBERSHIP IS PAID");
  expect(purchase.text).toContain("Open membership");
  expect(purchase.text).not.toContain("Entry pack");
  expect(invitation.text).toContain("YOU RECEIVED AN UNLIMITED MEMBERSHIP");
  expect(invitation.text).toContain("Claim membership");
  expect(invitation.text).toContain("Valid through");
  expect(invitation.text).not.toContain("Entry pack");
  expect(invitation.text).not.toContain("one day at a time");
});
