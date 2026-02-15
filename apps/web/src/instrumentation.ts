export async function register() {
  const runInWeb = process.env.RUN_COMPILE_RUNNER_IN_WEB !== "false";

  if (process.env.NEXT_RUNTIME === "nodejs" && runInWeb) {
    try {
      const { startCompileRunner } = await import("@/lib/compiler/runner");
      const { startAsyncCompileRunner } = await import("@/lib/compiler/asyncCompileRunner");
      startCompileRunner();
      startAsyncCompileRunner();
      console.log("[Instrumentation] Compile runners started");
    } catch (err) {
      console.error(
        "[Instrumentation] Failed to start compile runners:",
        err instanceof Error ? err.message : err
      );
    }
  } else if (process.env.NEXT_RUNTIME === "nodejs") {
    console.log(
      "[Instrumentation] Compile runner disabled in web (RUN_COMPILE_RUNNER_IN_WEB=false)"
    );
  }
}
