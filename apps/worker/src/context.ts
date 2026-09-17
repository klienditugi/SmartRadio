import type { RuntimeConfig } from "@subwave-ai/shared";
import type { Db, JobRow } from "@subwave-ai/db";
import type { ProviderBundle } from "@subwave-ai/providers";

export type WorkerContext = {
  db: Db;
  config: RuntimeConfig;
  providers: ProviderBundle;
  workerId: string;
};

export type JobHandler = (ctx: WorkerContext, job: JobRow) => Promise<unknown>;
