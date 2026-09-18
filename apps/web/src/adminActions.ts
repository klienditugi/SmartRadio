/** Copy for the admin approve control. REJECTED → APPROVED is an operator override. */

export type ApproveActionCopy = {
  label: string;
  title: string;
  confirm: string | null;
  isOverride: boolean;
};

export function approveActionCopy(status: string): ApproveActionCopy {
  if (status === "REJECTED") {
    return {
      label: "Override to APPROVED (skip reclassification)",
      title:
        "Explicit operator override: REJECTED → APPROVED. Does not re-run classification; uses the existing classification and continues the pipeline.",
      confirm:
        "Operator override: move this REJECTED request to APPROVED and skip reclassification. The existing classification is kept. Continue?",
      isOverride: true,
    };
  }
  return {
    label: "Approve",
    title: "Approve this request and continue the library/acquisition pipeline.",
    confirm: null,
    isOverride: false,
  };
}
