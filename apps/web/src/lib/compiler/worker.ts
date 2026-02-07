import { Worker, type Job } from "bullmq";
import { eq, inArray } from "drizzle-orm";
import { LIMITS } from "@backslash/shared";
import IORedis from "ioredis";

import { db } from "@/lib/db";
import { builds } from "@/lib/db/schema";
import { getProjectDir, getPdfPath, fileExists } from "@/lib/storage";
import { type CompileJobData, type CompileJobResult, getRedisOptions } from "./queue";
import { runCompileContainer } from "./docker";
import { parseLatexLog } from "./logParser";
import { broadcastBuildUpdate } from "@/lib/websocket/server";

// ─── Configuration ─────────────────────────────────

const QUEUE_NAME = "compile";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const MAX_CONCURRENT_BUILDS = parseInt(
  process.env.MAX_CONCURRENT_BUILDS ||
    String(LIMITS.MAX_CONCURRENT_BUILDS_DEFAULT),
  10
);

const COMPILE_TIMEOUT_S = parseInt(
  process.env.COMPILE_TIMEOUT || String(LIMITS.COMPILE_TIMEOUT_DEFAULT),
  10
);
const LOCK_DURATION_MS = (COMPILE_TIMEOUT_S + 60) * 1000;

// ─── Global Singleton ──────────────────────────────

interface WorkerState {
  worker: Worker<CompileJobData, CompileJobResult>;
  watchdog: ReturnType<typeof setInterval>;
  monitorConn: IORedis;
}

const WORKER_KEY = "__backslash_compile_worker__" as const;

function getWorkerState(): WorkerState | null {
  return ((globalThis as unknown) as Record<string, WorkerState | undefined>)[WORKER_KEY] ?? null;
}

function setWorkerState(state: WorkerState | null): void {
  ((globalThis as unknown) as Record<string, WorkerState | null>)[WORKER_KEY] = state;
}

// ─── Stale Build Cleanup ───────────────────────────

async function cleanStaleBuildRecords(): Promise<void> {
  try {
    const stale = await db
      .update(builds)
      .set({
        status: "error",
        logs: "Build interrupted — server restarted. Please recompile.",
        completedAt: new Date(),
      })
      .where(inArray(builds.status, ["queued", "compiling"]))
      .returning({ id: builds.id });

    if (stale.length > 0) {
      console.log(`[Worker] Cleaned ${stale.length} stale build(s) from previous instance`);
    }
  } catch (err) {
    console.error("[Worker] Failed to clean stale builds:", err instanceof Error ? err.message : err);
  }
}

// ─── Worker Lifecycle ──────────────────────────────

/**
 * Creates and starts the BullMQ worker that processes compile jobs.
 *
 * CRITICAL: Connection options (plain object) are passed to BullMQ
 * instead of a pre-created ioredis instance. This lets BullMQ create
 * and manage its own connections internally, avoiding the
 * connection.duplicate() bug that kills the blocking connection
 * in Docker/cloud environments after the first job.
 */
export function startCompileWorker(): Worker<CompileJobData, CompileJobResult> {
  const existing = getWorkerState();
  if (existing) {
    if (!existing.worker.closing) {
      return existing.worker;
    }
    clearInterval(existing.watchdog);
    try { existing.monitorConn.disconnect(); } catch { /* ignore */ }
    setWorkerState(null);
  }

  // Clean stale builds from DB (fire-and-forget)
  cleanStaleBuildRecords();

  // Pass connection OPTIONS, not an ioredis instance.
  // BullMQ will create its own connections from these options.
  const worker = new Worker<CompileJobData, CompileJobResult>(
    QUEUE_NAME,
    async (job: Job<CompileJobData, CompileJobResult>) => {
      console.log(`[Worker] Processing job ${job.id} for project ${job.data.projectId}`);
      return processCompileJob(job);
    },
    {
      connection: getRedisOptions(),
      concurrency: MAX_CONCURRENT_BUILDS,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: 30_000,
      maxStalledCount: 2,
      drainDelay: 5,
    }
  );

  // ── Event Handlers ──────────────────────────────

  worker.on("ready", () => {
    console.log("[Worker] Connected to Redis and ready to process jobs");
  });

  worker.on("active", (job) => {
    console.log(`[Worker] Job ${job.id} active (project ${job.data.projectId})`);
  });

  worker.on("completed", (job) => {
    console.log(
      `[Worker] Job ${job.id} completed (project ${job.data.projectId}), ` +
      `workerRunning=${worker.isRunning()}`
    );
  });

  worker.on("failed", (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed (project ${job?.data.projectId}): ${err.message}`);
  });

  worker.on("error", (err) => {
    console.error("[Worker] Worker error:", err.message);
  });

  worker.on("stalled", (jobId) => {
    console.warn(`[Worker] Job ${jobId} stalled — will be retried`);
  });

  // ── Watchdog ────────────────────────────────────
  // Uses a SEPARATE ioredis connection to monitor the queue directly.
  // If jobs sit in the wait list for >60s with no active processing,
  // the worker's blocking connection is assumed dead and we recreate.

  const monitorConn = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    lazyConnect: false,
  });
  monitorConn.on("error", () => { /* suppress unhandled errors */ });

  let stuckTicks = 0;

  const watchdog = setInterval(async () => {
    try {
      if (worker.closing) {
        console.warn("[Watchdog] Worker is closing — recreating");
        clearInterval(watchdog);
        setWorkerState(null);
        try { monitorConn.disconnect(); } catch { /* ignore */ }
        setTimeout(() => startCompileWorker(), 2000);
        return;
      }

      // Check queue state via Redis directly
      const waitingCount = await monitorConn.llen(`bull:${QUEUE_NAME}:wait`);
      const activeCount = await monitorConn.llen(`bull:${QUEUE_NAME}:active`);

      if (waitingCount > 0 && activeCount === 0) {
        stuckTicks++;
        console.warn(
          `[Watchdog] ${waitingCount} waiting, ${activeCount} active, ` +
          `workerRunning=${worker.isRunning()} — stuck tick ${stuckTicks}/2`
        );

        if (stuckTicks >= 2) {
          // Jobs have been waiting for 60+ seconds with no processing
          console.error("[Watchdog] Jobs stuck in queue for >60s — force-recreating worker");
          clearInterval(watchdog);
          setWorkerState(null);
          try { await worker.close(); } catch { /* ignore */ }
          try { monitorConn.disconnect(); } catch { /* ignore */ }
          setTimeout(() => startCompileWorker(), 2000);
          return;
        }
      } else {
        if (stuckTicks > 0) {
          console.log(`[Watchdog] Queue healthy: ${waitingCount} waiting, ${activeCount} active`);
        }
        stuckTicks = 0;
      }
    } catch {
      // Ignore monitoring errors — don't crash the watchdog
    }
  }, 30_000);

  worker.waitUntilReady().then(() => {
    console.log("[Worker] Fully initialized and polling for jobs");
  }).catch((err) => {
    console.error("[Worker] Failed to initialize:", err.message);
  });

  setWorkerState({ worker, watchdog, monitorConn });

  console.log(
    `[Worker] Compile worker started (concurrency=${MAX_CONCURRENT_BUILDS}, ` +
    `lockDuration=${LOCK_DURATION_MS}ms, connectionMode=options)`
  );

  return worker;
}

// ─── Job Processing ────────────────────────────────

async function processCompileJob(
  job: Job<CompileJobData, CompileJobResult>
): Promise<CompileJobResult> {
  const { buildId, projectId, userId, engine, mainFile } = job.data;
  const startTime = Date.now();

  // ── Step 1: Mark as compiling ────────────────────
  await updateBuildStatus(buildId, "compiling");

  broadcastBuildUpdate(userId, {
    projectId,
    buildId,
    status: "compiling",
  });

  // ── Step 2: Resolve project directory ────────────
  const projectDir = getProjectDir(userId, projectId);

  // ── Step 3: Run the Docker container ─────────────
  let result: CompileJobResult;

  try {
    await job.updateProgress(10);

    const containerResult = await runCompileContainer({
      projectDir,
      mainFile,
    });

    console.log(`[Worker] Container finished for job ${job.id}, processing results...`);
    await job.updateProgress(90);

    const durationMs = Date.now() - startTime;
    const pdfOutputPath = getPdfPath(userId, projectId, mainFile);
    const pdfExists = await fileExists(pdfOutputPath);
    const parsedEntries = parseLatexLog(containerResult.logs);
    const hasErrors = parsedEntries.some((e) => e.type === "error");

    // Determine final status
    let finalStatus: "success" | "error" | "timeout";
    if (containerResult.timedOut) {
      finalStatus = "timeout";
    } else if (containerResult.exitCode !== 0 || hasErrors || !pdfExists) {
      finalStatus = "error";
    } else {
      finalStatus = "success";
    }

    // ── Step 4: Update database ──────────────────────
    await db
      .update(builds)
      .set({
        status: finalStatus,
        logs: containerResult.logs,
        durationMs,
        exitCode: containerResult.exitCode,
        pdfPath: pdfExists ? pdfOutputPath : null,
        completedAt: new Date(),
      })
      .where(eq(builds.id, buildId));

    // ── Step 5: Broadcast completion ─────────────────
    broadcastBuildUpdate(userId, {
      projectId,
      buildId,
      status: finalStatus,
      pdfUrl: pdfExists ? `/api/projects/${projectId}/pdf` : null,
      logs: containerResult.logs,
      durationMs,
      errors: parsedEntries.filter((e) => e.type === "error"),
    });

    result = {
      success: finalStatus === "success",
      exitCode: containerResult.exitCode,
      logs: containerResult.logs,
      pdfPath: pdfExists ? pdfOutputPath : null,
      durationMs,
    };

    await job.updateProgress(100);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage =
      err instanceof Error ? err.message : String(err);

    // Update the build as errored
    await updateBuildError(buildId, errorMessage, durationMs);

    // Broadcast the error
    broadcastBuildUpdate(userId, {
      projectId,
      buildId,
      status: "error",
      pdfUrl: null,
      logs: `Internal compilation error: ${errorMessage}`,
      durationMs,
      errors: [
        {
          type: "error",
          file: "system",
          line: 0,
          message: `Compilation infrastructure error: ${errorMessage}`,
        },
      ],
    });

    result = {
      success: false,
      exitCode: -1,
      logs: `Internal error: ${errorMessage}`,
      pdfPath: null,
      durationMs,
    };
  }

  return result;
}

// ─── Database Helpers ──────────────────────────────

async function updateBuildStatus(
  buildId: string,
  status: "queued" | "compiling"
): Promise<void> {
  await db
    .update(builds)
    .set({ status })
    .where(eq(builds.id, buildId));
}

async function updateBuildError(
  buildId: string,
  errorMessage: string,
  durationMs: number
): Promise<void> {
  await db
    .update(builds)
    .set({
      status: "error",
      logs: `Internal compilation error: ${errorMessage}`,
      durationMs,
      exitCode: -1,
      completedAt: new Date(),
    })
    .where(eq(builds.id, buildId));
}

// ─── Shutdown ──────────────────────────────────────

export async function shutdownWorker(): Promise<void> {
  const state = getWorkerState();
  if (state) {
    console.log("[Worker] Shutting down compile worker...");
    clearInterval(state.watchdog);
    await state.worker.close();
    try { state.monitorConn.disconnect(); } catch { /* ignore */ }
    setWorkerState(null);
    console.log("[Worker] Compile worker stopped");
  }
}
