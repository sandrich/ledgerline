// Local verification helper: prints db state and hits API endpoints on 127.0.0.1.
import Database from "better-sqlite3";

const base = process.env.BASE ?? "http://127.0.0.1:8790";
const db = new Database(process.env.DATABASE_PATH ?? "data/portfolio.db", { readonly: true });
console.log("user_version", db.pragma("user_version", { simple: true }));
const q = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return e.message; } };
console.log("jobs", JSON.stringify(q("select type, status, count(*) n from jobs group by type, status")));
console.log("snapshots", JSON.stringify(q("select kind, count(*) n, min(ts) mn, max(ts) mx from snapshots group by kind")));
console.log("progress", JSON.stringify(q("select * from discovery_state")));

for (const path of (process.argv[2] ?? "/api/health").split(",")) {
  try {
    const r = await fetch(base + path);
    const t = await r.text();
    console.log(path, r.status, t.slice(0, Number(process.env.MAX ?? 400)));
  } catch (e) {
    console.log(path, "ERR", e.message);
  }
}
