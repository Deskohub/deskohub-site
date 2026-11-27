import { expect, test } from "bun:test";
import { Effect } from "effect";
import { orderIdSchema } from "@/features/order";
import {
  getEntryPackPrice,
  getEntryPackValidity,
} from "@/features/passes/pass-offer";
import { renderWorkspaceEmail } from "@/shared/backend/email/render-react-email";
import { currencyCZK } from "@/shared/money/currencies";
import { plainDateStringSchema } from "@/shared/utils/temporal";
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

test("renders the paid coffee price for a pass bought before catalog repricing", async () => {
  const product = { kind: "unlimited", tier: "open-space" } as const;
  const { text } = await Effect.runPromise(
    renderWorkspaceEmail(
      <EntryPackPurchaseEmail
        orderId={orderIdSchema.make("019ac0e6-f461-77de-9492-26af32cc74a3")}
        paidAt={Temporal.Instant.from("2026-11-18T09:30:00Z")}
        tier={product.tier}
        entryCount={null}
        validFrom={plainDateStringSchema.make("2026-11-18")}
        validUntil={plainDateStringSchema.make("2026-12-18")}
        locale="en-US"
        quote={{
          product,
          discountableSubtotal: currencyCZK(350_000),
          discountedSubtotal: currencyCZK(350_000),
          totalDiscount: currencyCZK(0),
          discounts: [],
        }}
        holderEmail={null}
        invoiceRequested={false}
        statusUrl="https://example.com/status"
        termsUrl="https://example.com/terms"
        coffeeAmountMinor={53_000}
      />
    )
  );

  expect(text).toMatch(/Coffee\s+CZK\s+530/u);
  expect(text).toMatch(/4,030/u);
});
