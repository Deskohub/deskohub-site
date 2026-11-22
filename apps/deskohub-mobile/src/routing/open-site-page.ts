import {
  openBrowserAsync,
  type WebBrowserResult,
  type WebBrowserResultType,
} from "expo-web-browser";
import { Platform } from "react-native";
import { color } from "../ui/tokens";

/**
 * The in-app browser tab coloured like the app: the paper canvas with navy
 * controls. Site pages and the payment page open in it.
 */
export const appBrowserTabColors = {
  toolbarColor: color.paper,
  controlsColor: color.navy,
  secondaryToolbarColor: color.paper,
} as const;

/**
 * Opens a site page in the in-app browser tab, coloured like the app, with
 * the page's title above its host in the toolbar (board 16b); on the web, in
 * a new tab. It fails where no browser is available or the browser blocks
 * the tab.
 */
export const openSitePage = async (url: string): Promise<WebBrowserResult> => {
  if (Platform.OS !== "web")
    return openBrowserAsync(url, { ...appBrowserTabColors, showTitle: true });
  // A new tab. Expo's web opener reports it opened even when the browser
  // blocked it, so the caller's failure handling would never run.
  const page = window.open(url, "_blank");
  if (page === null) throw new Error("The browser blocked the page.");
  page.opener = null;
  return { type: "opened" as WebBrowserResultType.OPENED };
};
