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
    version: "803f7af249ee0d80db0d5db25eeb346bff0e4a761d808bd2123eb4a12ca955ae",
  },
  {
    locale: "en-US",
    documentKey: "operating-rules",
    version: "5f86f935f8d3f4d9bce7c5dc5fc966cf162a6da942a1ffcb0aeba5180d861cbf",
  },
  {
    locale: "en-US",
    documentKey: "privacy-policy",
    version: "3f36b29f196c659d2672472007e43f35dc08ff0b16a1ff09af1a50326c4dd3f8",
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
    version: "c94d0f3b689eda41ee42dd2690a8d9a31be132670bd2cf9796779015727e969e",
  },
  {
    locale: "cs-CZ",
    documentKey: "operating-rules",
    version: "020f57fb4244db86034bb0b56e583e5c618e885c4412ac1dbf6a8e3d31c6c199",
  },
  {
    locale: "cs-CZ",
    documentKey: "privacy-policy",
    version: "06ef7eccee6ae782d255f20318a23487b3a6919d9abf6da1310aa0c4355ffaba",
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
    version: "763c562394ddc27591ae4833ec90a5bb778ead01913149014212aa9a09c7330d",
  },
  {
    locale: "de-DE",
    documentKey: "operating-rules",
    version: "48906c68b945ca70b60185a736546ce136e6f5d28a297d55925bf320252d41ab",
  },
  {
    locale: "de-DE",
    documentKey: "privacy-policy",
    version: "12971bc012fa60f835e50ebfa162649dd15138ab5cdcb75f90c9f6cc0e439fb5",
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
    version: "59f7a3533003fb485b67476931943ccef5f56eb20610e7c18f8944a89d98fc10",
  },
  {
    locale: "uk-UA",
    documentKey: "operating-rules",
    version: "a7ad893c2a343f3cc8aeb5b6b995559ea8455066605354f6547fc544282a0c74",
  },
  {
    locale: "uk-UA",
    documentKey: "privacy-policy",
    version: "5e2fb2f96c5600e33892e1a8d6b348fab61fcfc94c552529c2ab19466c6c932e",
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
    version: "09cef9958abba81c63c1d108167f53367a48643f2e3e0586946db90e9213f92a",
  },
  {
    locale: "sk-SK",
    documentKey: "operating-rules",
    version: "aca4257908aa40ca6aa5c5eed35458a1e157c8ac0197f1b637fd5013e70224da",
  },
  {
    locale: "sk-SK",
    documentKey: "privacy-policy",
    version: "b5f247ecb4e7311ee0847aaf5f141310cd1ff37a34b87e2ca6fc792b7d8f32a3",
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
    version: "b7a3cb6e21226e74087ace7ce1f07f72b305a04e41872dc175ffb5135d6abe0b",
  },
  {
    locale: "vi-VN",
    documentKey: "operating-rules",
    version: "8bcdf0f34c29b578bf67e5e7485298a0b702e192be3667436709806dd9eddbe1",
  },
  {
    locale: "vi-VN",
    documentKey: "privacy-policy",
    version: "b2a920b3aeca14d6321ef1bfa0f762076ccf365bb483664a19f8f26c753912fc",
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
    version: "8345a4d40d3bcc975e7b93aa1ad6be330ea3902171dbc770e1ebd77b44099226",
  },
  {
    locale: "hi-IN",
    documentKey: "operating-rules",
    version: "7ac3b5ee911b9eeee34852fe739badce422bee7e9624a14737ee5d44f99ad483",
  },
  {
    locale: "hi-IN",
    documentKey: "privacy-policy",
    version: "feeaa3947ca6aeca453a0c49ff09cff76c7d48fd381b5521ac3d51fa65614330",
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
