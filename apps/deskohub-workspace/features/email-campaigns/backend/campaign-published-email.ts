import "server-only";

import { EmailDocument, type EmailId } from "@deskohub/workspace-admin-api";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import {
  type WorkspaceDatabaseClient,
  WorkspaceTransaction,
} from "@/db/database.service";
import {
  type CampaignRow,
  emailCampaignSends,
  emailCampaigns,
} from "@/db/schema";
import { emails, emailVersions } from "@/db/schema/emails";
import { sampleEmailValues } from "@/features/emails/body";
import { renderEmailContent } from "@/features/emails/body/email-content";
import type { Locale } from "@/features/i18n";
import { currentInstant } from "@/shared/utils/temporal";
import type { CampaignId } from "../campaign-identifiers";

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

/** Drafts follow publications. Confirmed sends use their immutable version. */
export const getLinkedCampaignEmails = Effect.fn("getLinkedCampaignEmails")(
  function* (db: WorkspaceDatabaseClient, campaigns: readonly CampaignRow[]) {
    const documents = new Map<
      CampaignId,
      { readonly document: EmailDocument }
    >();
    const ids = campaigns
      .filter(({ emailId }) => emailId !== null)
      .map(({ id }) => id);
    if (ids.length === 0) return documents;

    const rows = yield* db
      .selectDistinctOn([emailCampaigns.id], {
        campaignId: emailCampaigns.id,
        status: emailCampaigns.status,
        templateKey: emailCampaigns.templateKey,
        document: emailVersions.document,
      })
      .from(emailCampaigns)
      .innerJoin(emails, eq(emails.id, emailCampaigns.emailId))
      .leftJoin(
        emailCampaignSends,
        and(
          eq(emailCampaignSends.campaignId, emailCampaigns.id),
          isNull(emailCampaignSends.automationVersionId)
        )
      )
      .innerJoin(
        emailVersions,
        and(
          eq(emailVersions.emailId, emails.id),
          or(
            and(eq(emailCampaigns.status, "draft"), isNull(emails.archivedAt)),
            and(
              ne(emailCampaigns.status, "draft"),
              eq(emailVersions.id, emailCampaignSends.frozenEmailVersionId)
            )
          )
        )
      )
      .where(
        and(
          inArray(emailCampaigns.id, ids),
          eq(emailCampaigns.delivery, "once"),
          eq(emailCampaigns.purpose, "marketing")
        )
      )
      .orderBy(emailCampaigns.id, desc(emailVersions.versionNumber));
    for (const row of rows) {
      const document = Option.getOrUndefined(
        decodePublishedDocument(row.document)
      );
      if (
        document?.purpose === "marketing" &&
        (row.status === "draft" || document.templateKey === row.templateKey)
      )
        documents.set(row.campaignId, { document });
    }
    return documents;
  }
);

export const getLinkedCampaignEmail = (
  db: WorkspaceDatabaseClient,
  campaign: CampaignRow
) =>
  getLinkedCampaignEmails(db, [campaign]).pipe(
    Effect.map((publications) => publications.get(campaign.id))
  );
