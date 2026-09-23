import { describe, expect, it } from "vitest";
import { interpretSlskdServer } from "./acquisition-probe.js";

describe("interpretSlskdServer", () => {
  it("requires both connected and logged-in flags before ready", () => {
    expect(interpretSlskdServer({ isConnected: true, isLoggedIn: true }).state).toBe("ready");
    expect(interpretSlskdServer({ isConnected: false, isLoggedIn: true }).state).toBe("soulseek_not_connected");
    expect(interpretSlskdServer({ isConnected: true, isLoggedIn: false }).state).toBe("soulseek_not_logged_in");
    expect(interpretSlskdServer({ IsConnected: true }).state).toBe("reachable");
    expect(interpretSlskdServer({}).state).toBe("reachable");
  });
});
