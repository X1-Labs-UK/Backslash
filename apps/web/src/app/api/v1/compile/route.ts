import { withApiKey } from "@/lib/auth/apikey";
import { runCompileContainer } from "@/lib/compiler/docker";
import { parseLatexLog } from "@/lib/compiler/logParser";
import * as storage from "@/lib/storage";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";

const compileSchema = z.object({
  source: z.string().min(1, "LaTeX source is required").max(5 * 1024 * 1024, "Source too large (max 5MB)"),
  engine: z.enum(["pdflatex", "xelatex", "lualatex", "latex"]).optional().default("pdflatex"),
});

// ─── POST /api/v1/compile ───────────────────────────
// One-shot compile: send LaTeX source, receive PDF.
// No project creation needed — ephemeral compilation.

export async function POST(request: NextRequest) {
  return withApiKey(request, async (req, user) => {
    try {
      const body = await req.json();
      const parsed = compileSchema.safeParse(body);

      if (!parsed.success) {
        return NextResponse.json(
          {
            error: "Validation failed",
            details: parsed.error.flatten().fieldErrors,
          },
          { status: 400 }
        );
      }

      const { source, engine } = parsed.data;
      const jobId = uuidv4();

      // Create a temporary directory for this compilation
      const STORAGE_PATH = process.env.STORAGE_PATH || "/data";
      const tmpDir = path.join(STORAGE_PATH, "tmp", jobId);
      await fs.mkdir(tmpDir, { recursive: true });

      try {
        // Write the source to main.tex
        await fs.writeFile(path.join(tmpDir, "main.tex"), source, "utf-8");

        const startTime = Date.now();

        // Run the compilation
        const result = await runCompileContainer({
          projectDir: tmpDir,
          mainFile: "main.tex",
        });

        const durationMs = Date.now() - startTime;
        const errors = parseLatexLog(result.logs);

        // Check if PDF was generated
        const pdfPath = path.join(tmpDir, "main.pdf");
        let pdfBase64: string | null = null;

        try {
          const pdfBuffer = await fs.readFile(pdfPath);
          pdfBase64 = pdfBuffer.toString("base64");
        } catch {
          // PDF was not generated
        }

        if (!pdfBase64 || result.timedOut) {
          return NextResponse.json(
            {
              error: result.timedOut
                ? "Compilation timed out"
                : "Compilation failed — no PDF generated",
              logs: result.logs,
              errors: errors.filter((e) => e.type === "error"),
              durationMs,
            },
            { status: 422 }
          );
        }

        return NextResponse.json({
          pdf: pdfBase64,
          logs: result.logs,
          errors,
          durationMs,
        });
      } finally {
        // Clean up temp directory
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      console.error("[API v1] Compile error:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
