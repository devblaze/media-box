import type { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { requirePermission } from "@/server/auth/guards";
import { getBuiltin, findBuiltinKeyByName } from "@/server/indexers/builtin/registry";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The `<slug>` in a Jackett Torznab URL: `.../indexers/<slug>/results/torznab/...`. */
function jackettSlug(url: string): string {
  const m = /\/indexers\/([^/]+)\//.exec(url);
  return m ? m[1] : "";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Best-effort match of a Torznab row to a built-in key (name → URL slug → host). */
function matchBuiltin(name: string, url: string): string | null {
  return (
    findBuiltinKeyByName(name) ||
    findBuiltinKeyByName(jackettSlug(url)) ||
    findBuiltinKeyByName(hostOf(url))
  );
}

/** Preview: which Torznab indexers can be replaced by a native built-in. */
export async function GET(request: NextRequest) {
  const denied = requirePermission(request, "indexers.manage");
  if (denied) return denied;
  try {
    const rows = getDb()
      .select()
      .from(schema.indexers)
      .where(eq(schema.indexers.type, "torznab"))
      .all();
    const migratable: { id: number; name: string; url: string; builtinKey: string; builtinName: string }[] = [];
    const unmatched: { id: number; name: string; url: string }[] = [];
    for (const r of rows) {
      const key = matchBuiltin(r.name, r.url);
      const def = getBuiltin(key);
      if (key && def) {
        migratable.push({ id: r.id, name: r.name, url: r.url, builtinKey: key, builtinName: def.name });
      } else {
        unmatched.push({ id: r.id, name: r.name, url: r.url });
      }
    }
    return ok({ migratable, unmatched });
  } catch (err) {
    return serverError(err);
  }
}

const applySchema = z.object({ ids: z.array(z.number().int()).min(1) });

/** Apply: flip the selected Torznab rows to their built-in equivalents (drops the
 *  Jackett dependency). If a built-in already exists, the redundant Torznab row is
 *  removed instead of creating a duplicate. */
export async function POST(request: NextRequest) {
  const denied = requirePermission(request, "indexers.manage");
  if (denied) return denied;
  try {
    const { ids } = applySchema.parse(await request.json());
    const db = getDb();
    let migrated = 0;
    for (const id of ids) {
      const row = db.select().from(schema.indexers).where(eq(schema.indexers.id, id)).get();
      if (!row || row.type !== "torznab") continue;
      const key = matchBuiltin(row.name, row.url);
      const def = getBuiltin(key);
      if (!key || !def) continue;

      const dup = db
        .select({ id: schema.indexers.id })
        .from(schema.indexers)
        .where(and(eq(schema.indexers.type, "builtin"), eq(schema.indexers.definition, key)))
        .get();
      if (dup) {
        // Already have this built-in — just remove the redundant Jackett feed.
        db.delete(schema.indexers).where(eq(schema.indexers.id, id)).run();
        migrated++;
        continue;
      }

      db.update(schema.indexers)
        .set({
          type: "builtin",
          definition: key,
          url: "",
          apiKey: null,
          supportsTv: def.supportsTv,
          supportsMovies: def.supportsMovies,
          categories: def.categories,
        })
        .where(eq(schema.indexers.id, id))
        .run();
      migrated++;
    }
    return ok({ migrated });
  } catch (err) {
    return serverError(err);
  }
}
