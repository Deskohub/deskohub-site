import { describe, expect, test } from "bun:test";
import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Option, Schema } from "effect";
import { type Locale, locales } from "@/features/i18n";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import {
  CampaignDeliveryAudience,
  CampaignEmailOccasion,
  campaignEmailMessage,
} from "../campaign-email";
import type { CampaignSendId } from "../campaign-identifiers";
import { campaignBodyDocument } from "./campaign-body-document";
import {
  type PassReminderCopyInput,
  renderPassReminderCopyV1,
} from "./pass-reminder-copy";

const reservedDesk = "reserved-desk";
const actionUrl =
  "https://workspace.example.com/passes?pass=example&source=email";
const unsubscribeUrl = "https://workspace.example.com/unsubscribe";
const date = plainDateStringSchema.make;
const entryPack = {
  product: "entry-pack",
  tier: reservedDesk,
  locale: "en-US",
  firstName: "Lucie",
  endsOn: date("2027-01-14"),
  remainingEntries: 2,
  totalEntries: 5,
  actionUrl,
} satisfies PassReminderCopyInput;
const unlimited = {
  product: "unlimited",
  tier: reservedDesk,
  locale: "en-US",
  firstName: "Petr",
  endsOn: date("2026-12-02"),
  renewalStartsOn: date("2026-12-03"),
  deskLabel: "Desk 14",
  actionUrl,
} satisfies PassReminderCopyInput;

const decodeBody = Schema.decodeUnknownSync(
  campaignBodyDocument(Option.none())
);

const render = (input: PassReminderCopyInput) => {
  const content = renderPassReminderCopyV1(input);
  decodeBody(content.body);
  return Effect.runPromise(
    campaignEmailMessage({
      locale: input.locale,
      templateKey: "workspace",
      content,
      occasion: CampaignEmailOccasion.Delivery({
        audience: CampaignDeliveryAudience.Marketing({ unsubscribeUrl }),
        to: testEmailAddress("reminder-recipient"),
        recipient: {
          sendId: "reminder-send" as CampaignSendId,
          dotyposCustomerId: DotyposCustomerIdSchema.make("42"),
        },
      }),
      sender: {
        from: { email: testEmailAddress("campaigns") },
        replyTo: { email: testEmailAddress("hello") },
      },
      deploymentEnvironment: "preview",
    })
  );
};

const expectedCopy = {
  "cs-CZ": [
    "V balíčku ti zbývají 2 vstupy",
    "Rezervovat den",
    "Obnovit na 30 dní",
    "Dobrý den,",
  ],
  "de-DE": [
    "Noch 2 Eintritte in deinem Paket",
    "Einen Tag buchen",
    "Um 30 Tage verlängern",
    "Guten Tag,",
  ],
  "en-US": [
    "2 entries left on your Entry pack",
    "Book a day",
    "Renew for 30 days",
    "Hello,",
  ],
  "hi-IN": [
    "आपके प्रवेश पैक में 2 एंट्री बाकी",
    "एक दिन बुक करें",
    "30 दिनों के लिए बढ़ाएँ",
    "नमस्ते,",
  ],
  "sk-SK": [
    "V balíku ti zostávajú 2 vstupy",
    "Rezervovať deň",
    "Predĺžiť o 30 dní",
    "Dobrý deň,",
  ],
  "uk-UA": [
    "У пакеті залишилося 2 відвідування",
    "Забронювати день",
    "Продовжити на 30 днів",
    "Вітаємо!",
  ],
  "vi-VN": [
    "Gói lượt vào của bạn còn 2 lượt",
    "Đặt chỗ một ngày",
    "Gia hạn thêm 30 ngày",
    "Xin chào,",
  ],
} satisfies Record<Locale, readonly [string, string, string, string]>;

describe("pass reminder campaign copy v1", () => {
  test.each(locales)(
    "renders both reminders and an Open Space renewal in %s",
    async (locale) => {
      const [pack, renewal, openSpace] = await Promise.all([
        render({ ...entryPack, locale }),
        render({ ...unlimited, locale }),
        render({
          ...unlimited,
          locale,
          tier: "open-space",
          firstName: undefined,
        }),
      ]);
      const [packSubject, book, renew, unnamedGreeting] = expectedCopy[locale];

      expect(pack.subject).toBe(packSubject);
      expect(pack.text).toContain(book);
      expect(renewal.text).toContain(renew);
      expect(renewal.html).toContain("<strong>Desk 14</strong>");
      expect(openSpace.text).toContain(renew);
      expect(openSpace.text).toContain(unnamedGreeting);
      expect(openSpace.html).not.toContain("Desk 14");
      expect(openSpace.subject).toBe(renewal.subject);
      for (const email of [pack, renewal, openSpace]) {
        expect(email.html).toContain(`lang="${locale}"`);
        expect(email.html).toContain(
          'href="https://workspace.example.com/passes?pass=example&amp;source=email"'
        );
        expect(email.html).toContain(`href="${unsubscribeUrl}"`);
        expect(email.headers?.["List-Unsubscribe"]).toBe(`<${unsubscribeUrl}>`);
        expect(email.html).not.toContain("{deskLabel}");
      }
    }
  );

  test("keeps the approved English copy and emphasis", async () => {
    const [pack, renewal] = await Promise.all([
      render(entryPack),
      render(unlimited),
    ]);

    expect(pack.html).toContain("Your Reserved Desk pack ends on Thu 14 Jan.");
    expect(pack.html).toContain("Hi Lucie,");
    expect(pack.html).toContain(
      "Your Reserved Desk Entry pack ends on <strong>Thu 14 Jan</strong>, and <strong>2 of its 5 entries</strong> are still unused. Pick your days now so they don’t go to waste."
    );
    expect(pack.text).toContain(
      "Entries that aren’t booked by then expire with the pack."
    );
    expect(renewal.subject).toBe("Your Unlimited pass ends on Wed 2 Dec");
    expect(renewal.html).toContain(
      "Renew now to keep Desk 14 for the next 30 days."
    );
    expect(renewal.html).toContain("Hi Petr,");
    expect(renewal.html).toContain(
      "Your Reserved Desk Unlimited pass ends on <strong>Wed 2 Dec</strong>. Renew now and your next 30 days start right after, on Thu 3 Dec, at <strong>Desk 14</strong>."
    );
    expect(renewal.text).toContain(
      "If Desk 14 is no longer free when you renew, we’ll assign you another desk."
    );
  });

  test("uses the singular for one remaining entry", async () => {
    const email = await render({
      ...entryPack,
      remainingEntries: 1,
      totalEntries: 10,
    });

    expect(email.subject).toBe("1 entry left on your Entry pack");
    expect(email.html).toContain(
      "<strong>1 of its 10 entries</strong> is still unused"
    );
  });

  test("preserves calendar dates across Prague's DST transition and omits a missing desk", async () => {
    const email = await render({
      ...unlimited,
      firstName: " ",
      deskLabel: undefined,
      endsOn: date("2027-03-28"),
      renewalStartsOn: date("2027-03-29"),
    });

    expect(email.subject).toBe("Your Unlimited pass ends on Sun 28 Mar");
    expect(email.html).toContain("Renew now for the next 30 days.");
    expect(email.html).toContain(
      "<strong>Sun 28 Mar</strong>. Renew now and your next 30 days start right after, on Mon 29 Mar."
    );
    expect(email.text).toContain("Hello,");
    expect(email.text).not.toContain("another desk");
  });

  test("keeps names and labels literal through HTML and plain-text rendering", async () => {
    const firstName = "A <img src=x> [visit](https://injected.example)";
    const deskLabel = 'Desk <strong>14</strong> & "*extra*"';
    const email = await render({ ...unlimited, firstName, deskLabel });

    expect(email.html).toContain(
      "A &lt;img src=x&gt; [visit](https://injected.example)"
    );
    expect(email.html).toContain(
      "<strong>Desk &lt;strong&gt;14&lt;/strong&gt; &amp; &quot;*extra*&quot;</strong>"
    );
    expect(email.html).not.toContain('href="https://injected.example');
    expect(email.html).not.toContain("<img src=x>");
    expect(email.text).toContain(firstName);
    expect(email.text).toContain(deskLabel);
  });
});
