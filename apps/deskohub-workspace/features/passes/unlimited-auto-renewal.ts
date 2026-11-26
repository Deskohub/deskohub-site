import { Schema } from "effect";
import { positiveMoneyCodec } from "@/shared/money/money";
import { plainDateStringSchema } from "@/shared/utils/temporal";

export const unlimitedAutoRenewalAuthorizationSchema = Schema.Struct({
  amount: positiveMoneyCodec,
  nextRenewalOn: plainDateStringSchema,
  termsHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export type UnlimitedAutoRenewalAuthorization =
  typeof unlimitedAutoRenewalAuthorizationSchema.Type;

export type UnlimitedAutoRenewalDisclosure =
  UnlimitedAutoRenewalAuthorization & { readonly termsPath: string };
