import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/api/**/*.test.ts", "apps/worker/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "apps/web/**"],
    environment: "node",
    fileParallelism: false,
    pool: "forks",
  },
});
