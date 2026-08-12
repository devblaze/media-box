import type { NextRequest } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { getCaps } from "@/server/indexers/torznab";
import { getBuiltin } from "@/server/indexers/builtin/registry";
import { listCatalog } from "@/server/indexers/cardigann";
import { badRequest, ok, serverError } from "@/lib/http";
import { requirePermission } from "@/server/auth/guards";

export async function GET(request: NextRequest) {
  const denied = requirePermission(request, "indexers.manage");
  if (denied) return denied;
  try {
    const db = getDb();
    return ok(db.select().from(schema.indexers).orderBy(asc(schema.indexers.priority)).all());
  } catch (err) {
    return serverError(err);
  }
}

export const indexerSchema = z.object({
  name: z.string().min(1),
  // "torznab" (external Prowlarr/Jackett), "builtin" (ships inside media-box),
  // or "cardigann" (a Jackett/Prowlarr YAML definition run natively).
  type: z.enum(["torznab", "builtin", "cardigann"]).optional(),
  // Required for torznab; validated in POST (kept loose here so PUT can patch it).
  url: z.string().optional(),
  apiKey: z.string().nullable().optional(),
  // Registry key when type = "builtin" (e.g. "apibay").
  definition: z.string().nullable().optional(),
  categories: z.array(z.number().int()).optional(),
  enableRss: z.boolean().optional(),
  enableAutomaticSearch: z.boolean().optional(),
  enableInteractiveSearch: z.boolean().optional(),
  minimumSeeders: z.number().int().min(0).optional(),
  priority: z.number().int().min(1).max(50).optional(),
  enabled: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const denied = requirePermission(request, "indexers.manage");
  if (denied) return denied;
  try {
    const input = indexerSchema.parse(await request.json());
    const db = getDb();

    // Built-in scraper: no URL/API key; identity and capabilities come from the
    // registry. One row per built-in source.
    if (input.type === "builtin") {
      const def = getBuiltin(input.definition);
      if (!def) return badRequest(`Unknown built-in indexer '${input.definition}'`);
      const existing = db
        .select()
        .from(schema.indexers)
        .where(and(eq(schema.indexers.type, "builtin"), eq(schema.indexers.definition, def.key)))
        .get();
      if (existing) return badRequest(`${def.name} is already added`);
      const row = db
        .insert(schema.indexers)
        .values({
          name: input.name || def.name,
          type: "builtin",
          definition: def.key,
          url: "",
          apiKey: null,
          categories: input.categories ?? def.categories,
          supportsTv: def.supportsTv,
          supportsMovies: def.supportsMovies,
          enableRss: input.enableRss,
          enableAutomaticSearch: input.enableAutomaticSearch,
          enableInteractiveSearch: input.enableInteractiveSearch,
          minimumSeeders: input.minimumSeeders,
          priority: input.priority,
          enabled: input.enabled,
        })
        .returning()
        .get();
      return ok(row, { status: 201 });
    }

    // Cardigann: a YAML definition from the Prowlarr/Indexers catalog, run
    // natively. `url` is an optional base-URL override (trackers move domains).
    if (input.type === "cardigann") {
      if (!input.definition) return badRequest("A definition id is required");
      const entry = (await listCatalog()).find((e) => e.id === input.definition);
      if (!entry) return badRequest(`Unknown indexer definition '${input.definition}'`);
      if (!entry.supported) {
        return badRequest(
          `${entry.name} can't run natively yet — ${entry.unsupportedReason ?? "unsupported definition"}`
        );
      }
      const existing = db
        .select()
        .from(schema.indexers)
        .where(and(eq(schema.indexers.type, "cardigann"), eq(schema.indexers.definition, entry.id)))
        .get();
      if (existing) return badRequest(`${entry.name} is already added`);
      const row = db
        .insert(schema.indexers)
        .values({
          name: input.name || entry.name,
          type: "cardigann",
          definition: entry.id,
          url: input.url ?? "",
          apiKey: null,
          categories: input.categories ?? entry.categories,
          supportsTv: entry.supportsTv,
          supportsMovies: entry.supportsMovies,
          enableRss: input.enableRss,
          enableAutomaticSearch: input.enableAutomaticSearch,
          enableInteractiveSearch: input.enableInteractiveSearch,
          minimumSeeders: input.minimumSeeders,
          priority: input.priority,
          enabled: input.enabled,
        })
        .returning()
        .get();
      return ok(row, { status: 201 });
    }

    // Torznab feed: a valid URL is mandatory; discover capabilities on save.
    const parsedUrl = z.string().url().safeParse(input.url);
    if (!parsedUrl.success) return badRequest("A valid Torznab URL is required");
    let supportsTv = true;
    let supportsMovies = true;
    try {
      const caps = await getCaps(parsedUrl.data, input.apiKey ?? null);
      supportsTv = caps.tvSearchAvailable;
      supportsMovies = caps.movieSearchAvailable;
    } catch {
      // keep defaults if caps probing fails; Test button reports errors explicitly
    }
    const row = db
      .insert(schema.indexers)
      .values({
        ...input,
        type: "torznab",
        definition: null,
        url: parsedUrl.data,
        apiKey: input.apiKey ?? null,
        supportsTv,
        supportsMovies,
      })
      .returning()
      .get();
    return ok(row, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
