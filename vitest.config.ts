import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/api/types.ts",
        "src/vendor.d.ts",
        "src/util/logger.ts",
        "src/monitor/monitor.ts",
        "src/channel.ts",
        "src/auth/accounts.ts",
        "src/messaging/process-message.ts",
        "src/messaging/inbound.ts",
        // Integration / mock-backend tests are out of coverage by convention.
        "tests/**",
      ],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
