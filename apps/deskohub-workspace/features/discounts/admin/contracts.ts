import {
  type AdministrationCustomerVoucherCreateInput,
  type AdministrationDiscountCodeUpdateInput,
  type AdministrationExistingDiscountCodeCreateInput,
  type AdministrationVoucherCreateInput,
  type AdministrationVoucherUpdateInput,
  makeAdministrationDiscountContracts,
} from "@deskohub/workspace-admin-api";
import { Schema } from "effect";
import {
  findWorkspaceProductTargetsIssue,
  workspaceProductTargetSchema,
} from "../product-target";

const {
  AdministrationDiscountDefinitionInput,
  AdministrationDiscountUpdateInput,
  AdministrationDiscountCodeCreateInput,
  AdministrationCustomerDiscountCodeCreateInput,
  AdministrationDiscountMutation,
} = makeAdministrationDiscountContracts(
  Schema.NonEmptyArray(workspaceProductTargetSchema).check(
    Schema.makeFilter(findWorkspaceProductTargetsIssue)
  )
);

export { AdministrationDiscountMutation as discountAdminMutationSchema };

export const discountAdminMutationStandardSchema = Schema.toStandardSchemaV1(
  AdministrationDiscountMutation,
  {
    parseOptions: {
      errors: "all",
      onExcessProperty: "error",
    },
  }
);

export type CreateDiscountAdminInput =
  typeof AdministrationDiscountDefinitionInput.Type;
export type UpdateDiscountAdminInput =
  typeof AdministrationDiscountUpdateInput.Type;
export type CreateDiscountCodeAdminInput =
  typeof AdministrationExistingDiscountCodeCreateInput.Type;
export type CreateManagedDiscountCodeAdminInput =
  typeof AdministrationDiscountCodeCreateInput.Type;
export type CreateCustomerDiscountCodeAdminInput =
  typeof AdministrationCustomerDiscountCodeCreateInput.Type;
export type UpdateDiscountCodeAdminInput =
  typeof AdministrationDiscountCodeUpdateInput.Type;
export type CreateVoucherAdminInput =
  typeof AdministrationVoucherCreateInput.Type;
export type CreateCustomerVoucherAdminInput =
  typeof AdministrationCustomerVoucherCreateInput.Type;
export type UpdateVoucherAdminInput =
  typeof AdministrationVoucherUpdateInput.Type;
export type DiscountAdminMutation = typeof AdministrationDiscountMutation.Type;
