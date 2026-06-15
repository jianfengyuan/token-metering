#!/usr/bin/env bash
# ============================================================================
# token-metering PostgreSQL 部署/运维脚本
# ============================================================================
# 用法：./deploy.sh <command> [args]
#
# 命令：
#   up               启动 PostgreSQL（后台运行，等待健康检查通过）
#   down             停止并移除容器（保留数据卷）
#   status           查看容器与健康检查状态
#   logs             跟踪容器日志
#   psql             进入交互式 psql 会话
#   reinit           手动重跑 init.sql（脚本幂等，可安全重复执行）
#   backup           用 pg_dump 备份到 backups/<库名>_<时间戳>.dump（自定义格式）
#   restore <file>   用 pg_restore 从 dump 文件恢复（--clean --if-exists）
#   clean            停止并删除容器与数据卷（危险：数据会丢失，需确认）
#
# 所有命令幂等可重复执行。配置来自同目录 .env（参考 .env.example）。
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

INIT_SQL="$SCRIPT_DIR/../../src/db/postgres/init.sql"
BACKUP_DIR="$SCRIPT_DIR/backups"

# ---------------------------------------------------------------------------
# 环境检查与配置加载
# ---------------------------------------------------------------------------
if [[ ! -f .env ]]; then
  echo "错误：缺少 .env 文件。请先执行：cp .env.example .env 并修改其中的密码。" >&2
  exit 1
fi

# 导出 .env 中的变量供本脚本使用（docker compose 会自行读取 .env）
set -a
# shellcheck disable=SC1091
source .env
set +a

PG_USER="${PG_USER:-token_metering}"
PG_DATABASE="${PG_DATABASE:-token_metering}"

compose() {
  docker compose "$@"
}

# 在容器内以 postgres 服务身份执行命令
pg_exec() {
  compose exec -T postgres "$@"
}

wait_healthy() {
  echo "等待 PostgreSQL 健康检查通过..."
  local i
  for i in $(seq 1 30); do
    local status
    status="$(docker inspect --format '{{.State.Health.Status}}' \
      "$(compose ps -q postgres)" 2>/dev/null || echo "unknown")"
    if [[ "$status" == "healthy" ]]; then
      echo "PostgreSQL 已就绪。"
      return 0
    fi
    sleep 2
  done
  echo "错误：等待健康检查超时，请用 './deploy.sh logs' 查看日志。" >&2
  return 1
}

cmd_up() {
  compose up -d
  wait_healthy
}

cmd_down() {
  compose down
}

cmd_status() {
  compose ps
}

cmd_logs() {
  compose logs -f postgres
}

cmd_psql() {
  compose exec postgres psql -U "$PG_USER" -d "$PG_DATABASE"
}

cmd_reinit() {
  if [[ ! -f "$INIT_SQL" ]]; then
    echo "错误：找不到 $INIT_SQL" >&2
    exit 1
  fi
  echo "重跑 init.sql（幂等）..."
  pg_exec psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DATABASE" < "$INIT_SQL"
  echo "完成。"
}

cmd_backup() {
  mkdir -p "$BACKUP_DIR"
  local out
  out="$BACKUP_DIR/${PG_DATABASE}_$(date +%Y%m%d_%H%M%S).dump"
  echo "备份到 $out ..."
  # -Fc 自定义格式：压缩、支持 pg_restore 选择性恢复
  pg_exec pg_dump -U "$PG_USER" -d "$PG_DATABASE" -Fc > "$out"
  echo "备份完成：$out ($(du -h "$out" | cut -f1))"
}

cmd_restore() {
  local file="${1:-}"
  if [[ -z "$file" || ! -f "$file" ]]; then
    echo "用法：./deploy.sh restore <dump文件路径>" >&2
    exit 1
  fi
  echo "从 $file 恢复到数据库 $PG_DATABASE ..."
  # --clean --if-exists：先删除已存在对象再重建，保证可重复执行
  pg_exec pg_restore --clean --if-exists -U "$PG_USER" -d "$PG_DATABASE" < "$file"
  echo "恢复完成。"
}

cmd_clean() {
  echo "警告：将删除容器与数据卷，所有数据库数据会丢失！"
  read -r -p "输入 yes 确认: " answer
  if [[ "$answer" == "yes" ]]; then
    compose down -v
    echo "已清理容器与数据卷。"
  else
    echo "已取消。"
  fi
}

usage() {
  sed -n '4,18p' "$0"
}

case "${1:-}" in
  up)      cmd_up ;;
  down)    cmd_down ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  psql)    cmd_psql ;;
  reinit)  cmd_reinit ;;
  backup)  cmd_backup ;;
  restore) shift; cmd_restore "$@" ;;
  clean)   cmd_clean ;;
  *)       usage; exit 1 ;;
esac
