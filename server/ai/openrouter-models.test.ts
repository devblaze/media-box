import { describe, expect, it } from "vitest";
import { parseOpenRouterModels } from "./openrouter-models";

/** Shape returned by OpenRouter's public /models endpoint (pricing = strings). */
function payload(data: unknown) {
  return { data };
}

describe("parseOpenRouterModels", () => {
  it("maps models and detects free pricing from '0' strings", () => {
    const models = parseOpenRouterModels(
      payload([
        {
          id: "openai/gpt-4o-mini",
          name: "OpenAI: GPT-4o-mini",
          pricing: { prompt: "0.00000015", completion: "0.0000006" },
        },
        {
          id: "meta-llama/llama-3.3-70b-instruct:free",
          name: "Meta: Llama 3.3 70B (free)",
          pricing: { prompt: "0", completion: "0" },
        },
      ])
    );
    expect(models).toEqual([
      { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Meta: Llama 3.3 70B (free)", free: true },
      { id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o-mini", free: false },
    ]);
  });

  it("treats missing or malformed pricing as paid", () => {
    const models = parseOpenRouterModels(
      payload([
        { id: "a/no-pricing", name: "A" },
        { id: "b/bad-pricing", name: "B", pricing: { prompt: "gratis", completion: "0" } },
        { id: "c/partial-free", name: "C", pricing: { prompt: "0", completion: "0.001" } },
      ])
    );
    expect(models.map((m) => m.free)).toEqual([false, false, false]);
  });

  it("falls back to the id when the name is missing and drops idless entries", () => {
    const models = parseOpenRouterModels(
      payload([
        { id: "x/unnamed", pricing: { prompt: "0", completion: "0" } },
        { name: "no id at all" },
        { id: "", name: "empty id" },
        "not even an object",
      ])
    );
    expect(models).toEqual([{ id: "x/unnamed", name: "x/unnamed", free: true }]);
  });

  it("returns [] for junk payloads", () => {
    expect(parseOpenRouterModels(null)).toEqual([]);
    expect(parseOpenRouterModels({})).toEqual([]);
    expect(parseOpenRouterModels(payload("nope"))).toEqual([]);
  });

  it("sorts by id for a stable picker list", () => {
    const models = parseOpenRouterModels(
      payload([
        { id: "z/last", name: "Z", pricing: { prompt: "0", completion: "0" } },
        { id: "a/first", name: "A", pricing: { prompt: "0", completion: "0" } },
      ])
    );
    expect(models.map((m) => m.id)).toEqual(["a/first", "z/last"]);
  });
});
