import {
  type WorkspaceE2EAccountJournalOwner,
  workspaceE2EAccountLaneJournalOwner,
} from "../account/reconcile";
import { workspaceE2EAdministrationJournalOwners } from "../administrators/identities";
import { agentBookingJournalOwner } from "../cases/agent-booking";
import { referralSomeoneElsePaymentJournalOwner } from "../cases/referral-someone-else-payment";
import { signedOutVerificationJournalOwner } from "../cases/signed-out-verification";
import { workspaceE2ECheckoutBookerJournalOwners } from "../checkout/booker";
import { workspaceE2EReferralJournalOwners } from "../referrals/journal-owners";
import {
  unlimitedPassAutoRenewalCaseId,
  unlimitedPassAutoRenewalRecipientLabel,
} from "./case-catalog";

export const unlimitedPassAutoRenewalJournalOwner: WorkspaceE2EAccountJournalOwner =
  {
    ownerId: unlimitedPassAutoRenewalCaseId,
    recipientLabels: [unlimitedPassAutoRenewalRecipientLabel],
  };

export const workspaceE2ECheckoutJournalOwners = [
  workspaceE2EAccountLaneJournalOwner,
  ...workspaceE2EReferralJournalOwners,
  referralSomeoneElsePaymentJournalOwner,
  signedOutVerificationJournalOwner,
  agentBookingJournalOwner,
  unlimitedPassAutoRenewalJournalOwner,
  ...workspaceE2ECheckoutBookerJournalOwners,
  ...workspaceE2EAdministrationJournalOwners,
];
