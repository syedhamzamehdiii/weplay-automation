import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000
  },
  resolve: {
    alias: {
      "@weplay/types": path.resolve(__dirname, "packages/types/src/index.ts"),
      "@weplay/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
      "@weplay/config": path.resolve(__dirname, "packages/config/src/index.ts")
    }
  }
});
