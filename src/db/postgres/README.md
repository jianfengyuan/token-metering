# PostgreSQL 初始化脚本

`init.sql` 是本项目唯一数据库初始化脚本，包含表结构、索引与默认种子数据。

## 执行方式

```bash
# 直接执行
psql "postgresql://<user>:<password>@<host>:<port>/<database>" -f init.sql

# 或本地快速起一个 PostgreSQL 验证（Docker）
docker run -d --name tm-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
psql "postgresql://postgres:postgres@localhost:5432/postgres" -f init.sql
```

脚本整体幂等（`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`），可安全重复执行。

## 默认 API Key 说明

种子数据中 `api_keys.key_hash` 写入的是开发默认 Key `tm_default_dev_key` 的 sha256 摘要（与应用层 `hashApiKey()` 算法一致）。生产环境请使用强随机 Key 并替换 `key_hash` / `key_prefix`：

```bash
printf '<你的原始API Key>' | shasum -a 256    # macOS
printf '<你的原始API Key>' | sha256sum        # Linux
```

## 部署

部署编排文件位于项目根目录 `deploy/postgres/`：

- `docker-compose.yml` — PostgreSQL 服务编排（数据卷持久化、健康检查、首次启动自动执行 `init.sql`）
- `.env.example` — 环境变量示例（用户/密码/库名/端口/镜像版本）
- `deploy.sh` — 运维脚本封装（启动/停止/状态/重跑 init/备份/恢复/清理）

### 本地启动

```bash
cd deploy/postgres
cp .env.example .env
./deploy.sh up
./deploy.sh status
./deploy.sh psql
./deploy.sh reinit
./deploy.sh backup
./deploy.sh restore backups/xxx.dump
./deploy.sh down
./deploy.sh clean
```

注意：`init.sql` 挂载到 `/docker-entrypoint-initdb.d/`，仅在数据卷首次初始化时自动执行；后续变更可用 `./deploy.sh reinit`。

### 生产部署注意事项

- `PG_PASSWORD` 请使用强随机密码，并通过部署机密钥管理系统维护。
- 建议定期执行 `./deploy.sh backup`，并演练 `restore` 验证备份可用性。
- `down` 不会删除数据卷；`clean` 会删除容器与数据卷，请谨慎使用。
- 推荐将 `PG_IMAGE` 固定到明确版本，并按 PostgreSQL 官方流程执行大版本升级。
