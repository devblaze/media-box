/**
 * `invalidBody` exists because the shared `apiFetch` surfaces only the `error`
 * string. An `issues` array alone reaches the user as "Validation failed",
 * which is what turned a one-field mistake in the organizer into an unreadable
 * "Invalid request body".
 */
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { invalidBody } from "./http";

const schema = z.object({
  sourcePath: z.string().min(1),
  id: z.number().int().positive(),
  episodeNumbers: z.array(z.number().int().min(0)).optional(),
});

/** The error a failed parse throws, for feeding straight back in. */
function errorFor(input: unknown): unknown {
  try {
    schema.parse(input);
    throw new Error("expected the parse to fail");
  } catch (err) {
    return err;
  }
}

async function bodyOf(res: Response): Promise<{ error: string; issues?: unknown[] }> {
  return (await res.json()) as { error: string; issues?: unknown[] };
}

describe("invalidBody", () => {
  test("names the field that failed", async () => {
    const res = invalidBody(errorFor({ sourcePath: "x", id: -1 }));
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.error).toContain("id");
    expect(body.issues).toHaveLength(1);
  });

  test("names the index inside an array, which is what a bulk run needs", async () => {
    // A 200-file organize that trips on one row is undiagnosable without this.
    const res = invalidBody(errorFor({ sourcePath: "x", id: 1, episodeNumbers: [1, -2] }));
    expect((await bodyOf(res)).error).toContain("episodeNumbers.1");
  });

  test("lists several fields but does not run on forever", async () => {
    const res = invalidBody(errorFor({}));
    const body = await bodyOf(res);
    expect(body.error).toContain("sourcePath");
    expect(body.error).toContain("id");
    // Every issue is still available to anything reading the API directly.
    expect(body.issues!.length).toBeGreaterThanOrEqual(2);
  });

  test("caps the named fields and says how many more there were", async () => {
    const wide = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string() });
    let err: unknown;
    try {
      wide.parse({});
    } catch (e) {
      err = e;
    }
    const body = await bodyOf(invalidBody(err));
    expect(body.error).toContain("and 1 more");
  });

  test("a non-Zod failure falls back to the plain message", async () => {
    // A body that isn't JSON at all never reaches Zod.
    const res = invalidBody(new SyntaxError("Unexpected token"));
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe("Request body was not valid JSON");
  });
});
