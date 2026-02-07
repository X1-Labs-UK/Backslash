import { db } from "@/lib/db";
import { projects, builds } from "@/lib/db/schema";
import { withAuth } from "@/lib/auth/middleware";
import { addCompileJob } from "@/lib/compiler/queue";
import { checkProjectAccess } from "@/lib/db/queries/projects";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";

// ─── POST /api/projects/[projectId]/compile ────────
// Trigger compilation for a project. Owner and editors can compile.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  return withAuth(request, async (_req, user) => {
    try {
      const { projectId } = await params;

      const access = await checkProjectAccess(user.id, projectId);
      if (!access.access || access.role === "viewer") {
        return NextResponse.json(
          { error: "Permission denied" },
          { status: 403 }
        );
      }

      const project = access.project;

      const buildId = uuidv4();

      // Create a build record with status "queued"
      await db.insert(builds).values({
        id: buildId,
        projectId,
        userId: user.id,
        status: "queued",
        engine: project.engine,
      });

      // Enqueue compile job
      await addCompileJob({
        buildId,
        projectId,
        userId: user.id,
        engine: project.engine,
        mainFile: project.mainFile,
      });

      return NextResponse.json(
        {
          buildId,
          status: "queued",
          message: "Compilation queued",
        },
        { status: 202 }
      );
    } catch (error) {
      console.error("Error triggering compilation:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
