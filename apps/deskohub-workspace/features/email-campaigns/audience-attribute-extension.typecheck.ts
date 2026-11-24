import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import {
  type AudienceConditionOf,
  audienceAttributeCatalogue,
  campaignSourceParam,
  countAttribute,
  defineAudienceAttributeCatalogue,
  periodParam,
} from "@deskohub/workspace-admin-api";
import { Effect } from "effect";
import type { AudienceCountRequest } from "./audience-filter";
import {
  type AudienceAttributeResolvers,
  audienceAttributeResolvers,
} from "./backend/audience-attribute-resolvers";

/**
 * A new count attribute takes one catalogue entry and its resolver; the
 * schema, defaults, editor, summary, fact requests, and evaluation work from
 * the entry by kind. `audience-attribute-extension.test.tsx` runs it through
 * them.
 */
export const giftCardCount = countAttribute("giftCardCount", {
  label: "Gift cards bought",
  section: "Reservations",
  params: { period: periodParam },
  editor: {
    lead: [{ text: "gift cards bought" }],
    period: "Gift cards",
    count: "Gift card count",
  },
  summary: { verb: "bought", noun: { one: "gift card", other: "gift cards" } },
  defaults: {
    params: { period: { _tag: "Last", count: 30, unit: "day" } },
    operator: "gte",
    value: 2,
  },
});

export const extendedCatalogue = defineAudienceAttributeCatalogue({
  ...audienceAttributeCatalogue,
  giftCardCount,
});

export const extendedResolvers: AudienceAttributeResolvers<
  typeof extendedCatalogue
> = {
  ...audienceAttributeResolvers,
  giftCardCount: {
    count: () =>
      Effect.succeed(new Map([[DotyposCustomerIdSchema.make("buyer"), 3]])),
    readsVisits: () => false,
  },
};

// @ts-expect-error A catalogue entry without a resolver fails the typecheck.
const withoutResolver: AudienceAttributeResolvers<typeof extendedCatalogue> =
  audienceAttributeResolvers;

void withoutResolver;

type Expect<T extends true> = T;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

/** A request pairs each attribute with its own params only. */
type MismatchedRequest = Omit<AudienceCountRequest, "condition"> & {
  readonly condition: Omit<
    AudienceConditionOf<"reservationCount">,
    "params"
  > & {
    readonly params: AudienceConditionOf<"campaignEmailCount">["params"];
  };
};
export type CountRequestPairingChecks = [
  Expect<
    Equal<MismatchedRequest extends AudienceCountRequest ? true : false, false>
  >,
];

/**
 * A campaign source may take any name: its entry's part decides that the
 * request fixes it, and its resolver fixes it through `inContext`.
 */
export const sourcedEmailCount = countAttribute("sourcedEmailCount", {
  label: "Emails received",
  section: "Reservations",
  params: { period: periodParam, source: campaignSourceParam },
  editor: {
    lead: [{ text: "emails received" }],
    period: "Emails",
    count: "Email count",
  },
  summary: { verb: "received", noun: { one: "email", other: "emails" } },
  defaults: {
    params: { period: { _tag: "AnyTime" } },
    operator: "gte",
    value: 1,
  },
});

export const sourcedCatalogue = defineAudienceAttributeCatalogue({
  ...audienceAttributeCatalogue,
  sourcedEmailCount,
});

export const sourcedResolvers: AudienceAttributeResolvers<
  typeof sourcedCatalogue
> = {
  ...audienceAttributeResolvers,
  sourcedEmailCount: {
    // Counts one email for the fixed campaign, so a test sees which it was.
    count: ({ params: { source }, inContext }) =>
      Effect.succeed(
        new Map([
          [
            DotyposCustomerIdSchema.make(
              String(source && inContext.campaign(source))
            ),
            1,
          ],
        ])
      ),
    readsVisits: () => false,
  },
};
