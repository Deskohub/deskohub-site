import ChevronRight from "lucide-react-native/icons/chevron-right";
import { Pressable, StyleSheet, View } from "react-native";
import { apiOrigin } from "../../auth/auth-client";
import { useAppLocale } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { PassProductMarks } from "../../passes/pass-product-marks";
import { openSitePage } from "../../routing/open-site-page";
import { sitePageUrl } from "../../routing/site-page";
import { Icon } from "../../ui/icon";
import { useIsPinnedCopy } from "../../ui/scroll-screen";
import { Text } from "../../ui/text";
import { useToast } from "../../ui/toast";
import { color, space } from "../../ui/tokens";
import { useViewport } from "../../ui/viewport";

/**
 * The Past group's last row (board 06): the two product marks and "Save
 * with packs and passes", opening the site's Pricing page in the in-app
 * browser. Past reservations hold no booking to carry there, so the page
 * opens unselected. At large text the label moves under the marks.
 */
export function PastSavingsFooter() {
  const locale = useAppLocale();
  const toast = useToast();
  const pinnedCopy = useIsPinnedCopy();
  const { fontScale } = useViewport();
  const stacked = fontScale >= 1.3;
  const label = m.reservations_save_with_passes({}, { locale });
  const open = () =>
    openSitePage(sitePageUrl("/pricing", apiOrigin, locale)).catch(() =>
      toast.show({
        message: m.reservations_pricing_open_failed({}, { locale }),
        tone: "neutral",
      })
    );
  return (
    <Pressable
      role="link"
      aria-label={label}
      // The pinned copy is drawn only; keyboard focus reaches the row in place.
      focusable={!pinnedCopy}
      onPress={open}
      style={({ pressed }) => [styles.footer, pressed && styles.pressed]}
    >
      <View style={stacked ? styles.stackedText : styles.inlineText}>
        <PassProductMarks />
        <Text variant="bodyStrong" tone="action" style={styles.label}>
          {label}
        </Text>
      </View>
      <Icon icon={ChevronRight} size={20} color={color.action} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  footer: {
    alignItems: "center",
    backgroundColor: color.paper,
    borderTopColor: color.line,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  pressed: { backgroundColor: color.sunken },
  inlineText: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 10,
    minWidth: 0,
  },
  stackedText: { alignItems: "flex-start", flex: 1, gap: 5, minWidth: 0 },
  label: { flexShrink: 1 },
});
