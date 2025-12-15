# Z-Image Turbo API

> 基于 Cloudflare Workers 的 AI 图像生成 API
> 兼容 OpenAI 格式，支持 Cherry Studio / NextChat 等客户端

[![Deploy to Cloudflare Workers](https://img.shields.io/badge/部署到-Cloudflare%20Workers-FF5F1F?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/Version-2.3.0-green?style=flat-square)](https://github.com/aliom-v/zimage-turbo-api)

## 功能特性

- **OpenAI 兼容** - 支持 `/v1/images/generations` 和 `/v1/chat/completions`
- **流式响应** - SSE 实时进度反馈
- **简洁 WebUI** - 内置可视化界面，支持亮/暗主题切换
- **零成本部署** - Cloudflare Workers 免费额度

## 快速部署

### 方式一：Wrangler CLI

```bash
# 克隆仓库
git clone https://github.com/aliom-v/zimage-turbo-api.git
cd zimage-turbo-api

# 安装 wrangler
npm install -g wrangler

# 登录 Cloudflare
wrangler login

# 部署
wrangler deploy
```

### 方式二：Cloudflare Dashboard

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages** → **Create Application** → **Create Worker**
3. 复制 `worker.js` 内容到编辑器
4. 点击 **Save and Deploy**

## 使用方法

### WebUI

直接访问 Worker 域名即可使用可视化界面。

### API 调用

```bash
# 图像生成
curl -X POST https://your-worker.workers.dev/v1/images/generations \
  -H "Authorization: Bearer 1" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a cute cat", "size": "1024x1024"}'

# Chat 模式 (流式)
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer 1" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "画一只猫"}], "stream": true}'
```

### 客户端配置

**Cherry Studio / NextChat:**

```
API 地址: https://your-worker.workers.dev/v1
API Key: 1
模型: z-image-turbo
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | WebUI 界面 |
| `/v1/images/generations` | POST | 图像生成 |
| `/v1/chat/completions` | POST | Chat 模式 |
| `/v1/models` | GET | 模型列表 |
| `/v1/health` | GET | 健康检查 |

## 配置

修改 `worker.js` 中的 `CONFIG` 对象：

```javascript
const CONFIG = {
  API_MASTER_KEY: "1",        // API 密钥
  DEFAULT_STEPS: 8,           // 默认生成步数
  DEFAULT_SIZE: "1024x1024",  // 默认尺寸
  // ...
};
```

## 许可证

[Apache License 2.0](./LICENSE)

## 链接

- **GitHub**: [https://github.com/aliom-v/zimage-turbo-api](https://github.com/aliom-v/zimage-turbo-api)
