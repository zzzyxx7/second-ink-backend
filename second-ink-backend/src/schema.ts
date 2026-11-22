// Version 1: portable DDL for SQLite development and MySQL deployments.
// Future changes must add a numbered migration rather than edit existing databases in place.
export const schema = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at VARCHAR(32) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(256) NOT NULL, created_at VARCHAR(32) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash VARCHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, expires_at VARCHAR(32) NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id))`,
  `CREATE TABLE IF NOT EXISTS organizations (
    id VARCHAR(36) PRIMARY KEY, name VARCHAR(120) NOT NULL, created_at VARCHAR(32) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memberships (
    org_id VARCHAR(36) NOT NULL, user_id VARCHAR(36) NOT NULL, role VARCHAR(20) NOT NULL,
    PRIMARY KEY(org_id,user_id), FOREIGN KEY(org_id) REFERENCES organizations(id), FOREIGN KEY(user_id) REFERENCES users(id))`,
  `CREATE TABLE IF NOT EXISTS cases (
    id VARCHAR(36) PRIMARY KEY, org_id VARCHAR(36) NOT NULL, created_by VARCHAR(36) NOT NULL, submitter_id VARCHAR(36),
    title VARCHAR(200) NOT NULL, scenario VARCHAR(24) NOT NULL, business_date VARCHAR(10) NOT NULL,
    status VARCHAR(24) NOT NULL, revision INTEGER NOT NULL, data_json MEDIUMTEXT NOT NULL,
    created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
    FOREIGN KEY(org_id) REFERENCES organizations(id), FOREIGN KEY(created_by) REFERENCES users(id))`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id VARCHAR(36) PRIMARY KEY, case_id VARCHAR(36) NOT NULL, name VARCHAR(240) NOT NULL,
    stored_name VARCHAR(80) NOT NULL, sha256 VARCHAR(64) NOT NULL, size_bytes INTEGER NOT NULL,
    purpose VARCHAR(24) NOT NULL, parsed_json MEDIUMTEXT NOT NULL, created_at VARCHAR(32) NOT NULL,
    FOREIGN KEY(case_id) REFERENCES cases(id))`,
  `CREATE TABLE IF NOT EXISTS rules (
    id VARCHAR(36) PRIMARY KEY, org_id VARCHAR(36) NOT NULL, scenario VARCHAR(24) NOT NULL,
    title VARCHAR(200) NOT NULL, version INTEGER NOT NULL, effective_from VARCHAR(10) NOT NULL,
    effective_to VARCHAR(10), content_json TEXT NOT NULL, created_at VARCHAR(32) NOT NULL,
    FOREIGN KEY(org_id) REFERENCES organizations(id))`,
  `CREATE TABLE IF NOT EXISTS runs (
    id VARCHAR(36) PRIMARY KEY, case_id VARCHAR(36) NOT NULL, requested_by VARCHAR(36) NOT NULL,
    status VARCHAR(24) NOT NULL, input_revision INTEGER NOT NULL, input_json MEDIUMTEXT NOT NULL,
    output_json MEDIUMTEXT, steps_json TEXT NOT NULL, error_message TEXT,
    lease_owner VARCHAR(36), lease_until VARCHAR(32), created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
    FOREIGN KEY(case_id) REFERENCES cases(id))`,
  `CREATE TABLE IF NOT EXISTS documents (
    id VARCHAR(36) PRIMARY KEY, case_id VARCHAR(36) NOT NULL, current_version INTEGER NOT NULL,
    title VARCHAR(200) NOT NULL, created_at VARCHAR(32) NOT NULL, FOREIGN KEY(case_id) REFERENCES cases(id))`,
  `CREATE TABLE IF NOT EXISTS document_versions (
    document_id VARCHAR(36) NOT NULL, version INTEGER NOT NULL, parent_version INTEGER,
    content_json MEDIUMTEXT NOT NULL, digest VARCHAR(64) NOT NULL, author_id VARCHAR(36) NOT NULL,
    source_run_id VARCHAR(36), restored_from INTEGER, created_at VARCHAR(32) NOT NULL,
    PRIMARY KEY(document_id,version), FOREIGN KEY(document_id) REFERENCES documents(id))`,
  `CREATE TABLE IF NOT EXISTS confirmations (
    id VARCHAR(36) PRIMARY KEY, case_id VARCHAR(36) NOT NULL, document_id VARCHAR(36) NOT NULL,
    document_version INTEGER NOT NULL, digest VARCHAR(64) NOT NULL, case_revision INTEGER NOT NULL,
    user_id VARCHAR(36) NOT NULL, note TEXT NOT NULL, expires_at VARCHAR(32) NOT NULL,
    FOREIGN KEY(case_id) REFERENCES cases(id))`,
  `CREATE TABLE IF NOT EXISTS commands (
    id VARCHAR(36) PRIMARY KEY, case_id VARCHAR(36) NOT NULL, user_id VARCHAR(36) NOT NULL,
    request_digest VARCHAR(64) NOT NULL, receipt_json TEXT NOT NULL, created_at VARCHAR(32) NOT NULL,
    FOREIGN KEY(case_id) REFERENCES cases(id))`,
  `CREATE TABLE IF NOT EXISTS events (
    id VARCHAR(36) PRIMARY KEY, org_id VARCHAR(36) NOT NULL, case_id VARCHAR(36) NOT NULL,
    seq INTEGER NOT NULL, type VARCHAR(64) NOT NULL, actor_id VARCHAR(36) NOT NULL,
    data_json TEXT NOT NULL, created_at VARCHAR(32) NOT NULL, UNIQUE(case_id,seq),
    FOREIGN KEY(case_id) REFERENCES cases(id))`
];
