/**
 * What a Client in a page does itself when an application asks its host
 * (src/host-direct.ts): the page's clipboard, notifications and windows. A page has no
 * keychain: a secret reads as absent, as from an empty one. `tabs.post` has no other tab
 * to reach here.
 */
import type { HostRequest } from "../../host";

async function notify(title: string, body: string | undefined) {
  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
  if (permission !== "granted") throw new Error("Notifications are not allowed for this page");
  new Notification(title, { body });
}

export function performDirectly(_origin: string) {
  return async (request: HostRequest): Promise<unknown> => {
    switch (request.type) {
      case "clipboard.read":
        return navigator.clipboard.readText();
      case "clipboard.write":
        await navigator.clipboard.writeText(request.text);
        return undefined;
      case "notify":
        await notify(request.title, request.body);
        return undefined;
      case "open-url":
        window.open(request.url, "_blank", "noopener,noreferrer");
        return undefined;
      case "secret":
      case "tabs.post":
        return undefined;
    }
  };
}
