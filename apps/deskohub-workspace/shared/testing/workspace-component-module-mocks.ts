import { mock } from "bun:test";
import type { useWorkspaceAction } from "@/shared/utils/use-workspace-action";

export const workspaceRouterPush = mock((_href: string) => undefined);
export const workspaceRouterRefresh = mock(() => undefined);
export const workspaceRouterReplace = mock((_href: string) => undefined);
const workspaceUsePathname = mock(() => "/en-US/account");
export const workspaceUseSearchParams = mock(() => new URLSearchParams());
const workspaceUseFeatureFlagEnabled = mock(
  (_flag: string, _initialEnabled: boolean): boolean | undefined => undefined
);
const workspaceApplyFeatureFlagOverrides = mock(
  <PostHog, Overrides>(_posthog: PostHog, _overrides: Overrides) => undefined
);
const workspaceUseFeatureFlagPayload = mock(
  (_flag: string): unknown => undefined
);
const workspaceUseFeatureFlagResult = mock(
  (_flag: string): unknown => undefined
);
const workspaceUseFeatureFlagVariantKey = mock(
  (_flag: string): unknown => undefined
);
/**
 * `useWorkspaceAction` as a test double sees it: any action and options, with
 * an implementation that returns only the hook fields the component reads.
 * Without an implementation it returns `undefined`, as the default does.
 */
type WorkspaceActionHook = (
  ...args: Parameters<typeof useWorkspaceAction>
) => Partial<ReturnType<typeof useWorkspaceAction>> | undefined;

export const workspaceUseAction = mock<WorkspaceActionHook>();

const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...navigation,
  usePathname: workspaceUsePathname,
  useRouter: () => ({
    push: workspaceRouterPush,
    refresh: workspaceRouterRefresh,
    replace: workspaceRouterReplace,
  }),
  useSearchParams: workspaceUseSearchParams,
  unstable_rethrow: (cause: unknown) => {
    throw cause;
  },
}));

mock.module("@/features/feature-flags/react", () => ({
  applyFeatureFlagOverrides: workspaceApplyFeatureFlagOverrides,
  useFeatureFlagEnabled: workspaceUseFeatureFlagEnabled,
  useFeatureFlagPayload: workspaceUseFeatureFlagPayload,
  useFeatureFlagResult: workspaceUseFeatureFlagResult,
  useFeatureFlagVariantKey: workspaceUseFeatureFlagVariantKey,
}));

mock.module("@/shared/utils/use-workspace-action", () => ({
  useWorkspaceAction: workspaceUseAction,
}));
