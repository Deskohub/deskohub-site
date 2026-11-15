import { Effect, Order } from "effect";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { DotyposCustomerId } from "@/features/reservation/dotypos-customer";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { WorkspaceTransaction } from "./database.service";
import type { DatabaseQueryError } from "./sql-constraint";
import {
  holdSection,
  holdSections,
  type LockSection,
  type LockWait,
  type TransactionLockRequest,
  takeTransactionLock,
} from "./workspace-lock-ledger";

type TransactionLock = Effect.Effect<
  void,
  DatabaseQueryError,
  WorkspaceTransaction
>;

/** Reads the marker so every lock requires an open Workspace transaction. */
const take = (lock: TransactionLockRequest): TransactionLock =>
  Effect.andThen(WorkspaceTransaction, takeTransactionLock(lock));

const customerAccount = (accountId: CustomerAccountId): TransactionLock =>
  take({
    name: "customerAccount",
    rank: 20,
    pair: ["customer-account", accountId],
  });

/**
 * Advisory locks held until the current Workspace transaction ends. Take them
 * in ascending rank; equal ranks in ascending key. Each keeps its
 * pre-registry encoding exactly, so old and new code lock the same key during
 * a rollout.
 *
 * The reservation order mirror takes no advisory lock. Its triggers take row
 * locks only: the reservation row, then its order row, inside the
 * reservation's own statement. Payment attempt foreign key checks take
 * `KEY SHARE` on the order row, which never waits on the mirror.
 */
export const WorkspaceLocks = {
  referralGraph: (wait?: LockWait): TransactionLock =>
    take({
      name: "referralGraph",
      rank: 10,
      pair: ["referral-attribution", "graph"],
      wait,
    }),
  customerAccount,
  /** Every account, deduplicated, in ascending ID order. */
  customerAccounts: (
    accountIds: Iterable<CustomerAccountId>
  ): TransactionLock =>
    Effect.forEach(
      Array.from(new Set(accountIds)).sort(Order.String),
      customerAccount,
      { discard: true }
    ),
  /**
   * Serializes an account's analytics consent decisions, so a decision that
   * may only seed an empty ledger sees every decision recorded before it.
   */
  analyticsConsentLedger: (accountId: CustomerAccountId): TransactionLock =>
    take({
      name: "analyticsConsentLedger",
      rank: 25,
      pair: ["analytics-consent-ledger", accountId],
    }),
  referralFirstBooking: (customerId: DotyposCustomerId): TransactionLock =>
    take({
      name: "referralFirstBooking",
      rank: 30,
      pair: ["referral-first-booking", customerId],
    }),
  checkoutSession: (lockKey: bigint): TransactionLock =>
    take({ name: "checkoutSession", rank: 40, bigint: lockKey }),
  manualInvoiceCreation: (invoiceId: string): TransactionLock =>
    take({
      name: "manualInvoiceCreation",
      rank: 50,
      pair: ["manual-invoice-creation", invoiceId],
    }),
  manualInvoiceNewCustomer: (): TransactionLock =>
    take({
      name: "manualInvoiceNewCustomer",
      rank: 51,
      pair: ["manual-invoice-new-customer", "global"],
    }),
  /** A single `hashtext` key, sharing the one-bigint space with `checkoutSession`. */
  manualInvoiceIssue: (invoiceId: string): TransactionLock =>
    take({ name: "manualInvoiceIssue", rank: 52, hashed: invoiceId }),
  automationFireEntry: (campaignId: string): TransactionLock =>
    take({
      name: "automationFireEntry",
      rank: 60,
      pair: ["email-automation-fire-entry", campaignId],
    }),
  requestBudget: (policyKey: string): TransactionLock =>
    take({
      name: "requestBudget",
      rank: 70,
      pair: ["request-budget", policyKey],
    }),
  standaloneAccessCodeDevice: (deviceWindowKey: string): TransactionLock =>
    take({
      name: "standaloneAccessCodeDevice",
      rank: 80,
      pair: ["standalone-access-code", deviceWindowKey],
    }),
  legacyAdministrator: (legacyUsername: string): TransactionLock =>
    take({
      name: "legacyAdministrator",
      rank: 85,
      pair: ["legacy-administrator", legacyUsername],
    }),
  /** Always the transaction's last lock. */
  automationUnitSlots: (): TransactionLock =>
    take({
      name: "automationUnitSlots",
      rank: 90,
      pair: ["email-automation-unit-slots", "engine"],
    }),
} as const;

/**
 * The session-held sections' keys and ranks, one spec per section, so a
 * section's single entry (`WorkspaceLockSections`) and a combined entry of
 * several sections (`holdSections`) lock the same key.
 *
 * Sections are declared in nesting order: a section may be entered inside one
 * declared before it, never inside one declared after it. Their ranks share
 * `WorkspaceLocks`' scale and ascend in declaration order, which is what the
 * check compares; the same section nests in ascending key order.
 */
export const WorkspaceLockSectionSpecs = {
  signInEmail: (addressDigest: string): LockSection => ({
    name: "signInEmail",
    rank: 0,
    pair: ["sign-in-email", addressDigest],
  }),
  customerAccount: (accountId: CustomerAccountId): LockSection => ({
    name: "customerAccount",
    rank: 20,
    pair: ["customer-account", accountId],
  }),
  /**
   * One order's hold and payment start: preparing a payment retry, the
   * submission sequence from its progress check to the attempt, and late
   * payment recovery's hold work. A submission for a signed-in account holds
   * it together with the account's section in one combined entry.
   */
  reservationOrder: (orderId: WorkspaceReservationId): LockSection => ({
    name: "reservationOrder",
    rank: 21,
    pair: ["reservation-order", orderId],
  }),
} as const;

/** Holds several sections in one entry: one connection, one pool permit. */
export { holdSections };

/**
 * Session-held sections on a dedicated connection, for a lock held across
 * non-transactional work. They never provide `WorkspaceTransaction`; enter
 * them outside every Workspace transaction. Each entry takes one pool permit;
 * hold several sections together with `holdSections` and their
 * `WorkspaceLockSectionSpecs` rather than nesting them.
 */
export const WorkspaceLockSections = {
  signInEmail: (addressDigest: string) =>
    holdSection(WorkspaceLockSectionSpecs.signInEmail(addressDigest)),
  customerAccount: (accountId: CustomerAccountId) =>
    holdSection(WorkspaceLockSectionSpecs.customerAccount(accountId)),
  reservationOrder: (orderId: WorkspaceReservationId) =>
    holdSection(WorkspaceLockSectionSpecs.reservationOrder(orderId)),
} as const;
