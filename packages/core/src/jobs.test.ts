import { describe, expect, it } from "vitest";
import { jobTypeForStatus, restartStatusForJob } from "./jobs.js";

describe("job type mapping", () => {
  it("follows import with queue_radio and leaves index_library as an explicit ops job", () => {
    expect(jobTypeForStatus("IMPORTING")).toBe("queue_radio");
    expect(jobTypeForStatus("ALREADY_AVAILABLE")).toBe("queue_radio");
    expect(jobTypeForStatus("QUEUED")).toBe("download");
    expect(jobTypeForStatus("INDEXING")).toBeNull();
    expect(restartStatusForJob("index_library")).toBe("IMPORTING");
  });
});
