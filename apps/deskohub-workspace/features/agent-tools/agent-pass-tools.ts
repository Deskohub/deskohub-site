import "server-only";

import { stripLocaleFromPathname } from "@deskohub/i18n/pathname";
import { Duration, Effect, Schema } from "effect";
import type { CurrentCustomerAccount } from "@/features/account";
import { customerPassesAgentScope } from "@/features/account/agent-scopes";
import type { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import { type Locale, locales } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import type { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { customerPassPurchaseLayers } from "@/features/passes/backend/customer-pass-purchase-layers";
import { CustomerPasses } from "@/features/passes/backend/customer-passes.service";
import {
  entryPackProductSchema,
  passTiers,
} from "@/features/passes/pass-offer";
import { unlimitedPassSelectionSchema } from "@/features/passes/unlimited-pass";
import { getWorkspaceRuntimeCallbackOrigin } from "@/shared/backend/config/workspace-url.config";
import {
  agentToolLocaleField,
  defineAgentTool,
  defineSignedInAgentTool,
  getAgentToolLocale,
} from "./agent-tool";
import { AgentToolError } from "./agent-tool-error";
import { requireAgentPassesOpen } from "./pass-funding";

const heldPassFields = {
  pass_id: Schema.String,
  tier: Schema.Literals(passTiers),
  valid_from: Schema.String,
  last_usable_date: Schema.String,
  status: Schema.String,
};

const listPasses = {
  name: "list_passes",
  title: "List the customer's Deskohub Workspace passes",
  description:
    "Lists the customer's held cowork passes: entry packs with remaining entries and expiry, and Unlimited passes with their dates. Use show_pass_access for a customer's Unlimited pass link.",
  input: Schema.Struct({ locale: agentToolLocaleField }),
  output: Schema.Struct({
    passes: Schema.Array(
      Schema.Union([
        Schema.Struct({
          ...heldPassFields,
          kind: Schema.Literal("entry-pack"),
          entries_left: Schema.Int,
        }),
        Schema.Struct({ ...heldPassFields, kind: Schema.Literal("unlimited") }),
      ])
    ),
  }),
  readOnly: true,
  unavailableCode: "passes_unavailable",
  run: Effect.fn("agentTools.listPasses")(
    (input: { readonly locale?: Locale }) =>
      requireAgentPassesOpen.pipe(
        Effect.andThen(CustomerPasses),
        Effect.flatMap((passes) => passes.list(getAgentToolLocale(input))),
        Effect.map(({ held }) => ({
          passes: held.map((pass) => {
            const common = {
              pass_id: pass.passId,
              tier: pass.tier,
              status: pass.status,
              valid_from: pass.validFrom,
              last_usable_date: pass.lastUsableDate,
            };
            return pass.kind === "entry-pack"
              ? { ...common, kind: pass.kind, entries_left: pass.entriesLeft }
              : { ...common, kind: pass.kind };
          }),
        })),
        Effect.mapError(AgentToolError.passesUnavailable)
      )
  ),
} as const;

const accessInput = Schema.Struct({
  pass_id: orderIdSchema.annotate({
    description: "The ID of the customer's Unlimited pass from list_passes.",
  }),
  locale: agentToolLocaleField,
});

const showPassAccess = {
  name: "show_pass_access",
  title: "Open a Deskohub Workspace Unlimited pass access page",
  description:
    "Returns the account-only access page for the customer's own Unlimited pass. Give the link to the customer to open while signed in on the website.",
  input: accessInput,
  output: Schema.Struct({ access_url: Schema.String }),
  readOnly: true,
  unavailableCode: "passes_unavailable",
  run: Effect.fn("agentTools.showPassAccess")(
    (input: typeof accessInput.Type) =>
      requireAgentPassesOpen.pipe(
        Effect.andThen(CustomerPasses),
        Effect.flatMap((passes) =>
          passes.accessPath(input.pass_id, getAgentToolLocale(input))
        ),
        Effect.bindTo("path"),
        Effect.bind("origin", () => getWorkspaceRuntimeCallbackOrigin),
        Effect.map(({ path, origin }) => {
          const url = new URL("/", origin);
          url.pathname = stripLocaleFromPathname(
            new URL(path, origin).pathname,
            locales
          );
          return { access_url: url.href };
        }),
        Effect.mapError(AgentToolError.passesUnavailable)
      )
  ),
} as const;

const purchaseInput = Schema.Struct({
  product: Schema.Union([
    entryPackProductSchema,
    Schema.Struct({
      kind: Schema.Literal("unlimited"),
      selection: unlimitedPassSelectionSchema,
    }),
  ]),
  locale: agentToolLocaleField,
});

const purchaseOutput = Schema.Union([
  Schema.Struct({ pay_url: Schema.String }),
  Schema.Struct({ status_url: Schema.String }),
]);

type PassPurchaseToolServices =
  | CoworkPassesReleaseGate
  | CurrentCustomerAccount
  | CustomerAuthentication
  | CustomerPasses;

const startPassPurchase = {
  name: "start_pass_purchase",
  title: "Start a Deskohub Workspace pass purchase",
  description:
    "Prepares the selected entry pack or Unlimited pass for the signed-in customer. Give the customer the pay_url. They finish any missing details, review the terms and start-date consent, and pay on the signed-in website.",
  input: purchaseInput,
  output: purchaseOutput,
  readOnly: false,
  accountBudget: { limit: 5, window: Duration.minutes(30) },
  unavailableCode: "passes_unavailable",
  run: Effect.fn("agentTools.startPassPurchase")(function* (
    input: typeof purchaseInput.Type
  ) {
    yield* requireAgentPassesOpen;
    const passes = yield* CustomerPasses;
    const purchase = yield* passes
      .startPurchase({
        orderId: orderIdSchema.make(crypto.randomUUID()),
        locale: getAgentToolLocale(input),
        product: input.product,
      })
      .pipe(Effect.provide(customerPassPurchaseLayers.agentStart));
    const origin = yield* getWorkspaceRuntimeCallbackOrigin;
    const url = new URL(purchase.checkoutPath, origin).href;
    return purchase.status === "status"
      ? { status_url: url }
      : { pay_url: url };
  }, Effect.mapError(AgentToolError.passesUnavailable)),
} as const;

export const listPassesTool = defineSignedInAgentTool({
  ...listPasses,
  scope: customerPassesAgentScope,
});
export const showPassAccessTool = defineSignedInAgentTool({
  ...showPassAccess,
  scope: customerPassesAgentScope,
});
export const startPassPurchaseTool = defineSignedInAgentTool<
  typeof purchaseInput,
  typeof purchaseOutput,
  PassPurchaseToolServices
>({
  ...startPassPurchase,
  scope: customerPassesAgentScope,
});

/** Only the same-origin browser MCP route publishes this catalog. */
export const browserPassTools = [
  defineAgentTool({ ...listPasses, access: "public" }),
  defineAgentTool({ ...showPassAccess, access: "public" }),
  defineAgentTool<
    typeof purchaseInput,
    typeof purchaseOutput,
    PassPurchaseToolServices
  >({ ...startPassPurchase, access: "public" }),
];
