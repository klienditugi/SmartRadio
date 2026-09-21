import { updateProviderHealth } from "@subwave-ai/db";
import type { JobHandler } from "../context.js";

export const handleHealthProbe: JobHandler = async (ctx) => {
  const llm = await ctx.providers.llm.health();
  const library = await ctx.providers.library.health();
  const radio = await ctx.providers.radio.health();
  const acquisition = await ctx.providers.acquisition.health();
  updateProviderHealth(ctx.db, "llm-ollama", llm);
  updateProviderHealth(ctx.db, "library-navidrome", library);
  updateProviderHealth(ctx.db, "radio-subwave", radio);
  updateProviderHealth(ctx.db, "acquisition-slskd", acquisition);
  return { llm, library, radio, acquisition };
};
