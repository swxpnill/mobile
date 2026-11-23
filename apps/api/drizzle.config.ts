import { defineConfig } from 'drizzle-kit';

/** `db:generate` only diffs the schema files; it never connects. Migrations run through `src/db/migrate.ts`. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  strict: true,
});
