"use server";

import {
  type AdministrationOperationError,
  type CampaignOperationName,
  type CampaignOperations as CampaignOperationRegistry,
  campaignOperations,
  type OperationInput,
  OperationInputInvalid,
  type OperationOutput,
} from "@deskohub/workspace-admin-api";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Effect, Match, Schema, Struct } from "effect";
import type {
  FlattenedValidationErrors,
  SafeActionResult,
  ValidationErrors,
} from "next-safe-action";
import {
  type AdministrationPath,
  administrationHref,
} from "@/features/administration/administration-href";
import { defineAdministrationAction } from "@/features/administrators/server/administration-request.server";
import { CampaignOperations } from "../backend/campaign-operations.service";
import { emailCampaignsActionFailureCopy } from "./campaign-operation-failure";
import { campaignOperationCapabilities } from "./campaign-operation-query.server";

const campaignOperationNames = Struct.keys(campaignOperations);

/**
 * Which operation to run, with its input as the client sent it. The port
 * decodes the input, so invalid input fails as it does for every adapter.
 */
const CampaignOperationRequest = Schema.Struct({
  operation: Schema.Literals(campaignOperationNames),
  input: Schema.Unknown,
});

export type CampaignOperationRequest<
  Name extends CampaignOperationName = CampaignOperationName,
> = {
  readonly operation: Name;
  readonly input: OperationInput<CampaignOperationRegistry[Name]>;
};

/**
 * An operation's output, or its failure as data: the category, the stable
 * `code` the admin UI localizes, and the English message as a fallback.
 */
export type CampaignOperationResult<
  Name extends CampaignOperationName = CampaignOperationName,
> =
  | {
      readonly _tag: "Success";
      readonly output: OperationOutput<CampaignOperationRegistry[Name]>;
    }
  | {
      readonly _tag: "Failure";
      readonly category: AdministrationOperationError["_tag"];
      readonly code: string;
      readonly message: string;
    };

export type CampaignOperationRequestSchema<
  Name extends CampaignOperationName = CampaignOperationName,
> = StandardSchemaV1<CampaignOperationRequest<Name>>;

export type CampaignOperationValidationErrors<
  Name extends CampaignOperationName = CampaignOperationName,
> = FlattenedValidationErrors<
  ValidationErrors<CampaignOperationRequestSchema<Name>>
>;

/**
 * What the client receives for one operation: the action envelope, whose
 * `data` is the operation's result.
 */
type CampaignOperationActionResult<Name extends CampaignOperationName> =
  SafeActionResult<
    string,
    CampaignOperationRequestSchema<Name>,
    CampaignOperationValidationErrors<Name>,
    CampaignOperationResult<Name>
  >;

const toFailure = (
  error: AdministrationOperationError
): CampaignOperationResult => ({
  _tag: "Failure",
  category: error._tag,
  code: error.code,
  message: error.message,
});

const administratorRequired: CampaignOperationResult = {
  _tag: "Failure",
  category: "OperationUnauthorized",
  code: "administrator-required",
  message: "Administrator authentication is required.",
};

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

/**
 * The input in its operation's encoded shape, which the port takes. Input
 * without that shape fails here as the port's strict decode would report it;
 * the port still re-checks the administrator grant and decodes every input
 * that has the shape, refinements included.
 */
const encodedInput = ({
  operation,
  input,
}: typeof CampaignOperationRequest.Type) =>
  Schema.decodeUnknownEffect(
    Schema.toEncoded(campaignOperations[operation].input)
  )(input, strictParseOptions).pipe(
    Effect.mapError(
      (cause) =>
        new OperationInputInvalid({
          code: "input-invalid",
          message: `The input is invalid: ${cause.message}`,
        })
    )
  );

/** Runs the operation through the port, with its failure as data. */
const operationResult = (request: typeof CampaignOperationRequest.Type) =>
  encodedInput(request).pipe(
    Effect.flatMap((input) =>
      CampaignOperations.pipe(
        Effect.flatMap((operations) =>
          operations.invoke(request.operation, input)
        )
      )
    ),
    Effect.match({
      onFailure: toFailure,
      onSuccess: (output): CampaignOperationResult => ({
        _tag: "Success",
        output,
      }),
    })
  );

/** An operation input about one campaign or one audience, as sent. */
const isCampaignInput = Schema.is(Schema.Struct({ campaignId: Schema.String }));
const isAudienceInput = Schema.is(Schema.Struct({ audienceId: Schema.String }));

/** Every page that lists or shows what a campaign mutation can change. */
const campaignPages = ({
  input,
}: typeof CampaignOperationRequest.Type): readonly AdministrationPath[] => [
  administrationHref("/[locale]/admin/email-campaigns"),
  administrationHref("/[locale]/admin/email-audiences"),
  ...Match.value(input).pipe(
    Match.when(isCampaignInput, ({ campaignId }) => [
      administrationHref("/[locale]/admin/email-campaigns/[campaignId]", {
        campaignId,
      }),
    ]),
    Match.when(isAudienceInput, ({ audienceId }) => [
      administrationHref("/[locale]/admin/email-audiences/[audienceId]", {
        audienceId,
      }),
    ]),
    Match.orElse(() => [])
  ),
];

const campaignOperationAction = defineAdministrationAction(
  {
    operation: "email-campaigns.admin.run-operation",
    schema: Schema.toStandardSchemaV1(CampaignOperationRequest, {
      parseOptions: { errors: "all", onExcessProperty: "error" },
    }),
    // Inputs can hold test recipients' addresses.
    logInput: false,
    failureCopy: emailCampaignsActionFailureCopy,
    capabilities: campaignOperationCapabilities,
    unauthorizedResult: administratorRequired,
    revalidates: (request, result) =>
      result._tag === "Success" &&
      campaignOperations[request.operation].kind === "mutation"
        ? campaignPages(request)
        : [],
  },
  operationResult
);

/**
 * Runs one campaign operation through the port for the signed-in
 * administrator. A mutation that succeeds revalidates the campaign pages.
 */
export async function runCampaignOperation<Name extends CampaignOperationName>(
  request: CampaignOperationRequest<Name>
): Promise<CampaignOperationActionResult<Name>> {
  "use server";
  const result = await campaignOperationAction(request);
  if (result.data === undefined) return result;
  return { ...result, data: operationResultOf(request.operation, result.data) };
}

/**
 * The result typed by its operation. The action answers for every operation
 * at once, so a success's output is checked against its own operation's
 * output schema; an output that fails it is a contract bug the client must
 * not trust, reported as the operation being unavailable.
 */
const operationResultOf = <Name extends CampaignOperationName>(
  operation: Name,
  result: CampaignOperationResult
): CampaignOperationResult<Name> => {
  if (result._tag === "Failure") return result;
  const { output } = result;
  return Schema.is(campaignOperations[operation].output)(output)
    ? { _tag: "Success", output }
    : {
        _tag: "Failure",
        category: "OperationUnavailable",
        code: "output-invalid",
        message: "The operation returned an output its schema rejects.",
      };
};
