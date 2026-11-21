import { Context, Layer } from "effect";
import {
  getCustomerPassBookingOptions,
  getCustomerReservationPassFunding,
  getCustomerUnlimitedAccess,
  getCustomerUnlimitedAccessPath,
  listCustomerPasses,
  listCustomerPassOffers,
} from "./customer-pass-reads";

interface ICustomerPasses {
  readonly catalog: typeof listCustomerPassOffers;
  readonly list: typeof listCustomerPasses;
  readonly options: typeof getCustomerPassBookingOptions;
  readonly todayCode: typeof getCustomerUnlimitedAccess;
  readonly accessPath: typeof getCustomerUnlimitedAccessPath;
  readonly reservationFunding: typeof getCustomerReservationPassFunding;
}

export class CustomerPasses extends Context.Service<
  CustomerPasses,
  ICustomerPasses
>()("@deskohub-workspace/passes/CustomerPasses") {
  static Default = Layer.succeed(this, {
    catalog: listCustomerPassOffers,
    list: listCustomerPasses,
    options: getCustomerPassBookingOptions,
    todayCode: getCustomerUnlimitedAccess,
    accessPath: getCustomerUnlimitedAccessPath,
    reservationFunding: getCustomerReservationPassFunding,
  });
}
