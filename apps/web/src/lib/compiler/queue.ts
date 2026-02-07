import { Queue, type JobsOptions } from "bullmq";
import type { Engine } from "@backslash/shared";

// ─── Redis Connection Options ─────────────────────
// CRITICAL: We parse the URL into a plain options object.
// BullMQ MUST receive options (not a pre-created ioredis instance)
// so it creates and manages its own Redis connections internally.
//
// When given a pre-created ioredis instance, BullMQ calls
// connection.duplicate() to create a blocking connection for
// BRPOPLPUSH. This duplicated connection silently dies in
// Docker/cloud environments after the first job completes,
// causing the worker to stop picking up new jobs.

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export function getRedisOptions(): Record<string, unknown> {
  const parsed = new URL(REDIS_URL);
  const opts: Record<string, unknown> = {
    host: parsed.hostname || "localhost",
    port: parseInt(parsed.port || "6379", 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    keepAlive: 10_000,
  };
  if (parsed.password) {
    opts.password = decodeURIComponent(parsed.password);
  }
  if (parsed.username && parsed.username !== "default") {
    opts.username = decodeURIComponent(parsed.username);
  }
  const dbStr = parsed.pathname?.slice(1);
  if (dbStr && dbStr.length > 0) {
    opts.db = parseInt(dbStr, 10);
  }
  if (parsed.protocol === "rediss:") {
    opts.tls = {};
  }
  return opts;
}

// ─── Job Types ─────────────────────────────────────

export interface CompileJobData {
  buildId: string;
  projectId: string;
  userId: string;
  engine: Engine;
  mainFile: string;
}

export interface CompileJobResult {
  success: boolean;
  exitCode: number;
  logs: string;
  pdfPath: string | null;
  durationMs: number;
}

// ─── Queue Setup ───────────────────────────────────

const QUEUE_NAME = "compile";
const QUEUE_KEY = "__backslash_compile_queue__" as const;

export function getCompileQueue(): Queue<CompileJobData, CompileJobResult> {
  let instance = ((globalThis as unknown) as Record<string, Queue<CompileJobData, CompileJobResult> | undefined>)[QUEUE_KEY];
  if (instance) {
    return instance;
  }

  instance = new Queue<CompileJobData, CompileJobResult>(
    QUEUE_NAME,
    {
      connection: getRedisOptions(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: {
          age: 3600,
          count: 200,
        },
        removeOnFail: {
          age: 86400,
          count: 500,
        },
      },
    }
  );

  ((globalThis as unknown) as Record<string, Queue<CompileJobData, CompileJobResult>>)[QUEUE_KEY] = instance;

  return instance;
}

// ─── Job Helpers ───────────────────────────────────

export async function addCompileJob(
  data: CompileJobData
): Promise<string | null> {
  const queue = getCompileQueue();

  const jobOptions: JobsOptions = {
    jobId: data.buildId,
  };

  console.log(`[Queue] Adding compile job ${data.buildId} for project ${data.projectId}`);
  const job = await queue.add("compile", data, jobOptions);
  console.log(`[Queue] Job added successfully: ${job?.id}`);

  return job?.id ?? null;
}

/**
 * Gracefully shuts down the compile queue.
 */
export async function shutdownQueue(): Promise<void> {
  const queue = ((globalThis as unknown) as Record<string, Queue | undefined>)[QUEUE_KEY];
  if (queue) {
    await queue.close();
    ((globalThis as unknown) as Record<string, Queue | null>)[QUEUE_KEY] = null;
  }
}
