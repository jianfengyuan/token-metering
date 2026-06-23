-- ============================================================================
-- token-metering PostgreSQL 初始化脚本（DDL + 种子数据）
-- ============================================================================
--
-- 用途：
--   作为 token-metering 的统一 PostgreSQL 初始化脚本。
--
-- 执行方式：
--   psql "postgresql://<user>:<password>@<host>:<port>/<database>" -f init.sql
--   或在已连接的 psql 会话中： \i init.sql
--
-- 幂等性：
--   全部 DDL 使用 IF NOT EXISTS，种子数据使用 ON CONFLICT DO NOTHING，
--   可安全地重复执行。
--
-- 设计说明：
--   1. 时间字段使用 TIMESTAMPTZ，金额字段使用 NUMERIC(18, 6)。
--   2. usage_events / audit_events 主键使用 BIGINT IDENTITY。
--   3. model_provider_routes.is_active 使用 BOOLEAN。
--   4. audit_events.metadata_json 使用 JSONB。
--   5. usage_daily_rollups.date 使用 DATE。
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 兼容旧表名迁移（provider_configs / model_routes -> 新表名）
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'provider_configs'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'upstream_providers'
  ) THEN
    ALTER TABLE provider_configs RENAME TO upstream_providers;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'model_routes'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'model_provider_routes'
  ) THEN
    ALTER TABLE model_routes RENAME TO model_provider_routes;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 表结构
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT,
  platform_role TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL DEFAULT 'member',
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  scope        TEXT NOT NULL DEFAULT '*',
  created_by   TEXT REFERENCES users(id),
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  last_used_ip TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 兼容已有数据库：为 api_keys 追加 P0/P1 列
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_by   TEXT REFERENCES users(id);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_ip TEXT;

CREATE TABLE IF NOT EXISTS project_quotas (
  project_id  TEXT PRIMARY KEY REFERENCES projects(id),
  token_limit BIGINT NOT NULL DEFAULT 1000000,
  token_used  BIGINT NOT NULL DEFAULT 0,
  -- 金额使用 NUMERIC 避免浮点误差
  cost_limit  NUMERIC(18, 6) NOT NULL DEFAULT 1000,
  cost_used   NUMERIC(18, 6) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_provider_routes (
  model          TEXT PRIMARY KEY,
  provider_id    TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  -- 路由激活状态使用原生 BOOLEAN
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS upstream_providers (
  provider_id   TEXT PRIMARY KEY,
  provider_type TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  -- TODO: 生产环境建议改为 secret_ref，避免明文存储
  api_key       TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_events (
  id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id                  TEXT NOT NULL,
  tenant_id                   TEXT NOT NULL DEFAULT 'tenant-default',
  project_id                  TEXT NOT NULL DEFAULT 'project-default',
  api_key_id                  TEXT NOT NULL DEFAULT 'api-key-default',
  user_id                     TEXT NOT NULL,
  provider                    TEXT NOT NULL,
  model                       TEXT NOT NULL,
  tokenizer_type              TEXT NOT NULL DEFAULT 'tiktoken',
  prompt_tokens_estimated     BIGINT NOT NULL DEFAULT 0,
  completion_tokens_estimated BIGINT NOT NULL DEFAULT 0,
  prompt_tokens_actual        BIGINT NOT NULL DEFAULT 0,
  completion_tokens_actual    BIGINT NOT NULL DEFAULT 0,
  total_tokens_actual         BIGINT NOT NULL DEFAULT 0,
  currency                    TEXT NOT NULL DEFAULT 'USD',
  cost_input                  NUMERIC(18, 6) NOT NULL DEFAULT 0,
  cost_output                 NUMERIC(18, 6) NOT NULL DEFAULT 0,
  cost_total                  NUMERIC(18, 6) NOT NULL DEFAULT 0,
  latency_ms                  INTEGER NOT NULL DEFAULT 0,
  status                      TEXT NOT NULL,
  error_code                  TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_daily_rollups (
  -- SQLite 版本为 TEXT（YYYY-MM-DD），这里使用 DATE 类型
  date              DATE NOT NULL,
  tenant_id         TEXT NOT NULL DEFAULT 'tenant-default',
  project_id        TEXT NOT NULL DEFAULT 'project-default',
  user_id           TEXT NOT NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_tokens     BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens      BIGINT NOT NULL DEFAULT 0,
  cost_total        NUMERIC(18, 6) NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'USD',
  PRIMARY KEY (date, tenant_id, project_id, user_id, provider, model)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type    TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  request_id    TEXT,
  tenant_id     TEXT,
  project_id    TEXT,
  api_key_id    TEXT,
  provider      TEXT,
  model         TEXT,
  method        TEXT,
  path          TEXT,
  error_code    TEXT,
  message       TEXT,
  -- SQLite 版本为 TEXT，这里使用 JSONB 便于查询
  metadata_json JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 索引（与 SQLite 版本语义一致）
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_projects_tenant_id ON projects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_members_user_id ON tenant_members(user_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_api_keys_project_id ON api_keys(project_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);
CREATE INDEX IF NOT EXISTS idx_model_provider_routes_active ON model_provider_routes(is_active);
CREATE INDEX IF NOT EXISTS idx_upstream_providers_active ON upstream_providers(is_active);

CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_time ON usage_events(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_project_time ON usage_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_user_time ON usage_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_provider_model ON usage_events(provider, model);

CREATE INDEX IF NOT EXISTS idx_rollups_tenant_date ON usage_daily_rollups(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_rollups_project_date ON usage_daily_rollups(project_id, date);
CREATE INDEX IF NOT EXISTS idx_rollups_user_date ON usage_daily_rollups(user_id, date);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_event_type ON audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_id ON audit_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_request_id ON audit_events(request_id);

-- ----------------------------------------------------------------------------
-- 种子数据（对应 AccessRepository.seedDefaults，幂等）
-- ----------------------------------------------------------------------------
-- 注意：upstream_providers / model_provider_routes 不再提供默认种子，请在启动服务前执行
-- `npm run init:platform -- ./platform.init.json` 完成平台初始化。

INSERT INTO tenants (id, name, status, created_at)
VALUES ('tenant-default', 'Default Tenant', 'active', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO projects (id, tenant_id, name, status, created_at)
VALUES ('project-default', 'tenant-default', 'Default Project', 'active', now())
ON CONFLICT (id) DO NOTHING;

-- 默认 API Key：
--   key_hash 是原始 API Key 的 sha256 十六进制摘要（小写），与应用层
--   hashApiKey()（src/repositories/accessRepository.ts）保持一致。
--   部署方应自行生成强随机 API Key 并替换下面的 key_hash / key_prefix：
--     printf '<你的原始API Key>' | shasum -a 256        # macOS
--     printf '<你的原始API Key>' | sha256sum            # Linux
--   下面的占位值对应开发用默认 Key "tm_default_dev_key"（FALLBACK_API_KEY），
--   仅供本地/开发环境使用，生产环境务必替换。
INSERT INTO api_keys (id, project_id, key_hash, key_prefix, status, scope, created_at)
VALUES (
  'api-key-default',
  'project-default',
  'e5f4c5d5800b6962562bdab3b99e8d105470665d7d1b2326fe3fc2cb95bc8e4d', -- sha256('tm_default_dev_key')，生产环境请替换
  'tm_defau',                                                         -- 原始 Key 的前 8 个字符
  'active',
  'chat.write,usage.read',
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO project_quotas (project_id, token_limit, token_used, cost_limit, cost_used, updated_at)
VALUES ('project-default', 1000000, 0, 1000, 0, now())
ON CONFLICT (project_id) DO NOTHING;

COMMIT;
