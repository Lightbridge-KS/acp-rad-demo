type BrowserLocation = Pick<Location, "host" | "protocol">;

/** Resolve the bridge on the editor's origin so one reverse proxy can serve both peers. */
export function defaultBridgeUrl(location: BrowserLocation): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/acp?agent=rad`;
}
