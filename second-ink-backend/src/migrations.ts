import type { Query } from './db.js';
export interface Migration {version:number;statements:string[];after?:(q:Query)=>Promise<void>}
export const migrations:Migration[] = [{ version: 2, statements: [
  `CREATE TABLE IF NOT EXISTS field_corrections (
    id VARCHAR(36) PRIMARY KEY, case_id VARCHAR(36) NOT NULL, attachment_id VARCHAR(36) NOT NULL,
    record_id VARCHAR(100) NOT NULL, field VARCHAR(80) NOT NULL, original_value TEXT,
    value TEXT NOT NULL, reason TEXT NOT NULL, actor_id VARCHAR(36) NOT NULL,
    case_revision INTEGER NOT NULL, created_at VARCHAR(32) NOT NULL,
    FOREIGN KEY(case_id) REFERENCES cases(id), FOREIGN KEY(attachment_id) REFERENCES attachments(id))`,
  `CREATE TABLE IF NOT EXISTS skills (
    id VARCHAR(36) PRIMARY KEY, org_id VARCHAR(36) NOT NULL, name VARCHAR(120) NOT NULL,
    created_at VARCHAR(32) NOT NULL, FOREIGN KEY(org_id) REFERENCES organizations(id))`,
  `CREATE TABLE IF NOT EXISTS skill_versions (
    skill_id VARCHAR(36) NOT NULL, version INTEGER NOT NULL, status VARCHAR(20) NOT NULL,
    content_json TEXT NOT NULL, digest VARCHAR(64) NOT NULL, created_by VARCHAR(36) NOT NULL,
    created_at VARCHAR(32) NOT NULL, PRIMARY KEY(skill_id,version), FOREIGN KEY(skill_id) REFERENCES skills(id))`,
  `CREATE TABLE IF NOT EXISTS skill_trials (
    id VARCHAR(36) PRIMARY KEY, skill_id VARCHAR(36) NOT NULL, version INTEGER NOT NULL,
    case_id VARCHAR(36) NOT NULL, passed INTEGER NOT NULL, result_json TEXT NOT NULL,
    created_at VARCHAR(32) NOT NULL, FOREIGN KEY(skill_id) REFERENCES skills(id))`,
  `CREATE TABLE IF NOT EXISTS patches (
    id VARCHAR(36) PRIMARY KEY, document_id VARCHAR(36) NOT NULL, base_version INTEGER NOT NULL,
    replacements_json MEDIUMTEXT NOT NULL, reason TEXT NOT NULL, evidence_refs_json TEXT NOT NULL,
    source_run_id VARCHAR(36), actor_id VARCHAR(36) NOT NULL, status VARCHAR(20) NOT NULL,
    accepted_version INTEGER, created_at VARCHAR(32) NOT NULL, decided_at VARCHAR(32),
    FOREIGN KEY(document_id) REFERENCES documents(id))`,
  `CREATE TABLE IF NOT EXISTS model_attempts (
    id VARCHAR(36) PRIMARY KEY, run_id VARCHAR(36) NOT NULL, attempt INTEGER NOT NULL,
    model VARCHAR(200) NOT NULL, status VARCHAR(32) NOT NULL, latency_ms INTEGER NOT NULL,
    prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER,
    created_at VARCHAR(32) NOT NULL, FOREIGN KEY(run_id) REFERENCES runs(id))`
] }, { version: 3, statements: [
  `CREATE TABLE IF NOT EXISTS teams (
    id VARCHAR(36) PRIMARY KEY, org_id VARCHAR(36) NOT NULL, name VARCHAR(120) NOT NULL,
    created_at VARCHAR(32) NOT NULL, FOREIGN KEY(org_id) REFERENCES organizations(id))`,
  `CREATE TABLE IF NOT EXISTS team_versions (
    team_id VARCHAR(36) NOT NULL, version INTEGER NOT NULL, status VARCHAR(20) NOT NULL,
    definition_json TEXT NOT NULL, digest VARCHAR(64) NOT NULL, created_by VARCHAR(36) NOT NULL,
    created_at VARCHAR(32) NOT NULL, PRIMARY KEY(team_id,version), FOREIGN KEY(team_id) REFERENCES teams(id))`,
  `CREATE TABLE IF NOT EXISTS run_controls (
    run_id VARCHAR(36) PRIMARY KEY, revision INTEGER NOT NULL, epoch INTEGER NOT NULL,
    paused_nodes_json TEXT NOT NULL, model_calls INTEGER NOT NULL, created_at VARCHAR(32) NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(id))`,
  `CREATE TABLE IF NOT EXISTS run_nodes (
    run_id VARCHAR(36) NOT NULL, node_id VARCHAR(40) NOT NULL, status VARCHAR(24) NOT NULL,
    attempt INTEGER NOT NULL, generation INTEGER NOT NULL, output_json MEDIUMTEXT,
    error_message TEXT, started_at VARCHAR(32), finished_at VARCHAR(32),
    PRIMARY KEY(run_id,node_id), FOREIGN KEY(run_id) REFERENCES runs(id))`,
  `CREATE TABLE IF NOT EXISTS node_attempts (
    id VARCHAR(36) PRIMARY KEY, run_id VARCHAR(36) NOT NULL, node_id VARCHAR(40) NOT NULL,
    attempt INTEGER NOT NULL, epoch INTEGER NOT NULL, generation INTEGER NOT NULL,
    status VARCHAR(24) NOT NULL, error_message TEXT, started_at VARCHAR(32) NOT NULL,
    finished_at VARCHAR(32), UNIQUE(run_id,node_id,attempt), FOREIGN KEY(run_id) REFERENCES runs(id))`,
  `CREATE TABLE IF NOT EXISTS run_checkpoints (
    id VARCHAR(36) PRIMARY KEY, run_id VARCHAR(36) NOT NULL, epoch INTEGER NOT NULL,
    event_seq INTEGER NOT NULL, snapshot_json MEDIUMTEXT NOT NULL, digest VARCHAR(64) NOT NULL,
    created_by VARCHAR(36) NOT NULL, created_at VARCHAR(32) NOT NULL, FOREIGN KEY(run_id) REFERENCES runs(id))`,
  `CREATE TABLE IF NOT EXISTS control_receipts (
    id VARCHAR(36) PRIMARY KEY, run_id VARCHAR(36) NOT NULL, user_id VARCHAR(36) NOT NULL,
    request_digest VARCHAR(64) NOT NULL, receipt_json TEXT NOT NULL, created_at VARCHAR(32) NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(id))`
] }, { version: 4, statements: [
  `CREATE TABLE IF NOT EXISTS material_selections (
    case_id VARCHAR(36) PRIMARY KEY, ids_json TEXT NOT NULL, actor_id VARCHAR(36) NOT NULL,
    reason TEXT NOT NULL, updated_at VARCHAR(32) NOT NULL, FOREIGN KEY(case_id) REFERENCES cases(id))`,
  `CREATE TABLE IF NOT EXISTS run_lineage (
    run_id VARCHAR(36) PRIMARY KEY, branch_id VARCHAR(36) NOT NULL UNIQUE, root_run_id VARCHAR(36) NOT NULL,
    parent_run_id VARCHAR(36), checkpoint_id VARCHAR(36), plan_version INTEGER NOT NULL,
    superseded_run_id VARCHAR(36), created_by VARCHAR(36) NOT NULL, created_at VARCHAR(32) NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(id), FOREIGN KEY(root_run_id) REFERENCES runs(id))`,
  `CREATE TABLE IF NOT EXISTS case_heads (
    case_id VARCHAR(36) PRIMARY KEY, run_id VARCHAR(36) NOT NULL, revision INTEGER NOT NULL,
    FOREIGN KEY(case_id) REFERENCES cases(id), FOREIGN KEY(run_id) REFERENCES runs(id))`,
  `CREATE TABLE IF NOT EXISTS root_budgets (
    root_run_id VARCHAR(36) PRIMARY KEY, max_calls INTEGER NOT NULL, used_calls INTEGER NOT NULL,
    FOREIGN KEY(root_run_id) REFERENCES runs(id))`,
  `CREATE TABLE IF NOT EXISTS amendment_previews (
    id VARCHAR(36) PRIMARY KEY, case_id VARCHAR(36) NOT NULL, source_run_id VARCHAR(36) NOT NULL,
    created_by VARCHAR(36) NOT NULL, base_json MEDIUMTEXT NOT NULL, plan_json MEDIUMTEXT NOT NULL,
    digest VARCHAR(64) NOT NULL, expires_at VARCHAR(32) NOT NULL, created_at VARCHAR(32) NOT NULL,
    FOREIGN KEY(case_id) REFERENCES cases(id), FOREIGN KEY(source_run_id) REFERENCES runs(id))`,
  `CREATE TABLE IF NOT EXISTS branch_receipts (
    id VARCHAR(36) PRIMARY KEY, case_id VARCHAR(36) NOT NULL, user_id VARCHAR(36) NOT NULL,
    request_digest VARCHAR(64) NOT NULL, receipt_json TEXT NOT NULL, created_at VARCHAR(32) NOT NULL,
    FOREIGN KEY(case_id) REFERENCES cases(id))`,
  `CREATE TABLE IF NOT EXISTS node_reuse (
    run_id VARCHAR(36) NOT NULL, node_id VARCHAR(40) NOT NULL, source_run_id VARCHAR(36) NOT NULL,
    checkpoint_id VARCHAR(36) NOT NULL, source_digest VARCHAR(64) NOT NULL,
    PRIMARY KEY(run_id,node_id), FOREIGN KEY(run_id) REFERENCES runs(id))`
], after:async q=>{
  const runs=await q.all('SELECT * FROM runs ORDER BY created_at DESC,id DESC');
  for(const run of runs){
    const input=JSON.parse(run.input_json);if(!input.team)continue;
    if(!await q.get('SELECT run_id FROM run_lineage WHERE run_id=?',[run.id]))await q.run('INSERT INTO run_lineage(run_id,branch_id,root_run_id,parent_run_id,checkpoint_id,plan_version,superseded_run_id,created_by,created_at) VALUES (?,?,?,NULL,NULL,1,NULL,?,?)',[run.id,run.id,run.id,run.requested_by,run.created_at]);
    const control=await q.get('SELECT model_calls FROM run_controls WHERE run_id=?',[run.id]);
    if(!await q.get('SELECT root_run_id FROM root_budgets WHERE root_run_id=?',[run.id]))await q.run('INSERT INTO root_budgets(root_run_id,max_calls,used_calls) VALUES (?,?,?)',[run.id,input.team.definition.maxModelCalls,control?.model_calls||0]);
    if(!await q.get('SELECT case_id FROM case_heads WHERE case_id=?',[run.case_id]))await q.run('INSERT INTO case_heads(case_id,run_id,revision) VALUES (?,?,1)',[run.case_id,run.id]);
  }
} }];
