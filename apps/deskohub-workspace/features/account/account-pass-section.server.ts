import "server-only";

import { cache } from "react";
import { loadCustomerAccountPasses } from "@/features/account/account-passes.server";
import { loadCustomerAccountUnlimitedPasses } from "@/features/account/account-unlimited-passes.server";
import { loadCustomerAccountPage } from "@/features/account/page-data.server";
import type { Locale } from "@/features/i18n";

export const loadAccountPassSection = cache(
  async (locale: Locale, purchasesEnabled: boolean) => {
    const loadPasses = () => loadCustomerAccountPasses(locale);
    if (purchasesEnabled) {
      return {
        loadPasses,
        unlimitedPasses: await loadCustomerAccountUnlimitedPasses(locale),
      };
    }

    const state = await loadCustomerAccountPage();
    if (
      state.kind === "unauthenticated" ||
      state.kind === "unavailable" ||
      state.kind === "deletion-pending"
    ) {
      return { unlimitedPasses: [] };
    }

    const [packs, unlimitedPasses] = await Promise.all([
      loadPasses(),
      loadCustomerAccountUnlimitedPasses(locale),
    ]);
    if (
      unlimitedPasses === "unavailable" ||
      unlimitedPasses.length > 0 ||
      packs === "unavailable" ||
      packs.held.length > 0 ||
      packs.boughtForOthers.length > 0
    ) {
      return { loadPasses, unlimitedPasses };
    }
    return { unlimitedPasses };
  }
);
