export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Run database migrations on startup — creates tables if they don't exist
    try {
      const { migrate } = await import("drizzle-orm/postgres-js/migrator");
      const { db } = await import("@/lib/db");
      const path = await import("path");

      // In Docker the CWD is /app, migrations are at /app/apps/web/drizzle/migrations
      // In dev the CWD is apps/web, migrations are at ./drizzle/migrations
      const migrationsFolder = path.resolve(
        process.cwd(),
        process.env.NODE_ENV === "production"
          ? "apps/web/drizzle/migrations"
          : "drizzle/migrations"
      );

      await migrate(db, { migrationsFolder });
      console.log("[DB] Migrations applied successfully");
    } catch (error: any) {
      console.error("[DB] Migration failed:", error?.message || error);
      // Don't crash — the tables might already exist
    }

    // Start compile worker immediately — it only needs Redis, not the HTTP server
    const { startCompileWorker } = await import("@/lib/compiler/worker");
    startCompileWorker();
    console.log("[Instrumentation] Compile worker started");

    // Intercept http.createServer to attach Socket.IO (needs the HTTP server instance)
    const http = require("http") as typeof import("http");
    const origCreateServer = http.createServer;

    (http as any).createServer = function (this: any, ...args: any[]) {
      const server = (origCreateServer as Function).apply(this, args);

      // Restore immediately — only intercept the first call
      http.createServer = origCreateServer;

      // Attach Socket.IO to the HTTP server
      import("@/lib/websocket/server").then(({ initSocketServer }) => {
        initSocketServer(server);
      });

      return server;
    };
  }
}
