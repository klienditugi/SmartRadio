import { REQUEST_STATUSES, TERMINAL_STATUSES, isTerminalStatus } from "@subwave-ai/shared";
import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  REQUEST_TRANSITION_GRAPH,
  assertTransition,
  canTransition,
} from "./state-machine.js";

describe("request state machine", () => {
  it("covers the documented happy-path and reject branch", () => {
    expect(canTransition("RECEIVED", "CLASSIFYING")).toBe(true);
    expect(canTransition("CLASSIFYING", "REJECTED")).toBe(true);
    expect(canTransition("CLASSIFYING", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "CHECKING_LIBRARY")).toBe(true);
    expect(canTransition("CHECKING_LIBRARY", "ALREADY_AVAILABLE")).toBe(true);
    expect(canTransition("CHECKING_LIBRARY", "SEARCHING")).toBe(true);
    expect(canTransition("ALREADY_AVAILABLE", "QUEUED")).toBe(true);
    expect(canTransition("SEARCHING", "QUEUED")).toBe(true);
    expect(canTransition("QUEUED", "DOWNLOADING")).toBe(true);
    expect(canTransition("DOWNLOADING", "DOWNLOAD_COMPLETE")).toBe(true);
    expect(canTransition("DOWNLOAD_COMPLETE", "VALIDATING")).toBe(true);
    expect(canTransition("VALIDATING", "IMPORTING")).toBe(true);
    expect(canTransition("IMPORTING", "READY")).toBe(true);
    expect(canTransition("INDEXING", "READY")).toBe(true);
  });

  it("forbids skipping states and mutating READY/CANCELLED", () => {
    expect(canTransition("RECEIVED", "APPROVED")).toBe(false);
    expect(canTransition("CLASSIFYING", "READY")).toBe(false);
    expect(canTransition("READY", "CLASSIFYING")).toBe(false);
    expect(canTransition("CANCELLED", "RECEIVED")).toBe(false);
    expect(() => assertTransition("RECEIVED", "READY")).toThrow(IllegalTransitionError);
  });

  it("allows admin override and reclassify from REJECTED / CLASSIFYING", () => {
    expect(canTransition("REJECTED", "APPROVED")).toBe(true);
    expect(canTransition("REJECTED", "RECEIVED")).toBe(true);
    expect(canTransition("CLASSIFYING", "RECEIVED")).toBe(true);
    expect(canTransition("APPROVED", "REJECTED")).toBe(true);
    expect(canTransition("REJECTED", "FAILED")).toBe(false);
    expect(canTransition("REJECTED", "CANCELLED")).toBe(false);
  });

  it("allows FAILED and CANCELLED from every non-terminal status only", () => {
    for (const status of REQUEST_STATUSES) {
      if (status === "FAILED") {
        expect(canTransition(status, "RECEIVED")).toBe(true);
        expect(canTransition(status, "CANCELLED")).toBe(false);
        continue;
      }
      if (status === "REJECTED") {
        // Still cancel-terminal, but operators may reclassify or override.
        expect(canTransition(status, "FAILED")).toBe(false);
        expect(canTransition(status, "CANCELLED")).toBe(false);
        expect(canTransition(status, "RECEIVED")).toBe(true);
        expect(canTransition(status, "APPROVED")).toBe(true);
        continue;
      }
      if (isTerminalStatus(status)) {
        expect(canTransition(status, "FAILED")).toBe(false);
        expect(canTransition(status, "CANCELLED")).toBe(false);
        expect(REQUEST_TRANSITION_GRAPH[status]).toEqual([]);
      } else {
        expect(canTransition(status, "FAILED")).toBe(true);
        expect(canTransition(status, "CANCELLED")).toBe(true);
      }
    }
    expect(TERMINAL_STATUSES).toEqual(["REJECTED", "READY", "FAILED", "CANCELLED"]);
  });

  it("does not allow QUEUED to jump to IMPORTING (file flow is required)", () => {
    expect(canTransition("QUEUED", "IMPORTING")).toBe(false);
    expect(canTransition("QUEUED", "READY")).toBe(true);
  });

  it("keeps INDEXING for an explicit index_library job and not as the import happy path", () => {
    expect(canTransition("IMPORTING", "INDEXING")).toBe(true);
    expect(canTransition("IMPORTING", "READY")).toBe(true);
  });
});
