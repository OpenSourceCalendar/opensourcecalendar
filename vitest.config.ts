import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.toml" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, SETUP_TOKEN: "test-setup-token", MANAGE_SECRET: "test-manage-secret", SESSION_SECRET: "test-session-secret", OWNER_PASSWORD: "test-owner-password", GOOGLE_CLIENT_ID: "test-client-id", GOOGLE_CLIENT_SECRET: "test-client-secret", GOOGLE_TOKEN_KEY: "Sup-0NtMrEdeKvsoT-KgoFcaYvo7wQYpM5igPaPCaeY" } },
      }),
    ],
    // API tests make many requests each; the 5s default times out on slower machines.
    // One test file at a time: this dev machine has 2 CPUs and ~3 GB RAM, and parallel
    // workerd instances (plus another project's tests) froze it.
    test: { setupFiles: ["./test/setup.ts"], testTimeout: 30_000, maxWorkers: 1, fileParallelism: false },
  };
});
