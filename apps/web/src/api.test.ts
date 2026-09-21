import { describe, expect, it } from "vitest";
import { bytes } from "./api";

describe("bytes formatter", () => {
  it("renders human units", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(2048)).toBe("2 KB");
    expect(bytes(undefined)).toBe("—");
  });
});
