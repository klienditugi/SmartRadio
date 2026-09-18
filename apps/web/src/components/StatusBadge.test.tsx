import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("renders canonical request states", () => {
    render(<StatusBadge value="DOWNLOADING" />);
    expect(screen.getByText("DOWNLOADING")).toBeTruthy();
  });
});
