import { describe, expect, it } from "vitest";
import { defaultBridgeUrl } from "./bridgeUrl.ts";

describe("defaultBridgeUrl", () => {
  it("uses the editor origin over an unencrypted WebSocket", () => {
    expect(defaultBridgeUrl({ protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173/acp?agent=rad",
    );
  });

  it("upgrades HTTPS deployments to a secure WebSocket", () => {
    expect(defaultBridgeUrl({ protocol: "https:", host: "demo.example" })).toBe(
      "wss://demo.example/acp?agent=rad",
    );
  });
});
