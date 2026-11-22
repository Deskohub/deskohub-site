import "server-only";

import { EmailDocument, type EmailId } from "@deskohub/workspace-admin-api";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import {
  type WorkspaceDatabaseClient,
  WorkspaceTransaction,
} from "@/db/database.service";
import { type CampaignRow, emailCampaignSends } from "@/db/schema";
import { emails, emailVersions } from "@/db/schema/emails";
import { sampleEmailValues } from "@/features/emails/body";
import { renderEmailContent } from "@/features/emails/body/email-content";
import type { Locale } from "@/features/i18n";
import { currentInstant } from "@/shared/utils/temporal";
import { onceCampaignSend } from "./campaign-send-selection";

const decodePublishedDocument = Schema.decodeUnknownOption(EmailDocument);

export const sampleCampaignEmailContent = Effect.fn(
  "sampleCampaignEmailContent"
)(function* (document: EmailDocument, locale: Locale) {
  const now = yield* currentInstant;
  return yield* Effect.fromResult(
    renderEmailContent({
      document,
      locale,
      values: sampleEmailValues(document, locale, now),
    })
  );
});

/** Lists selectable publications without reading customer data. */
export const listCampaignEmailPublications = (db: WorkspaceDatabaseClient) =>
  db
    .selectDistinctOn([emails.id], {
      emailId: emails.id,
      title: emails.title,
      versionId: emailVersions.id,
      document: emailVersions.document,
    })
    .from(emails)
    .innerJoin(emailVersions, eq(emailVersions.emailId, emails.id))
    .where(isNull(emails.archivedAt))
    .orderBy(emails.id, desc(emailVersions.versionNumber))
    .pipe(
      Effect.map((rows) =>
        rows.flatMap((row) =>
          Option.match(decodePublishedDocument(row.document), {
            onNone: () => [],
            onSome: (document) =>
              document.purpose === "marketing" ? [{ ...row, document }] : [],
          })
        )
      )
    );

export const getCampaignEmailPublication = Effect.fn(
  "getCampaignEmailPublication"
)(function* (db: WorkspaceDatabaseClient, emailId: EmailId) {
  const [row] = yield* db
    .select({
      emailId: emails.id,
      title: emails.title,
      archivedAt: emails.archivedAt,
      versionId: emailVersions.id,
      document: emailVersions.document,
    })
    .from(emails)
    .innerJoin(emailVersions, eq(emailVersions.emailId, emails.id))
    .where(eq(emails.id, emailId))
    .orderBy(desc(emailVersions.versionNumber))
    .limit(1);
  if (!row || row.archivedAt !== null) return undefined;
  const document = decodePublishedDocument(row.document);
  if (Option.isNone(document) || document.value.purpose !== "marketing")
    return undefined;
  return { ...row, document: document.value };
});

/** Publication takes a write lock on the same logical email before inserting a version. */
export const lockCampaignEmailPublication = Effect.fn(
  "lockCampaignEmailPublication"
)(function* (emailId: EmailId) {
  const { db } = yield* WorkspaceTransaction;
  yield* db
    .select({ id: emails.id })
    .from(emails)
    .where(eq(emails.id, emailId))
    .for("share");
  return yield* getCampaignEmailPublication(db, emailId);
});

/** Drafts follow publications. A started send's preview uses its immutable version. */
export const getLinkedCampaignEmail = Effect.fn("getLinkedCampaignEmail")(
  function* (db: WorkspaceDatabaseClient, campaign: CampaignRow) {
    if (
      !campaign.emailId ||
      campaign.delivery !== "once" ||
      campaign.purpose !== "marketing"
    )
      return undefined;
    if (campaign.status === "draft")
      return yield* getCampaignEmailPublication(db, campaign.emailId);
    const [row] = yield* db
      .select({ document: emailVersions.document })
      .from(emailCampaignSends)
      .innerJoin(
        emailVersions,
        eq(emailVersions.id, emailCampaignSends.frozenEmailVersionId)
      )
      .where(
        and(
          onceCampaignSend(campaign.id),
          eq(emailVersions.emailId, campaign.emailId)
        )
      );
    if (!row) return undefined;
    const document = Option.getOrUndefined(
      decodePublishedDocument(row.document)
    );
    return document?.purpose === "marketing" &&
      document.templateKey === campaign.templateKey
      ? { document }
      : undefined;
  }
);
