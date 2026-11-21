import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { Schema } from "effect";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { orderIdSchema } from "@/features/order";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { entryPackProductSchema } from "../pass-offer";
import { unlimitedPassSelectionSchema } from "../unlimited-pass";

export const passChangeRequestIdSchema = Schema.String.check(Schema.isUUID());

export const refundValueSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 2_147_483_647 })
);

export const passGrantSelectionSchema = Schema.Union([
  entryPackProductSchema,
  unlimitedPassSelectionSchema,
]);

export const passChangeSchema = Schema.TaggedUnion({
  grant: {
    holderAccountId: customerAccountIdSchema,
    selection: passGrantSelectionSchema,
  },
  validity: {
    expectedValidUntil: plainDateStringSchema,
    lastDay: plainDateStringSchema,
    refundValue: refundValueSchema,
  },
  cancel: {
    expectedValidUntil: plainDateStringSchema,
    refundValue: refundValueSchema,
    sendCancellationEmail: Schema.Boolean,
  },
  reassign: {
    expectedHolderAccountId: customerAccountIdSchema,
    expectedHolderVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    holderAccountId: customerAccountIdSchema,
    holderCustomerId: Schema.optionalKey(DotyposCustomerIdSchema),
  },
});

export type PassChange = Schema.Schema.Type<typeof passChangeSchema>;

export const passChangeRequestSchema = Schema.Struct({
  requestId: passChangeRequestIdSchema,
  passId: orderIdSchema,
  change: passChangeSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});

export type PassChangeRequest = Schema.Schema.Type<
  typeof passChangeRequestSchema
>;
