# Token Metering MVP (Node.js + TypeScript)

一个可本地运行的模型 token 计量框架，支持：

- `/chat`：统一模型调用入口（provider 抽象）
- `/usage`：用量与成本查询（明细 + 日聚合）
- `/simulator/v1/*`：本地 OpenAI 兼容模拟接口（无运营商时可直接开发）

## 快速开始

```bash
npm install
npm run dev
```

默认启动端口：`3000`

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

## 调用示例

### 1) 用本地模拟运营商调用 `/chat`

```bash
curl -X POST http://127.0.0.1:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId":"u-1",
    "provider":"local-simulator",
    "model":"sim-local",
    "messages":[{"role":"user","content":"给我一段 hello world"}]
  }'
```

### 2) 查询使用情况

```bash
curl "http://127.0.0.1:3000/usage?userId=u-1"
```

## Provider 说明

- `local-simulator`：调用本服务内置的 OpenAI 兼容模拟接口
- `local-ollama`：调用本机 Ollama OpenAI 兼容接口（`OLLAMA_BASE_URL`）
- `local-mock`：纯内存 mock provider（无网络依赖）

## 环境变量

可参考 `.env.example`：

- `PORT`
- `DATABASE_PATH`
- `LOCAL_SIMULATOR_BASE_URL`
- `LOCAL_SIMULATOR_API_KEY`
- `OLLAMA_BASE_URL`
- `OLLAMA_API_KEY`
