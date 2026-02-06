import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://backslash:devpassword@localhost:5432/backslash";

const client = postgres(connectionString);

export const db = drizzle(client, { schema });
