import { z } from "zod";

const BaseSchema = z.object({
  XHGUI_BACKEND: z.enum(["pdo", "mongodb"]),
  XHGUI_HOTSPOT_PATTERNS: z.string().optional(),
});

const PdoSchema = BaseSchema.extend({
  XHGUI_BACKEND: z.literal("pdo"),
  XHGUI_PDO_DSN: z.string().min(1, "XHGUI_PDO_DSN is required when XHGUI_BACKEND=pdo"),
});

const MongoSchema = BaseSchema.extend({
  XHGUI_BACKEND: z.literal("mongodb"),
  XHGUI_MONGO_URI: z.string().min(1),
  XHGUI_MONGO_DB: z.string().default("xhprof"),
});

const RawSchema = z.discriminatedUnion("XHGUI_BACKEND", [PdoSchema, MongoSchema]);

export interface Config {
  backend: "pdo" | "mongodb";
  pdo?: { dsn: string };
  mongo?: { uri: string; db: string };
  hotspotPatterns: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = RawSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid xhgui-mcp configuration:\n${msg}`);
  }
  const data = parsed.data;

  const hotspotPatterns = (data.XHGUI_HOTSPOT_PATTERNS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (data.XHGUI_BACKEND === "pdo") {
    return {
      backend: "pdo",
      pdo: { dsn: data.XHGUI_PDO_DSN },
      hotspotPatterns,
    };
  }
  return {
    backend: "mongodb",
    mongo: { uri: data.XHGUI_MONGO_URI, db: data.XHGUI_MONGO_DB },
    hotspotPatterns,
  };
}
