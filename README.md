# Token Metering MVP (Node.js + TypeScript)

一个可本地运行的模型 token 计量框架，支持：

- `/chat`：统一模型调用入口（provider 抽象，默认流式透传）
- `/usage`：用量与成本查询（明细 + 日聚合）
- `/simulator/v1/*`：本地 OpenAI 兼容模拟接口（无运营商时可直接开发）
- `/admin/v1/*`：最小管理 API（创建租户/项目/API Key、模型路由、审计事件、用量概览）
- `/console`：内置 Web 控制台（Chat 聊天页 + Admin 管理页）

## 快速开始

```bash
npm install
cp platform.init.example.json platform.init.json
npm run init:platform -- ./platform.init.json
npm run dev
```

默认启动端口：`3000`

注意：服务启动前必须先完成平台初始化（Provider + Model Routes）。未初始化时，服务会拒绝启动并提示执行 `npm run init:platform`。

数据库后端统一使用 PostgreSQL，启动前请设置：

```bash
export DATABASE_URL="postgresql://admin:admin@127.0.0.1:5432/token_metering"
```

也可不使用 `DATABASE_URL`，改用 `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_PASSWORD` / `PG_DATABASE`。

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

## Web 控制台

启动服务后访问 `http://127.0.0.1:3000/console/`：

- Chat 页：填入 API Key（开发默认 `tm_default_dev_key`）与模型，支持流式 SSE 渲染并显示 requestId。
- Admin 页：填入 Admin Token（开发默认 `tm_admin_dev_token`，可用 `ADMIN_TOKEN` 环境变量覆盖），可创建租户/项目/API Key、查看模型路由、用量概览与审计事件。

前端为纯静态文件（`public/console/`），由 Express 直接托管，无需构建步骤。

## 调用示例

### 1) 用本地模拟运营商调用 `/chat`（非流式）

```bash
curl -X POST http://127.0.0.1:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId":"u-1",
    "provider":"local-simulator",
    "model":"sim-local",
    "stream": false,
    "messages":[{"role":"user","content":"给我一段 hello world"}]
  }'
```

### 2) 默认流式调用 `/chat`

```bash
curl -N -X POST http://127.0.0.1:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId":"u-2",
    "provider":"local-simulator",
    "model":"sim-local",
    "messages":[{"role":"user","content":"请流式返回一段文本"}]
  }'
```

说明：
- `/chat` 默认 `stream=true`，会尽量原样透传上游 SSE 分片。
- 若客户端仍需一次性 JSON，可显式传 `stream:false`。

### 3) 查询使用情况

```bash
curl "http://127.0.0.1:3000/usage?userId=u-1"
```

## Token 估算说明

- 优先使用上游返回的真实 `usage`；无 `usage` 时按模型编码估算。
- OpenAI 系列模型默认使用 `js-tiktoken`，模型无法匹配时会回退到通用编码（`cl100k_base`）。
- 开源模型可通过 Hugging Face tokenizer 配置独立估算，例如 Gemma 使用其开源 `tokenizer.json` / `tokenizer_config.json`。
- 若本地缺少 tokenizer 文件且已配置仓库映射，服务会同步下载后再继续计数（首次请求会多一次下载耗时）。

示例：

```bash
export HF_TOKENIZER_PATHS='{"gemma":"./tokenizers/gemma/tokenizer.json"}'
export HF_TOKENIZER_CONFIG_PATHS='{"gemma":"./tokenizers/gemma/tokenizer_config.json"}'
export HF_TOKENIZER_REPOS='{"gemma":"google/gemma-2-2b-it"}'
export HF_TOKENIZER_REVISIONS='{"gemma":"main"}'
```

配置 key 会按模型名匹配，所以请求里的 `model: "gemma-2-2b"` 会命中 `gemma`。未配置仓库映射时，缺失文件不会自动下载，会回退到 `js-tiktoken`。

## Provider 与模型初始化（DB 配置版）

所有 Provider 与模型路由都存储在数据库中，不在运行时代码里写死。

可通过初始化脚本一次性导入：

```bash
npm run init:platform -- ./platform.init.json
```

`platform.init.json` 格式可参考 `platform.init.example.json`。

也可以在服务启动后用管理 API 增量维护：

先在数据库里配置 Provider（示例：OpenAI）：

```bash
curl -X POST http://127.0.0.1:3000/admin/v1/providers \
  -H "Authorization: Bearer tm_admin_dev_token" \
  -H "Content-Type: application/json" \
  -d '{
    "providerId":"openai",
    "providerType":"openai_compatible",
    "baseUrl":"https://api.openai.com/v1",
    "apiKey":"sk-..."
  }'
```

说明：
- `providerType` 当前支持 `openai_compatible`、`mock_local`

再配置模型路由（示例：把平台模型 `gpt-4o` 转发到该 Provider）：

```bash
curl -X POST http://127.0.0.1:3000/admin/v1/model-routes \
  -H "Authorization: Bearer tm_admin_dev_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-4o",
    "providerId":"openai",
    "providerModel":"gpt-4o"
  }'
```

## 环境变量

可参考 `.env.example`：

- `PORT`
- `DATABASE_URL`（PostgreSQL 连接串，优先级最高）
- `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_PASSWORD` / `PG_DATABASE` / `PG_POOL_MAX`（`DATABASE_URL` 未设置时生效）
- `ADMIN_TOKEN`（`/admin/v1` 管理 API 令牌，未设置时使用开发默认值 `tm_admin_dev_token`）
- `LOCAL_SIMULATOR_BASE_URL`
- `LOCAL_SIMULATOR_API_KEY`
- `OLLAMA_BASE_URL`
- `OLLAMA_API_KEY`
- `HF_TOKENIZER_PATHS`
- `HF_TOKENIZER_CONFIG_PATHS`
- `HF_TOKENIZER_REPOS`
- `HF_TOKENIZER_REVISIONS`
- `HF_TOKEN`（可选，私有或 gated 仓库）
