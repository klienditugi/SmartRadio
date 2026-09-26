import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "./migrate.js";
import { listIntegrationChecks, listSettings, upsertIntegrationCheck } from "./store.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

describe("integration_checks migration", () => {
  it("adds the table to a database that already applied 001 and keeps existing rows", () => {
    const db = new Database(":memory:");
    db.exec(readFileSync(path.join(migrationsDir, "001_initial.sql"), "utf8"));
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run("001_initial.sql", 1);
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("user-1", "kept-admin", "hash", "admin", 10, 10);
    db.prepare(
      `INSERT INTO providers (id, kind, name, config_json, verify_status, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("llm-ollama", "llm", "OllamaProvider", "{}", "verified", 1, 10, 10);

    migrate(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'integration_checks'").get() as
      | { name: string }
      | undefined;
    expect(tables?.name).toBe("integration_checks");
    const user = db.prepare("SELECT username FROM users WHERE id = ?").get("user-1") as { username: string };
    expect(user.username).toBe("kept-admin");
    const provider = db.prepare("SELECT verify_status FROM providers WHERE id = ?").get("llm-ollama") as { verify_status: string };
    expect(provider.verify_status).toBe("verified");
    upsertIntegrationCheck(db, {
      integration: "library",
      state: "ready",
      fingerprint: "abc",
      testedAt: 20,
    });
    expect(listIntegrationChecks(db)).toEqual([
      { integration: "library", state: "ready", fingerprint: "abc", testedAt: 20 },
    ]);

    migrate(db);
    const applied = db.prepare("SELECT id FROM schema_migrations WHERE id = ?").all("002_integration_checks.sql");
    expect(applied).toHaveLength(1);
    expect(listIntegrationChecks(db)).toHaveLength(1);
    db.close();
  });

  it("removes verify_status from the settings table", () => {
    const db = new Database(":memory:");
    db.exec(readFileSync(path.join(migrationsDir, "001_initial.sql"), "utf8"));
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run("001_initial.sql", 1);
    db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)").run(
      "llm",
      JSON.stringify({ model: "kept", verify_status: "verified" }),
      1,
    );
    db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)").run("verify_status", '"verified"', 1);
    db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)").run(
      "nested",
      JSON.stringify({ wrapper: { verify_status: "verified", keep: true } }),
      1,
    );

    migrate(db);

    const llm = db.prepare("SELECT value_json FROM settings WHERE key = ?").get("llm") as { value_json: string };
    expect(llm.value_json).not.toContain("verify_status");
    expect(JSON.parse(llm.value_json).model).toBe("kept");
    expect(db.prepare("SELECT key FROM settings WHERE key = ?").get("verify_status")).toBeUndefined();
    expect(JSON.stringify(listSettings(db))).not.toContain("verify_status");
    expect(listSettings(db).nested).toEqual({ wrapper: { keep: true } });
    db.close();
  });
});
