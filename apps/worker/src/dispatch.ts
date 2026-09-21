import { claimJob, completeJob, type JobRow } from "@subwave-ai/db";
import type { JobType } from "@subwave-ai/shared";
import type { JobHandler, WorkerContext } from "./context.js";
import { handleClassify } from "./processors/classify.js";
import { handleCheckLibrary } from "./processors/library.js";
import { handleDownload, handleSearchAcquisition } from "./processors/acquire.js";
import {
  handleImportLibrary,
  handleIndexLibrary,
  handleQueueRadio,
  handleRefreshPlaylist,
  handleValidateFile,
} from "./processors/files.js";
import { handleHealthProbe } from "./processors/health.js";

const HANDLERS: Record<JobType, JobHandler> = {
  classify: handleClassify,
  check_library: handleCheckLibrary,
  search_acquisition: handleSearchAcquisition,
  download: handleDownload,
  validate_file: handleValidateFile,
  import_library: handleImportLibrary,
  index_library: handleIndexLibrary,
  queue_radio: handleQueueRadio,
  health_probe: handleHealthProbe,
  refresh_playlist: handleRefreshPlaylist,
};

export async function processJob(ctx: WorkerContext, job: JobRow): Promise<void> {
  const handler = HANDLERS[job.type];
  if (!handler) {
    completeJob(ctx.db, { jobId: job.id, success: false, error: `unknown job type ${job.type}` });
    return;
  }
  try {
    const result = await handler(ctx, job);
    completeJob(ctx.db, { jobId: job.id, success: true, result });
  } catch (err) {
    completeJob(ctx.db, { jobId: job.id, success: false, error: (err as Error).message });
  }
}

export async function claimAndRun(ctx: WorkerContext): Promise<boolean> {
  const job = claimJob(ctx.db, ctx.workerId, ctx.config.worker.lease_ms);
  if (!job) return false;
  await processJob(ctx, job);
  return true;
}
