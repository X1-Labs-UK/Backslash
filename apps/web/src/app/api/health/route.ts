import { NextResponse } from "next/server";
import { getRedisConnection, getCompileQueue } from "@/lib/compiler/queue";
import { getDockerClient, healthCheck as dockerHealthCheck } from "@/lib/compiler/docker";

// ─── GET /api/health ────────────────────────────────
// Diagnostic endpoint — checks every component in the build pipeline.
// Call this after deploy to immediately see what's broken.

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // 1. Redis
  try {
    const redis = getRedisConnection();
    const pong = await redis.ping();
    checks.redis = { ok: pong === "PONG", detail: pong };
  } catch (err) {
    checks.redis = {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // 2. BullMQ Queue
  try {
    const queue = getCompileQueue();
    const waiting = await queue.getWaitingCount();
    const active = await queue.getActiveCount();
    const completed = await queue.getCompletedCount();
    const failed = await queue.getFailedCount();
    checks.bullmq = {
      ok: true,
      detail: `waiting=${waiting} active=${active} completed=${completed} failed=${failed}`,
    };
  } catch (err) {
    checks.bullmq = {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. Docker socket
  try {
    const dockerOk = await dockerHealthCheck();
    checks.docker_socket = { ok: dockerOk, detail: dockerOk ? "reachable" : "ping failed" };
  } catch (err) {
    checks.docker_socket = {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // 4. Compiler image
  try {
    const docker = getDockerClient();
    const compilerImage = process.env.COMPILER_IMAGE || "backslash-compiler";
    const images = await docker.listImages({
      filters: { reference: [compilerImage] },
    });
    checks.compiler_image = {
      ok: images.length > 0,
      detail: images.length > 0
        ? `found: ${images[0].RepoTags?.join(", ") || images[0].Id.slice(0, 12)}`
        : `image "${compilerImage}" not found — run compiler-image build first`,
    };
  } catch (err) {
    checks.compiler_image = {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // 5. Project volume
  try {
    const docker = getDockerClient();
    const volumeName = process.env.PROJECTS_VOLUME || "backslash-project-data";
    const volume = await docker.getVolume(volumeName).inspect();
    checks.project_volume = {
      ok: true,
      detail: `name=${volume.Name} driver=${volume.Driver}`,
    };
  } catch (err) {
    checks.project_volume = {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // 6. Storage path
  try {
    const fs = await import("fs/promises");
    const storagePath = process.env.STORAGE_PATH || "/data";
    const entries = await fs.readdir(storagePath);
    checks.storage_path = {
      ok: true,
      detail: `${storagePath} contains: ${entries.join(", ") || "(empty)"}`,
    };
  } catch (err) {
    checks.storage_path = {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const allOk = Object.values(checks).every((c) => c.ok);

  return NextResponse.json(
    { status: allOk ? "healthy" : "unhealthy", checks },
    { status: allOk ? 200 : 503 }
  );
}
