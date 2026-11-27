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
    version: "dc2faf8fc56123b6349d4acea6f59a94f45f71359e54962ce7eb9ec5e9acc08d",
  },
  {
    locale: "en-US",
    documentKey: "operating-rules",
    version: "05cefdd98d32159cfce228b230931f9cc257643d90f83f327589732476c8ba56",
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
    version: "c35d2e277087351dd91bfea0c7fa450d5701e7d539d25492043a22f626787ab2",
  },
  {
    locale: "cs-CZ",
    documentKey: "operating-rules",
    version: "72c29525579c9f6bf1628e409da40b9bd6f620acfa9f2623198f7bbc73f4df77",
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
    version: "50deab5ed985d25c564cd2e2b8e190d63c93fce9c2d8e7df792bca32c9ecf5f8",
  },
  {
    locale: "de-DE",
    documentKey: "operating-rules",
    version: "c62cfb615edfabaa1b46c687d360da01b0f84642e5870b80a79bbef152ec5b3c",
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
    version: "ddd55fcceba2162bcd4afdced6d52611feb59836fdadfc01efa7e8e08fc35476",
  },
  {
    locale: "uk-UA",
    documentKey: "operating-rules",
    version: "3b2c23e4556ddab5fb207e6ba78163c9d784def6d4c4cedf61362db353729687",
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
    version: "1b91182101f690b7654a9a1bc6a203e458c44e1d92c8a43e7e360ea9ec78475f",
  },
  {
    locale: "sk-SK",
    documentKey: "operating-rules",
    version: "4bff1537e7e6a7903fecf5584178b37f52c9ef2d66076b4f2e55b057ca651852",
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
    version: "6d4806c814cc61879a0f14f5596619897eb437215d023b3d8515ec3cac5e4841",
  },
  {
    locale: "vi-VN",
    documentKey: "operating-rules",
    version: "2bfa7e9a4afa15bcea55db7daa0737e64c79f395606737bd76bd64f0a740784f",
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
    version: "a27c6478426893a67ca5c854a01bd2555ae792a6b048b29274b47822d00a2bf0",
  },
  {
    locale: "hi-IN",
    documentKey: "operating-rules",
    version: "635da5bf566a299b094ae7f8fc86235f9f551361b10d505e0d27f021ea7fbd31",
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
