import type { VerifyStatus } from "@subwave-ai/shared";
import { UnverifiedAdapterError } from "../http.js";
import type { ProviderHealth } from "../http.js";
import type { AcquisitionProvider } from "../types.js";

/** Any non-slskd Soulseek frontend. Does not call live endpoints. */
export class UnverifiedAcquisitionProvider implements AcquisitionProvider {
  readonly kind = "unverified" as const;
  readonly verifyStatus: VerifyStatus = "unverified";

  constructor(private readonly reason = "only slskd is a verified acquisition provider") {}

  private fail(): never {
    throw new UnverifiedAdapterError("acquisition", this.reason);
  }

  async search(_searchText?: string, _id?: string): Promise<unknown> {
    this.fail();
  }
  async enqueueDownload(_user?: string, _files?: unknown): Promise<unknown> {
    this.fail();
  }
  async listDownloads(): Promise<unknown> {
    this.fail();
  }
  async health(): Promise<ProviderHealth> {
    return {
      ok: false,
      verifyStatus: "unverified",
      detail: this.reason,
      checked_at: new Date().toISOString(),
    };
  }
}
