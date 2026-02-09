#!/usr/bin/env node

/**
 * Standalone migration script for Backslash.
 *
 * Usage:
 *   node scripts/migrate.mjs            (from apps/web/)
 *   node apps/web/scripts/migrate.mjs   (from repo root)
 *
 * The script exits with code 0 on success and 1 on failure.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const LOCK_KEY_1 = 2085062334;
const LOCK_KEY_2 = 1804289383;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://backslash:backslash@postgres:5432/backslash";

// In Docker, migration deps are installed in /migrate-deps because standalone
// output does not expose node_modules in a regular layout.
const migrateDeps = fs.existsSync("/migrate-deps/node_modules")
  ? createRequire("/migrate-deps/node_modules/")
  : createRequire(import.meta.url);

const postgres = migrateDeps("postgres");
const { drizzle } = migrateDeps("drizzle-orm/postgres-js");
const { migrate } = migrateDeps("drizzle-orm/postgres-js/migrator");

function findMigrationsFolder() {
  const candidates = [
    path.resolve(__dirname, "../drizzle/migrations"), // apps/web/scripts -> apps/web/drizzle
    path.resolve(process.cwd(), "drizzle/migrations"), // cwd = apps/web
    path.resolve(process.cwd(), "apps/web/drizzle/migrations"), // cwd = repo root
    path.resolve("/app/apps/web/drizzle/migrations"), // docker runtime
    path.resolve("/app/drizzle/migrations"), // fallback runtime path
  ];

  const folder = candidates.find((candidatePath) => {
    try {
      return fs.existsSync(path.join(candidatePath, "meta/_journal.json"));
    } catch {
      return false;
    }
  });

  if (!folder) {
    console.error("[migrate] Could not find migrations folder. Searched:");
    candidates.forEach((candidatePath) => console.error(`  - ${candidatePath}`));
    return null;
  }

  return folder;
}

function isSchemaConflict(message) {
  return (
    message.includes("already exists") ||
    message.includes("Failed query: CREATE TYPE") ||
    message.includes("Failed query: CREATE TABLE") ||
    message.includes("Failed query: CREATE INDEX")
  );
}

function isIgnorableStatementError(message) {
  return (
    message.includes("already exists") ||
    message.includes("duplicate key") ||
    message.includes("duplicate")
  );
}

async function ensureJournalTable(client) {
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS public.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    );
  `);
}

async function applyLegacyFallback(client, migrationsFolder) {
  console.log("[migrate] Detected pre-existing schema. Running fallback migration pass...");

  const journalPath = path.join(migrationsFolder, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));

  await ensureJournalTable(client);

  const applied = new Set();
  const existing = await client`
    SELECT hash FROM public.__drizzle_migrations ORDER BY created_at
  `;

  for (const row of existing) {
    applied.add(row.hash);
  }

  for (const entry of journal.entries) {
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) {
      continue;
    }

    const sqlContent = fs.readFileSync(sqlPath, "utf-8");
    const hash = createHash("sha256").update(sqlContent).digest("hex");

    if (applied.has(hash)) {
      console.log(`[migrate]   -> ${entry.tag} already recorded`);
      continue;
    }

    const statements = sqlContent
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    let skippedStatements = 0;
    for (const statement of statements) {
      try {
        await client.unsafe(statement);
      } catch (statementError) {
        const statementMessage = statementError?.message || String(statementError);
        if (isIgnorableStatementError(statementMessage)) {
          skippedStatements += 1;
          continue;
        }
        throw new Error(
          `Migration ${entry.tag} failed on statement: ${statementMessage}`
        );
      }
    }

    await client`
      INSERT INTO public.__drizzle_migrations (hash, created_at)
      VALUES (${hash}, ${Date.now()})
    `;

    console.log(
      `[migrate]   -> ${entry.tag} applied (${statements.length} statements, ${skippedStatements} skipped)`
    );
  }

  console.log("[migrate] Legacy migration pass completed");
}

async function main() {
  const migrationsFolder = findMigrationsFolder();
  if (!migrationsFolder) {
    process.exit(1);
    return;
  }

  console.log(`[migrate] Using migrations from: ${migrationsFolder}`);
  console.log("[migrate] Connecting to database...");

  const client = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  let lockAcquired = false;
  let hasError = false;

  try {
    console.log("[migrate] Acquiring migration lock...");
    await client`SELECT pg_advisory_lock(${LOCK_KEY_1}, ${LOCK_KEY_2})`;
    lockAcquired = true;
    console.log("[migrate] Migration lock acquired");

    await migrate(db, { migrationsFolder, migrationsSchema: "public" });
    console.log("[migrate] All migrations applied successfully");
  } catch (error) {
    const message = error?.message || String(error);

    if (isSchemaConflict(message)) {
      try {
        await applyLegacyFallback(client, migrationsFolder);
      } catch (fallbackError) {
        hasError = true;
        console.error(
          "[migrate] Fallback migration failed:",
          fallbackError?.message || fallbackError
        );
      }
    } else {
      hasError = true;
      console.error("[migrate] Migration failed:", message);
    }
  } finally {
    if (lockAcquired) {
      try {
        await client`SELECT pg_advisory_unlock(${LOCK_KEY_1}, ${LOCK_KEY_2})`;
        console.log("[migrate] Migration lock released");
      } catch (unlockError) {
        console.warn(
          "[migrate] Failed to release migration lock:",
          unlockError?.message || unlockError
        );
      }
    }

    await client.end();
  }

  if (hasError) {
    process.exit(1);
    return;
  }

  process.exit(0);
}

await main();
