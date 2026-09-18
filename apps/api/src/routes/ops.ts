import type { FastifyInstance } from "fastify";
import {
  countJobsByStatus,
  countRequestsByStatus,
  listAcquisitionItems,
  listJobs,
  listJobsWithErrors,
  listLlmCalls,
  listProviders,
  listRecentRequestEvents,
  listRequests,
} from "@subwave-ai/db";
import { REQUEST_STATUSES } from "@subwave-ai/shared";
import { doctorReport } from "../context.js";
import { diskReport } from "../disk.js";
import { requireAdmin, requireUser } from "./auth.js";

export async function registerOpsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ops/disk", { schema: { tags: ["ops"] }, preHandler: requireUser }, async () => {
    return diskReport(app.config);
  });

  app.get("/ops/logs", { schema: { tags: ["ops"] }, preHandler: requireAdmin }, async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 80));
    const events = listRecentRequestEvents(app.db, limit);
    const jobs = listJobsWithErrors(app.db, limit);
    const llm = listLlmCalls(app.db, { limit, errorsOnly: true }).map((row) => ({
      ...row,
      prompt: row.prompt.length > 280 ? `${row.prompt.slice(0, 280)}…` : row.prompt,
    }));
    const acquisitions = listAcquisitionItems(app.db, undefined, limit);
    return { events, jobs, llm_calls: llm, acquisitions };
  });

  app.get("/ops/overview", { schema: { tags: ["ops"] }, preHandler: requireUser }, async () => {
    const requests_by_status = countRequestsByStatus(app.db);
    for (const status of REQUEST_STATUSES) {
      if (requests_by_status[status] === undefined) requests_by_status[status] = 0;
    }
    return {
      requests_by_status,
      jobs_by_status: countJobsByStatus(app.db),
      recent_requests: listRequests(app.db, 15),
      recent_jobs: listJobs(app.db, 15),
      providers: listProviders(app.db),
      disk: diskReport(app.config),
      doctor: doctorReport(app.db, app.config),
    };
  });
}
