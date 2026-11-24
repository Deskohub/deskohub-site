import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import {
  audienceAttributeCatalogue,
  campaignSourceParam,
  choiceParam,
  countAttribute,
  defineAudienceAttributeCatalogue,
  periodParam,
} from "@deskohub/workspace-admin-api";
import { Effect, Schema } from "effect";
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

/**
 * Its resolver reads the period as the request's bounds, and no campaign,
 * since it names no campaign source.
 */
type GiftCardCountRequest = Parameters<
  (typeof extendedResolvers)["giftCardCount"]["count"]
>[0];
export type GiftCardCountRequestChecks = [
  Expect<Equal<keyof GiftCardCountRequest["params"], never>>,
  Expect<
    Equal<keyof GiftCardCountRequest, "bounds" | "reservationsAsOf" | "params">
  >,
];

const countPresentation = {
  label: "Emails received",
  section: "Reservations",
  editor: {
    lead: [{ text: "emails received" }],
    period: "Emails",
    count: "Email count",
  },
  summary: { verb: "received", noun: { one: "email", other: "emails" } },
} as const;

/** A campaign source only its request's `campaign` param can fix. */
const sourcedEmailCount = countAttribute("sourcedEmailCount", {
  ...countPresentation,
  params: { period: periodParam, source: campaignSourceParam },
  defaults: {
    params: { period: { _tag: "AnyTime" } },
    operator: "gte",
    value: 1,
  },
});

/** A `campaign` param that isn't a campaign source. */
const campaignChoiceCount = countAttribute("campaignChoiceCount", {
  ...countPresentation,
  params: {
    period: periodParam,
    campaign: choiceParam(Schema.Literals(["welcome", "promotion"]), {
      label: "Campaign",
      control: "select",
      options: {
        welcome: { label: "welcome" },
        promotion: { label: "promotion" },
      },
    }),
  },
  defaults: {
    params: { period: { _tag: "AnyTime" }, campaign: "welcome" },
    operator: "gte",
    value: 1,
  },
});

/** Neither gets a resolver its request could feed. */
export type MisplacedContextualParamChecks = [
  Expect<
    Equal<
      AudienceAttributeResolvers<{
        readonly sourcedEmailCount: typeof sourcedEmailCount;
      }>["sourcedEmailCount"],
      never
    >
  >,
  Expect<
    Equal<
      AudienceAttributeResolvers<{
        readonly campaignChoiceCount: typeof campaignChoiceCount;
      }>["campaignChoiceCount"],
      never
    >
  >,
];
