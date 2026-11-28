import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import type { Locale } from "@/features/i18n";
import { getLegalDocument } from "./content";
import { getLegalDocumentVersion, hashLegalDocument } from "./document-version";
import type { LegalDocumentKey } from "./legal-document-summaries";

// Versions of the published documents. Stored consents and legal evidence
// record them, so a change here must come from an intended document change.
const publishedDocuments: ReadonlyArray<{
  readonly locale: Locale;
  readonly documentKey: LegalDocumentKey;
  readonly version: string;
}> = [
  {
    locale: "en-US",
    documentKey: "terms-and-conditions",
    version: "e62853f945ddd26fba13ce2741649a9c959869832bfd86599e1f221168db4834",
  },
  {
    locale: "en-US",
    documentKey: "operating-rules",
    version: "5f86f935f8d3f4d9bce7c5dc5fc966cf162a6da942a1ffcb0aeba5180d861cbf",
  },
  {
    locale: "en-US",
    documentKey: "privacy-policy",
    version: "7ca3873ddc2c9bd6977fb9aa3968098fffc64557c728b653b2ff029068bf4d92",
  },
  {
    locale: "en-US",
    documentKey: "marketing-communications",
    version: "3aa139f0b2a187e4d7bd7e488174b03c8e43b4a893d221b8527ed8e58db31653",
  },
  {
    locale: "en-US",
    documentKey: "cookie-policy",
    version: "2f705c21210f6fc44919ba388ddf4456abad86fa88dee41a25d87df7c0f42033",
  },
  {
    locale: "cs-CZ",
    documentKey: "terms-and-conditions",
    version: "963ca2e64cf125f6700e58d979bd7bee18e337d8dc3c74723f5db9c5ba217a77",
  },
  {
    locale: "cs-CZ",
    documentKey: "operating-rules",
    version: "020f57fb4244db86034bb0b56e583e5c618e885c4412ac1dbf6a8e3d31c6c199",
  },
  {
    locale: "cs-CZ",
    documentKey: "privacy-policy",
    version: "fbe427f73353085e6a227fae7031c61be1c99de52ecfe2a31dd0ec22d1fbddb8",
  },
  {
    locale: "cs-CZ",
    documentKey: "marketing-communications",
    version: "3bbaa65156c221b8bf97b74a93c11830fb4f73cbbcd5d144932c51d6b71b4cb7",
  },
  {
    locale: "cs-CZ",
    documentKey: "cookie-policy",
    version: "8aa600ff58b9d8d896dbe63f55b98774211ea53d031e8021815916b9b11957b6",
  },
  {
    locale: "de-DE",
    documentKey: "terms-and-conditions",
    version: "932badf0d2beaa99250cee007d0d387e797ffa2f3a5b8a1a189f04c198d74365",
  },
  {
    locale: "de-DE",
    documentKey: "operating-rules",
    version: "48906c68b945ca70b60185a736546ce136e6f5d28a297d55925bf320252d41ab",
  },
  {
    locale: "de-DE",
    documentKey: "privacy-policy",
    version: "210b477d135610028fc1684644d53adc27cbaf96613f6ecf1e47a5f4d826a204",
  },
  {
    locale: "de-DE",
    documentKey: "marketing-communications",
    version: "7682c568e3afca420f22c7476bfe1d14eab76fdd668e40f39ef1906c02a1bc77",
  },
  {
    locale: "de-DE",
    documentKey: "cookie-policy",
    version: "c1754e2cda352680810ee0826c73ad6149b37b3d9ce2d89b1c9f7ebef49b3934",
  },
  {
    locale: "uk-UA",
    documentKey: "terms-and-conditions",
    version: "749b159ecbf785020e3de2af1f3b96a130ef719f0fbc9d0b7a8292b04e24d893",
  },
  {
    locale: "uk-UA",
    documentKey: "operating-rules",
    version: "a7ad893c2a343f3cc8aeb5b6b995559ea8455066605354f6547fc544282a0c74",
  },
  {
    locale: "uk-UA",
    documentKey: "privacy-policy",
    version: "5b1da49fd89873cf665b7edf27a637b5280f118af6f6098ffca7591289259ca6",
  },
  {
    locale: "uk-UA",
    documentKey: "marketing-communications",
    version: "449dd97773156e2bcea5862a555c36aa61a1dd28965cf0c6ab567a148e8d82d4",
  },
  {
    locale: "uk-UA",
    documentKey: "cookie-policy",
    version: "46d2f95acd2e8de5cd0a4fc0bb62aea6ac9475357228f44d9b071194ced0ed5b",
  },
  {
    locale: "sk-SK",
    documentKey: "terms-and-conditions",
    version: "fdc4088c4644251872ae54b6663ef1e20b18b6f2efa08250a96f71a34d3cf4ae",
  },
  {
    locale: "sk-SK",
    documentKey: "operating-rules",
    version: "aca4257908aa40ca6aa5c5eed35458a1e157c8ac0197f1b637fd5013e70224da",
  },
  {
    locale: "sk-SK",
    documentKey: "privacy-policy",
    version: "f464b6cbc710bdd8836f2e24a2ff06e7a06d79b08b18b86610db9a7c3654f610",
  },
  {
    locale: "sk-SK",
    documentKey: "marketing-communications",
    version: "ec36404d497d59aa8eb93b6ae808ac7106098459aadee5450e8c92153696c1aa",
  },
  {
    locale: "sk-SK",
    documentKey: "cookie-policy",
    version: "39dd69f612391cf5f4a62a11de40e45270ce12dd3c59ab98e5811533bd3b561b",
  },
  {
    locale: "vi-VN",
    documentKey: "terms-and-conditions",
    version: "82e71e7dfe491bce3a382c828ed837534924653ffbb1d5ce2c9d5a418ae49080",
  },
  {
    locale: "vi-VN",
    documentKey: "operating-rules",
    version: "8bcdf0f34c29b578bf67e5e7485298a0b702e192be3667436709806dd9eddbe1",
  },
  {
    locale: "vi-VN",
    documentKey: "privacy-policy",
    version: "431ae005187d8f28439b3d0d61d994b20b599e91ad1634c92fa6833c673e9bb2",
  },
  {
    locale: "vi-VN",
    documentKey: "marketing-communications",
    version: "7a48ca1500301f44bc87fc89fa88b159386cc8e70ec04bf2374c9ea37c2adf44",
  },
  {
    locale: "vi-VN",
    documentKey: "cookie-policy",
    version: "45b40480e12b3e026438562a8263bfb64f5804a257c669e65ce9c85c59deef9e",
  },
  {
    locale: "hi-IN",
    documentKey: "terms-and-conditions",
    version: "621a8733caf6a6eeaddb3113524b02c3b399b503ba9c2c712a30ca6bad916d22",
  },
  {
    locale: "hi-IN",
    documentKey: "operating-rules",
    version: "7ac3b5ee911b9eeee34852fe739badce422bee7e9624a14737ee5d44f99ad483",
  },
  {
    locale: "hi-IN",
    documentKey: "privacy-policy",
    version: "890971196d692443d93fa70acd612bdf695a3a1d19960a795426865b2e2f8526",
  },
  {
    locale: "hi-IN",
    documentKey: "marketing-communications",
    version: "358888b8c2d137d0ecc28ff406e2267ec833f12f641e18c9380d9620f3ca0882",
  },
  {
    locale: "hi-IN",
    documentKey: "cookie-policy",
    version: "1a1525e0af085f8817a19e2108f592ae8213e6427676c1947a5c3002c9f0b9bb",
  },
];

describe("getLegalDocumentVersion", () => {
  test.each(publishedDocuments)(
    "versions $locale $documentKey by its content hash",
    ({ locale, documentKey, version }) => {
      expect(getLegalDocumentVersion(locale, documentKey)).toBe(version);
      expect(getLegalDocumentVersion(locale, documentKey)).toBe(version);
    }
  );
});

describe("hashLegalDocument", () => {
  test.each(publishedDocuments)(
    "hashes $locale $documentKey to its published version",
    ({ locale, documentKey, version }) => {
      expect(hashLegalDocument(getLegalDocument(locale, documentKey))).toBe(
        version
      );
    }
  );

  test("gives a changed document a new version", () => {
    const document = getLegalDocument("en-US", "marketing-communications");

    expect(
      hashLegalDocument({ ...document, updatedAt: `${document.updatedAt}.` })
    ).not.toBe(getLegalDocumentVersion("en-US", "marketing-communications"));
  });
});
