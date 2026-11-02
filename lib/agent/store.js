/**
 * Agent 的独立状态库。
 *
 * 为什么不塞进 redteam 库：
 * - redteam 库是资产/漏洞/证据的事实库，已有自己的迁移；
 * - 这里是“思考过程/任务树/派单”，可以独立清理或重建，不碰事实库。
 * 用 engagement_id 关联两边。
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DDL = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  scenario TEXT NOT NULL DEFAULT 'pentest',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  parent_id TEXT,
  domain TEXT NOT NULL DEFAULT 'webapi',
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 5,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  task_id TEXT,
  statement TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  task_id TEXT,
  owner TEXT NOT NULL DEFAULT 'main',
  capability TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '{}',
  expected TEXT NOT NULL DEFAULT '',
  falsify TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  result TEXT NOT NULL DEFAULT '',
  evidence_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reflections (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(mission_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_hypotheses_mission ON hypotheses(mission_id, status);
CREATE INDEX IF NOT EXISTS idx_actions_mission ON actions(mission_id, task_id);
`;

function now() {
  return new Date().toISOString();
}

export class AgentStore {
  constructor(home) {
    this.home = home || process.env.DSH_HOME || join(homedir(), ".dsh");
    this.path = join(this.home, "agent", "state.db");
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(DDL);
    this.migrate();
  }

  /* 旧库没有 scenario 列；用 ALTER TABLE 补，已有 mission 默认按正常渗透读。 */
  migrate() {
    const columns = this.db.prepare("PRAGMA table_info(missions)").all().map((row) => row.name);
    if (!columns.includes("scenario")) {
      this.db.exec("ALTER TABLE missions ADD COLUMN scenario TEXT NOT NULL DEFAULT 'pentest'");
    }
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }

  createMission({ engagementId, objective, scenario }) {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(
      "INSERT INTO missions (id, engagement_id, objective, scenario, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)"
    ).run(id, String(engagementId), String(objective || ""), String(scenario || "pentest"), ts, ts);
    return this.getMission(id);
  }

  getMission(id) {
    const row = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(String(id));
    return row || null;
  }

  missionForEngagement(engagementId) {
    return this.db.prepare(
      "SELECT * FROM missions WHERE engagement_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
    ).get(String(engagementId)) || null;
  }

  /* 读操作/收口用：拿到最近一次任务树，不因为已关闭就重新建。 */
  latestMissionForEngagement(engagementId) {
    return this.db.prepare(
      "SELECT * FROM missions WHERE engagement_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(String(engagementId)) || null;
  }

  updateMission(id, patch = {}) {
    const fields = [];
    const values = [];
    for (const key of ["objective", "scenario", "status"]) {
      if (patch[key] !== undefined) { fields.push(`${key} = ?`); values.push(String(patch[key])); }
    }
    if (!fields.length) return this.getMission(id);
    fields.push("updated_at = ?"); values.push(now());
    values.push(String(id));
    this.db.prepare(`UPDATE missions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getMission(id);
  }

  addTask(missionId, task) {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(
      `INSERT INTO tasks (id, mission_id, parent_id, domain, title, status, priority, detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, String(missionId), task.parentId || null, task.domain || "webapi",
      task.title, task.status || "pending", Number(task.priority) || 5,
      task.detail || "", ts, ts
    );
    return this.getTask(id);
  }

  getTask(id) {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(String(id)) || null;
  }

  listTasks(missionId) {
    return this.db.prepare(
      "SELECT * FROM tasks WHERE mission_id = ? ORDER BY priority ASC, created_at ASC"
    ).all(String(missionId));
  }

  updateTask(id, patch = {}) {
    const fields = [];
    const values = [];
    for (const key of ["parent_id", "domain", "title", "status", "priority", "detail"]) {
      const prop = key === "parent_id" ? "parentId" : key;
      if (patch[prop] !== undefined) { fields.push(`${key} = ?`); values.push(patch[prop]); }
    }
    if (!fields.length) return this.getTask(id);
    fields.push("updated_at = ?"); values.push(now());
    values.push(String(id));
    this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getTask(id);
  }

  addHypothesis(missionId, h) {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(
      `INSERT INTO hypotheses (id, mission_id, task_id, statement, confidence, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, String(missionId), h.taskId || null, h.statement, Number(h.confidence) || 0.5, h.status || "open", ts, ts);
    return this.db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(id);
  }

  listHypotheses(missionId, status) {
    if (status) {
      return this.db.prepare("SELECT * FROM hypotheses WHERE mission_id = ? AND status = ? ORDER BY created_at").all(String(missionId), String(status));
    }
    return this.db.prepare("SELECT * FROM hypotheses WHERE mission_id = ? ORDER BY created_at").all(String(missionId));
  }

  updateHypothesis(id, patch = {}) {
    const fields = [];
    const values = [];
    for (const key of ["confidence", "status", "statement"]) {
      if (patch[key] !== undefined) { fields.push(`${key} = ?`); values.push(patch[key]); }
    }
    if (!fields.length) return this.db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(String(id));
    fields.push("updated_at = ?"); values.push(now());
    values.push(String(id));
    this.db.prepare(`UPDATE hypotheses SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(String(id));
  }

  addAction(missionId, action) {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(
      `INSERT INTO actions (id, mission_id, task_id, owner, capability, args_json, expected, falsify, status, result, evidence_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, String(missionId), action.taskId || null, action.owner || "main",
      action.capability, JSON.stringify(action.args || {}), action.expected || "",
      action.falsify || "", action.status || "planned", action.result || "",
      action.evidenceRef || "", ts, ts
    );
    return this.getAction(id);
  }

  getAction(id) {
    return this.db.prepare("SELECT * FROM actions WHERE id = ?").get(String(id)) || null;
  }

  finishAction(id, { status = "done", result = "", evidenceRef = "" } = {}) {
    this.db.prepare(
      "UPDATE actions SET status = ?, result = ?, evidence_ref = ?, updated_at = ? WHERE id = ?"
    ).run(String(status), String(result), String(evidenceRef), now(), String(id));
    return this.getAction(id);
  }

  listActions(missionId) {
    return this.db.prepare("SELECT * FROM actions WHERE mission_id = ? ORDER BY created_at").all(String(missionId));
  }

  addReflection(missionId, trigger, content) {
    const id = randomUUID();
    this.db.prepare(
      "INSERT INTO reflections (id, mission_id, trigger, content, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, String(missionId), String(trigger || ""), String(content), now());
    return { id, mission_id: String(missionId), trigger: String(trigger || ""), content: String(content) };
  }

  listReflections(missionId) {
    return this.db.prepare("SELECT * FROM reflections WHERE mission_id = ? ORDER BY created_at").all(String(missionId));
  }

  summary(missionId) {
    const mission = this.getMission(missionId);
    if (!mission) return null;
    const tasks = this.listTasks(missionId);
    const hypotheses = this.listHypotheses(missionId);
    const actions = this.listActions(missionId);
    const by = (list, key) => list.reduce((acc, item) => {
      const value = item[key] || "unknown";
      acc[value] = (acc[value] || 0) + 1;
      return acc;
    }, {});
    return {
      mission,
      tasks: { total: tasks.length, by_status: by(tasks, "status"), by_domain: by(tasks, "domain") },
      hypotheses: { total: hypotheses.length, by_status: by(hypotheses, "status") },
      actions: { total: actions.length, by_status: by(actions, "status") },
      reflections: this.listReflections(missionId).length,
    };
  }
}
