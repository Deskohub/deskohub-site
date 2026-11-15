import type { Effect } from "effect";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import type {
  HeldReservationOrder,
  ReservationOrderSections,
  ReservationOrderSectionUnavailableError,
} from "./reservation-order-sections";
import type { WorkspaceAvailabilityService as OtherService } from "./workspace-availability.service";

declare const sections: ReservationOrderSections["Service"];
declare const orderId: WorkspaceReservationId;
declare const heldStep: Effect.Effect<void, never, HeldReservationOrder>;
declare const heldStepWithService: Effect.Effect<
  void,
  never,
  HeldReservationOrder | OtherService
>;

const typecheck = false as boolean;

if (typecheck) {
  const held: Effect.Effect<
    void,
    ReservationOrderSectionUnavailableError,
    never
  > = sections.withOrder(orderId, heldStep);
  const nested: Effect.Effect<
    void,
    ReservationOrderSectionUnavailableError,
    never
  > = sections.withOrder(orderId, sections.withOrder(orderId, heldStep));
  const keepsOtherRequirements: Effect.Effect<
    void,
    ReservationOrderSectionUnavailableError,
    OtherService
  > = sections.withOrder(orderId, heldStepWithService);

  // @ts-expect-error A held-only step cannot run outside a section.
  // @effect-diagnostics-next-line missingEffectContext:off
  const outside: Effect.Effect<void, never, never> = heldStep;

  // @ts-expect-error The section removes only HeldReservationOrder from the requirements.
  // @effect-diagnostics-next-line missingEffectContext:off
  const lost: Effect.Effect<
    void,
    ReservationOrderSectionUnavailableError,
    never
  > = sections.withOrder(orderId, heldStepWithService);

  void [held, nested, keepsOtherRequirements, outside, lost];
}
