const globalForMigrations = globalThis as typeof globalThis & {
  __backslashMigrationPromise?: Promise<void>;
};

async function resolveMigrationScriptPath(): Promise<string> {
  const [{ existsSync }, path] = await Promise.all([
    import("node:fs"),
    import("node:path"),
  ]);

  const candidates = [
    path.resolve(process.cwd(), "scripts/migrate.mjs"),
    path.resolve(process.cwd(), "apps/web/scripts/migrate.mjs"),
    path.resolve("/app/apps/web/scripts/migrate.mjs"),
  ];

  const scriptPath = candidates.find((candidate) => existsSync(candidate));
  if (!scriptPath) {
    throw new Error(
      `Migration script not found. Searched: ${candidates.join(", ")}`
    );
  }

  return scriptPath;
}

async function runMigrationsOnStartup(): Promise<void> {
  if (process.env.AUTO_DB_MIGRATE === "false") {
    console.log("[Instrumentation] AUTO_DB_MIGRATE=false, skipping startup migrations");
    return;
  }

  const [{ spawnSync }, scriptPath] = await Promise.all([
    import("node:child_process"),
    resolveMigrationScriptPath(),
  ]);

  console.log(`[Instrumentation] Running database migrations: ${scriptPath}`);

  const result = spawnSync(process.execPath, [scriptPath], {
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(`Migration script exited with status ${result.status}`);
  }
}

async function ensureDatabaseMigrations(): Promise<void> {
  if (!globalForMigrations.__backslashMigrationPromise) {
    globalForMigrations.__backslashMigrationPromise = runMigrationsOnStartup();
  }

  await globalForMigrations.__backslashMigrationPromise;
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      await ensureDatabaseMigrations();
      console.log("[Instrumentation] Database migration check completed");
    } catch (err) {
      console.error(
        "[Instrumentation] Failed to run startup migrations:",
        err instanceof Error ? err.message : err
      );
      throw err;
    }

    try {
      const { startCompileRunner } = await import("@/lib/compiler/runner");
      startCompileRunner();
      console.log("[Instrumentation] Compile runner started");
    } catch (err) {
      console.error(
        "[Instrumentation] Failed to start compile runner:",
        err instanceof Error ? err.message : err
      );
    }
  }
}
