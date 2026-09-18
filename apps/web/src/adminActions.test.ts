import { describe, expect, it } from "vitest";
import { approveActionCopy } from "./adminActions";

describe("approveActionCopy", () => {
  it("labels REJECTED → APPROVED as an explicit override that skips reclassification", () => {
    const copy = approveActionCopy("REJECTED");
    expect(copy.isOverride).toBe(true);
    expect(copy.label).toMatch(/override/i);
    expect(copy.label).toMatch(/skip reclassification/i);
    expect(copy.title).toMatch(/does not re-run classification/i);
    expect(copy.confirm).toMatch(/skip reclassification/i);
  });

  it("keeps a plain Approve label for other states", () => {
    const copy = approveActionCopy("CLASSIFYING");
    expect(copy.isOverride).toBe(false);
    expect(copy.label).toBe("Approve");
    expect(copy.confirm).toBeNull();
  });
});
