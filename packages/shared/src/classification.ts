import { z } from "zod";

/** LLM classification JSON — validate before any policy or side effect. */
export const classificationSchema = z.object({
  artist: z.string().min(1),
  title: z.string().min(1),
  genre: z.string().min(1),
  subgenres: z.array(z.string()),
  electronic: z.boolean(),
  station_match: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type Classification = z.infer<typeof classificationSchema>;

/** JSON Schema sent to Ollama `format` (structured output). Not a shell/tool schema. */
export const CLASSIFICATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    artist: { type: "string" },
    title: { type: "string" },
    genre: { type: "string" },
    subgenres: { type: "array", items: { type: "string" } },
    electronic: { type: "boolean" },
    station_match: { type: "boolean" },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: [
    "artist",
    "title",
    "genre",
    "subgenres",
    "electronic",
    "station_match",
    "confidence",
    "reason",
  ],
} as const;

export function parseClassification(input: unknown): Classification {
  return classificationSchema.parse(input);
}

export function safeParseClassification(input: unknown) {
  return classificationSchema.safeParse(input);
}

export function parseClassificationJson(raw: string): Classification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LLM response was not valid JSON");
  }
  return parseClassification(parsed);
}
