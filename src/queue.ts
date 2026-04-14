import { Database } from "bun:sqlite";
import { resolve } from "path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  payload TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  container_id TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  repo TEXT NOT NULL,
  payload TEXT NOT NULL,
  job_id TEXT,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_repo ON jobs(repo);
CREATE INDEX IF NOT EXISTS idx_events_repo ON events(repo);
`;

export interface CreateJobParams {
  repo: string;
  type: string;
  payload: Record<string, any>;
}

export interface Job {
  id: string;
  repo: string;
  type: string;
  status: "queued" | "running" | "complete" | "failed";
  payload: Record<string, any>;
  result: Record<string, any> | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  container_id: string | null;
}

export class JobQueue {
  private db: Database;
  private maxConcurrent: number;

  constructor(dbPath?: string, maxConcurrent = 2) {
    const path = dbPath ?? resolve(process.cwd(), "data/botua.db");
    // Ensure data directory exists
    const dir = resolve(path, "..");
    try { require("fs").mkdirSync(dir, { recursive: true }); } catch {}

    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.maxConcurrent = maxConcurrent;
  }

  createJob(params: CreateJobParams): string {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.db.run(
      `INSERT INTO jobs (id, repo, type, status, payload, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
      [id, params.repo, params.type, JSON.stringify(params.payload), now],
    );

    console.log(`[queue] created job ${id} type=${params.type} repo=${params.repo}`);
    return id;
  }

  /** Get the next job to run, respecting concurrency and per-repo serialization */
  nextJob(): Job | null {
    // Check concurrent limit
    const running = this.db.query<{ count: number }, []>(
      `SELECT COUNT(*) as count FROM jobs WHERE status = 'running'`,
    ).get()!;

    if (running.count >= this.maxConcurrent) return null;

    // Get repos with running jobs (to serialize per repo)
    const busyRepos = this.db.query<{ repo: string }, []>(
      `SELECT DISTINCT repo FROM jobs WHERE status = 'running'`,
    ).all().map(r => r.repo);

    // Find next queued job not in a busy repo
    let query = `SELECT * FROM jobs WHERE status = 'queued'`;
    const params: string[] = [];
    if (busyRepos.length > 0) {
      const placeholders = busyRepos.map(() => "?").join(", ");
      query += ` AND repo NOT IN (${placeholders})`;
      params.push(...busyRepos);
    }
    query += ` ORDER BY created_at ASC LIMIT 1`;

    const row = this.db.query<any, string[]>(query).get(...params);
    if (!row) return null;

    return rowToJob(row);
  }

  startJob(id: string, containerId?: string): void {
    this.db.run(
      `UPDATE jobs SET status = 'running', started_at = ?, container_id = ? WHERE id = ?`,
      [Date.now(), containerId ?? null, id],
    );
  }

  completeJob(id: string, result: Record<string, any>): void {
    this.db.run(
      `UPDATE jobs SET status = 'complete', completed_at = ?, result = ? WHERE id = ?`,
      [Date.now(), JSON.stringify(result), id],
    );
  }

  failJob(id: string, error: string): void {
    this.db.run(
      `UPDATE jobs SET status = 'failed', completed_at = ?, result = ? WHERE id = ?`,
      [Date.now(), JSON.stringify({ error }), id],
    );
  }

  getJob(id: string): Job | null {
    const row = this.db.query<any, [string]>(`SELECT * FROM jobs WHERE id = ?`).get(id);
    return row ? rowToJob(row) : null;
  }

  stats(): { queued: number; running: number; completed: number; failed: number } {
    const counts = this.db.query<{ status: string; count: number }, []>(
      `SELECT status, COUNT(*) as count FROM jobs GROUP BY status`,
    ).all();

    const result = { queued: 0, running: 0, completed: 0, failed: 0 };
    for (const row of counts) {
      if (row.status in result) {
        (result as any)[row.status] = row.count;
      }
    }
    return result;
  }

  logEvent(source: string, eventType: string, repo: string, payload: string): string {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO events (id, source, event_type, repo, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, source, eventType, repo, payload, Date.now()],
    );
    return id;
  }

  linkEventToJob(eventId: string, jobId: string): void {
    this.db.run(`UPDATE events SET job_id = ? WHERE id = ?`, [jobId, eventId]);
  }

  recentEvents(limit = 20): any[] {
    return this.db.query<any, [number]>(
      `SELECT id, source, event_type, repo, job_id, received_at FROM events ORDER BY received_at DESC LIMIT ?`,
    ).all(limit);
  }

  close(): void {
    this.db.close();
  }
}

function rowToJob(row: any): Job {
  return {
    id: row.id,
    repo: row.repo,
    type: row.type,
    status: row.status,
    payload: JSON.parse(row.payload),
    result: row.result ? JSON.parse(row.result) : null,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    container_id: row.container_id,
  };
}
