/**
 * =================================================================================
 * 项目: zimage-2api (Cloudflare Worker 单文件·全功能修复版)
 * 版本: 2.3.0 (代号: Turbo Cockpit - Ultimate)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-15
 *
 * [v2.3.0 优化日志]
 * 1. [性能优化] 添加请求重试机制，提高稳定性
 * 2. [功能增强] 支持 negative_prompt 负面提示词
 * 3. [功能增强] 添加 /v1/health 健康检查端点
 * 4. [代码质量] 添加请求速率限制 (基于内存)
 * 5. [代码质量] 添加结构化日志系统
 * 6. [UI/UX] 添加生成历史记录 (本地存储)
 * 7. [UI/UX] 添加图片下载功能
 * 8. [UI/UX] 添加键盘快捷键支持 (Ctrl+Enter 生成)
 * 9. [UI/UX] 优化移动端交互体验
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  PROJECT_NAME: "zimage-2api",
  PROJECT_VERSION: "2.3.0",

  // 安全配置 (API Key) - 建议在部署后修改
  API_MASTER_KEY: "1",

  // 上游服务配置
  UPSTREAM_URL: "https://z-image.62tool.com/api.php",
  ORIGIN_URL: "https://z-image.62tool.com",
  REFERER_URL: "https://z-image.62tool.com/",

  // 模型列表
  MODELS: ["z-image-turbo", "dall-e-3"],
  DEFAULT_MODEL: "z-image-turbo",

  // 默认参数
  DEFAULT_STEPS: 8,
  DEFAULT_SIZE: "1024x1024",

  // 轮询配置 (服务端模式)
  POLLING_INTERVAL: 1500,
  POLLING_TIMEOUT: 60000,
  STREAM_POLLING_INTERVAL: 1500,  // 流式模式轮询间隔
  NON_STREAM_POLLING_INTERVAL: 2000,  // 非流式模式轮询间隔

  // 重试配置
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,

  // 速率限制 (每分钟请求数)
  RATE_LIMIT: 30,
  RATE_LIMIT_WINDOW: 60000,

  // 伪装指纹池
  USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
  ]
};

// --- [速率限制器 (内存实现)] ---
const rateLimiter = {
  requests: new Map(),

  check(clientId) {
    const now = Date.now();
    const windowStart = now - CONFIG.RATE_LIMIT_WINDOW;

    // 清理过期记录
    if (!this.requests.has(clientId)) {
      this.requests.set(clientId, []);
    }

    const clientRequests = this.requests.get(clientId).filter(t => t > windowStart);
    this.requests.set(clientId, clientRequests);

    if (clientRequests.length >= CONFIG.RATE_LIMIT) {
      return false;
    }

    clientRequests.push(now);
    return true;
  },

  getRemaining(clientId) {
    const requests = this.requests.get(clientId) || [];
    const windowStart = Date.now() - CONFIG.RATE_LIMIT_WINDOW;
    const validRequests = requests.filter(t => t > windowStart);
    return Math.max(0, CONFIG.RATE_LIMIT - validRequests.length);
  }
};

// --- [结构化日志系统] ---
const Logger = {
  _format(level, message, data = {}) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...data
    });
  },

  info(message, data) { console.log(this._format('INFO', message, data)); },
  warn(message, data) { console.warn(this._format('WARN', message, data)); },
  error(message, data) { console.error(this._format('ERROR', message, data)); }
};

// --- [第二部分: Worker 入口] ---
export default {
  /**
   * @param {Request} request
   * @param {Object} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    const url = new URL(request.url);
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 速率限制检查 (排除静态页面和健康检查)
    if (url.pathname.startsWith('/v1/') && url.pathname !== '/v1/health' && url.pathname !== '/v1/models') {
      if (!rateLimiter.check(clientIP)) {
        Logger.warn('Rate limit exceeded', { clientIP, path: url.pathname });
        return createErrorResponse('Rate limit exceeded. Please slow down.', 429, 'rate_limit_exceeded');
      }
    }

    // 路由分发
    if (url.pathname === '/') return handleUI(request, apiKey);
    if (url.pathname === '/v1/health') return handleHealthCheck();
    if (url.pathname === '/v1/models') return handleModelsRequest();
    if (url.pathname === '/v1/images/generations') return handleImageGenerations(request, apiKey);

    // 显式传递 ctx 给 handleChatCompletions
    if (url.pathname === '/v1/chat/completions') return handleChatCompletions(request, apiKey, ctx);

    // [WebUI 专用] 状态查询接口
    if (url.pathname === '/v1/query/status') return handleStatusQuery(request, apiKey);

    return createErrorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: 核心业务逻辑] ---

class IdentityForge {
  // 使用 crypto API 生成更高效的随机十六进制字符串
  static generateHex(length) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
  }

  static getHeaders() {
    const ua = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
    // 动态生成 Session 和 百度统计 ID
    const sessionCookie = this.generateHex(32);
    const hmAccount = this.generateHex(16).toUpperCase();
    const timestamp = Math.floor(Date.now() / 1000);
    
    const cookie = `server_name_session=${sessionCookie}; Hm_lvt_2348c268e6bf5008b52f68ddd772f997=${timestamp}; Hm_lpvt_2348c268e6bf5008b52f68ddd772f997=${timestamp}; HMACCOUNT=${hmAccount}`;

    return {
      "Authority": "z-image.62tool.com",
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Content-Type": "application/json",
      "Origin": CONFIG.ORIGIN_URL,
      "Referer": CONFIG.REFERER_URL,
      "User-Agent": ua,
      "Cookie": cookie
    };
  }

  static generateTaskId() {
    return `task_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  }
}

/**
 * 带重试的 fetch 请求
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} retries
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, retries = CONFIG.MAX_RETRIES) {
    let lastError;
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, options);
            if (res.ok || res.status < 500) return res;
            throw new Error(`HTTP ${res.status}`);
        } catch (e) {
            lastError = e;
            if (i < retries) {
                Logger.warn('Request failed, retrying', { attempt: i + 1, error: e.message });
                await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY * (i + 1)));
            }
        }
    }
    throw lastError;
}

/**
 * 提交生成任务
 * @param {string} prompt - 正面提示词
 * @param {Object} params - 参数对象
 * @param {string} params.size - 图像尺寸
 * @param {number} params.steps - 生成步数
 * @param {number} params.seed - 随机种子
 * @param {string} params.negative_prompt - 负面提示词
 * @returns {Promise<Object>} { taskId, headers, success }
 */
async function submitTask(prompt, params = {}) {
    const headers = IdentityForge.getHeaders();
    const taskId = IdentityForge.generateTaskId();

    // 构建完整提示词 (如果有负面提示词)
    let fullPrompt = prompt;
    if (params.negative_prompt) {
        fullPrompt = `${prompt} --no ${params.negative_prompt}`;
    }

    const payload = {
        "action": "create",
        "task_id": taskId,
        "task_type": "text2img-z-image",
        "task_data": {
            "prompt": fullPrompt,
            "size": params.size || CONFIG.DEFAULT_SIZE,
            "seed": params.seed || Math.floor(Math.random() * 1000000),
            "steps": params.steps || CONFIG.DEFAULT_STEPS,
            "randomized": params.seed ? false : true
        },
        "status": 0
    };

    Logger.info('Submitting task', { taskId, prompt: prompt.slice(0, 50) });

    const res = await fetchWithRetry(CONFIG.UPSTREAM_URL, {
        method: "POST", headers: headers, body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`Create Failed: ${res.status}`);
    const data = await res.json();

    if (!data.success) throw new Error(`API Refused: ${data.message}`);

    Logger.info('Task submitted', { taskId });
    return { taskId, headers }; // 返回 headers 是因为查询时需要保持 Session 一致
}

/**
 * 查询任务状态
 */
async function queryTask(taskId, headers) {
    const payload = { "action": "query", "task_ids": [taskId] };
    const res = await fetch(CONFIG.UPSTREAM_URL, {
        method: "POST", headers: headers, body: JSON.stringify(payload)
    });

    if (!res.ok) return { status: 'retry' };
    const data = await res.json();

    if (data.success && data.data?.tasks?.length > 0) {
        const task = data.data.tasks[0];
        // status: 0=queue, 1=running, 2=success, -1=fail
        if (task.status === 2 && task.res_data?.image_url) {
            return { status: 'success', url: task.res_data.image_url.replace(/\\\//g, '/') };
        }
        if (task.status === -1) return { status: 'failed', error: 'Generation failed' };
        return { status: 'processing', progress: task.status === 1 ? 50 : 10 };
    }
    return { status: 'retry' };
}

/**
 * 通用轮询函数 - 等待任务完成
 * @param {string} taskId - 任务ID
 * @param {Object} headers - 请求头
 * @param {Object} options - 轮询选项
 * @param {number} options.timeout - 超时时间(ms)
 * @param {number} options.interval - 轮询间隔(ms)
 * @param {Function} options.onProgress - 进度回调
 * @returns {Promise<{url: string}>}
 */
async function pollForResult(taskId, headers, options = {}) {
    const timeout = options.timeout || CONFIG.POLLING_TIMEOUT;
    const interval = options.interval || CONFIG.POLLING_INTERVAL;
    const onProgress = options.onProgress || (() => {});

    const startTime = Date.now();
    let iteration = 0;

    while (Date.now() - startTime < timeout) {
        await new Promise(r => setTimeout(r, interval));
        const result = await queryTask(taskId, headers);
        iteration++;

        if (result.status === 'success') {
            return { url: result.url };
        }
        if (result.status === 'failed') {
            throw new Error(result.error || 'Generation failed');
        }

        // 调用进度回调
        onProgress({ iteration, elapsed: Date.now() - startTime });
    }

    throw new Error('Timeout: Image generation took too long');
}

// --- [API Handlers] ---

async function handleImageGenerations(request, apiKey) {
    if (!verifyAuth(request, apiKey)) return createErrorResponse('Unauthorized', 401, 'unauthorized');

    try {
        const body = await request.json();
        const prompt = body.prompt;

        if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
            return createErrorResponse('Missing or invalid prompt', 400, 'invalid_request');
        }

        // 提取自定义参数
        const size = body.size || CONFIG.DEFAULT_SIZE;
        const steps = body.steps || body.n_steps || CONFIG.DEFAULT_STEPS;
        const seed = body.seed ? parseInt(body.seed) : null;
        const negativePrompt = body.negative_prompt || null;
        const clientPoll = body.client_poll === true; // WebUI 专用标记

        // 1. 提交任务
        const { taskId, headers } = await submitTask(prompt, { size, steps, seed, negative_prompt: negativePrompt });

        // [Mode A] 客户端轮询 (WebUI)
        if (clientPoll) {
            const authContext = btoa(JSON.stringify(headers));
            return new Response(JSON.stringify({
                status: "submitted",
                task_id: taskId,
                auth_context: authContext
            }), { headers: corsHeaders({'Content-Type': 'application/json'}) });
        }

        // [Mode B] 服务端轮询 (Standard API Client)
        const result = await pollForResult(taskId, headers);
        Logger.info('Generation completed', { taskId });
        return new Response(JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: [{ url: result.url }]
        }), { headers: corsHeaders({'Content-Type': 'application/json'}) });

    } catch (e) {
        Logger.error('Generation failed', { error: e.message });
        return createErrorResponse(e.message, 500, 'internal_error');
    }
}

// WebUI 专用的状态查询接口
async function handleStatusQuery(request, apiKey) {
    try {
        const body = await request.json();
        const { task_id, auth_context } = body;
        
        if (!task_id || !auth_context) throw new Error("Missing params");
        
        // 还原 Session Headers
        const headers = JSON.parse(atob(auth_context));
        const result = await queryTask(task_id, headers);
        
        return new Response(JSON.stringify(result), { headers: corsHeaders({'Content-Type': 'application/json'}) });
    } catch (e) {
        return createErrorResponse(e.message, 400, 'query_error');
    }
}

/**
 * 完美适配 Cherry Studio / NextChat 的聊天接口
 * 通过流式响应返回 Markdown 图片
 * @param {Request} request
 * @param {string} apiKey
 * @param {ExecutionContext} ctx
 */
async function handleChatCompletions(request, apiKey, ctx) {
    if (!verifyAuth(request, apiKey)) return createErrorResponse('Unauthorized', 401, 'unauthorized');

    const requestId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    try {
        const body = await request.json();
        const lastMsg = body.messages?.[body.messages.length - 1];
        if (!lastMsg?.content) {
            return createErrorResponse('No valid message content provided', 400, 'invalid_request');
        }

        const prompt = lastMsg.content;
        const model = body.model || CONFIG.DEFAULT_MODEL;
        const stream = body.stream !== false; // 默认为流式

        // 提交生成任务
        const { taskId, headers } = await submitTask(prompt, { size: CONFIG.DEFAULT_SIZE });

        // 如果客户端不支持流式，退回等待模式
        if (!stream) {
            const result = await pollForResult(taskId, headers, {
                interval: CONFIG.NON_STREAM_POLLING_INTERVAL
            });
            const content = `![Generated Image](${result.url})\n\n**Prompt:** ${prompt}`;
            return new Response(JSON.stringify({
                id: requestId,
                object: "chat.completion",
                created: created,
                model: model,
                choices: [{ index: 0, message: { role: "assistant", content: content }, finish_reason: "stop" }]
            }), { headers: corsHeaders({'Content-Type': 'application/json'}) });
        }

        // 开启流式响应 (SSE) - 专为 Cherry Studio 优化
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        const sendChunk = async (content, finish_reason = null) => {
            const chunk = {
                id: requestId,
                object: "chat.completion.chunk",
                created: created,
                model: model,
                choices: [{ index: 0, delta: { content: content }, finish_reason: finish_reason }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        // 在后台处理轮询，不阻塞主线程
        ctx.waitUntil((async () => {
            try {
                // 1. 发送初始状态
                await sendChunk("🎨 正在请求 Z-Image 引擎生成图片...\n\n> " + prompt + "\n\n");

                // 2. 使用通用轮询函数，带进度回调
                const result = await pollForResult(taskId, headers, {
                    interval: CONFIG.STREAM_POLLING_INTERVAL,
                    onProgress: async ({ iteration }) => {
                        // 每2次轮询发送一个进度点，保持连接活跃
                        if (iteration % 2 === 0) await sendChunk("·");
                    }
                });

                // 3. 发送最终图片 Markdown
                await sendChunk(`\n\n![Generated Image](${result.url})`);

                // 4. 发送结束信号
                await sendChunk("", "stop");
                await writer.write(encoder.encode("data: [DONE]\n\n"));

            } catch (error) {
                await sendChunk(`\n\n❌ **错误**: ${error.message}`, "stop");
                await writer.write(encoder.encode("data: [DONE]\n\n"));
            } finally {
                await writer.close();
            }
        })());

        return new Response(readable, {
            headers: corsHeaders({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            })
        });

    } catch (e) {
        return createErrorResponse(e.message, 500, 'error');
    }
}

// --- 辅助函数 ---
function verifyAuth(req, key) {
    if (key === "1") return true;
    const h = req.headers.get('Authorization');
    return h && h === `Bearer ${key}`;
}
function corsHeaders(h={}) {
    return { ...h, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' };
}
function handleCorsPreflight() { return new Response(null, { status: 204, headers: corsHeaders() }); }
function createErrorResponse(msg, status, code) {
    return new Response(JSON.stringify({ error: { message: msg, code } }), { status, headers: corsHeaders({'Content-Type': 'application/json'}) });
}
function handleModelsRequest() {
    return new Response(JSON.stringify({ object: 'list', data: CONFIG.MODELS.map(id => ({ id, object: 'model', created: Date.now(), owned_by: 'zimage' })) }), { headers: corsHeaders({'Content-Type': 'application/json'}) });
}
function handleHealthCheck() {
    return new Response(JSON.stringify({
        status: 'healthy',
        version: CONFIG.PROJECT_VERSION,
        timestamp: new Date().toISOString(),
        uptime: process.uptime ? process.uptime() : 'N/A'
    }), { headers: corsHeaders({'Content-Type': 'application/json'}) });
}


// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Z-Image Turbo API</title>
    <style>
        :root {
            /* 背景色系统 */
            --bg-primary: #0a0a0b;
            --bg-secondary: #131316;
            --bg-elevated: #1a1a1f;
            --bg-hover: #222228;
            --bg-active: #2a2a32;

            /* 文字色系统 */
            --text-primary: #f0f0f3;
            --text-secondary: #a0a0ab;
            --text-tertiary: #6b6b76;
            --text-disabled: #4a4a52;

            /* 品牌色 */
            --accent-primary: #6366f1;
            --accent-hover: #4f46e5;
            --accent-active: #4338ca;
            --accent-glow: rgba(99, 102, 241, 0.3);

            /* 功能色 */
            --success: #10b981;
            --error: #ef4444;

            /* 边框色 */
            --border-subtle: rgba(255, 255, 255, 0.06);
            --border-default: rgba(255, 255, 255, 0.1);
            --border-strong: rgba(255, 255, 255, 0.15);

            /* 阴影系统 */
            --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
            --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -2px rgba(0, 0, 0, 0.3);
            --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.4);
            --shadow-glow: 0 0 20px rgba(99, 102, 241, 0.4), 0 0 40px rgba(99, 102, 241, 0.2);

            /* 间距系统 */
            --space-1: 0.25rem;
            --space-2: 0.5rem;
            --space-3: 0.75rem;
            --space-4: 1rem;
            --space-5: 1.5rem;
            --space-6: 2rem;
            --space-8: 3rem;

            /* 圆角系统 */
            --radius-sm: 0.375rem;
            --radius-md: 0.5rem;
            --radius-lg: 0.75rem;
            --radius-xl: 1rem;
            --radius-full: 9999px;

            /* 动画系统 */
            --transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
            --transition-base: 250ms cubic-bezier(0.4, 0, 0.2, 1);
            --transition-slow: 350ms cubic-bezier(0.4, 0, 0.2, 1);

            /* 布局约束 */
            --content-max-width: 900px;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        html { background: var(--bg-primary); color-scheme: dark; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
            font-size: 1rem;
            line-height: 1.5;
            color: var(--text-primary);
            background: var(--bg-primary);
            -webkit-font-smoothing: antialiased;
            min-height: 100vh;
        }

        /* 滚动条美化 */
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: var(--bg-secondary); }
        ::-webkit-scrollbar-thumb { background: var(--bg-hover); border-radius: var(--radius-full); }
        ::-webkit-scrollbar-thumb:hover { background: var(--bg-active); }

        /* 顶部导航栏 */
        .header {
            position: sticky;
            top: 0;
            z-index: 50;
            background: rgba(10, 10, 11, 0.85);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border-bottom: 1px solid var(--border-subtle);
            padding: var(--space-4) var(--space-5);
        }

        .header-inner {
            max-width: var(--content-max-width);
            margin: 0 auto;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .logo-section {
            display: flex;
            align-items: center;
            gap: var(--space-3);
        }

        .logo-icon {
            width: 36px;
            height: 36px;
            background: linear-gradient(135deg, var(--accent-primary), var(--accent-hover));
            border-radius: var(--radius-md);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.25rem;
            box-shadow: var(--shadow-md);
        }

        .logo-title {
            font-size: 1.25rem;
            font-weight: 600;
            color: var(--text-primary);
            letter-spacing: -0.02em;
        }

        .badge {
            display: inline-flex;
            align-items: center;
            padding: var(--space-1) var(--space-3);
            background: var(--bg-elevated);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-full);
            font-size: 0.75rem;
            font-weight: 500;
            color: var(--text-secondary);
            transition: all var(--transition-fast);
        }

        .badge:hover {
            border-color: var(--accent-primary);
            color: var(--accent-primary);
        }

        /* 主内容区 */
        .main-content {
            max-width: var(--content-max-width);
            margin: 0 auto;
            padding: var(--space-6) var(--space-4);
            display: flex;
            flex-direction: column;
            gap: var(--space-5);
        }

        /* 卡片基础样式 */
        .card {
            background: var(--bg-elevated);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-xl);
            padding: var(--space-5);
            transition: all var(--transition-base);
            box-shadow: var(--shadow-sm);
        }

        .card:hover {
            border-color: var(--border-strong);
            box-shadow: var(--shadow-md);
        }

        .card-header {
            display: flex;
            align-items: center;
            gap: var(--space-2);
            margin-bottom: var(--space-4);
        }

        .card-title {
            font-size: 0.9rem;
            font-weight: 600;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            gap: var(--space-2);
        }

        /* 预览区 */
        .preview-card {
            min-height: 380px;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
        }

        .preview-image {
            max-width: 100%;
            max-height: 500px;
            border-radius: var(--radius-lg);
            box-shadow: var(--shadow-lg);
            animation: fadeInScale 0.5s ease-out;
            cursor: pointer;
            transition: transform var(--transition-base);
        }

        .preview-image:hover {
            transform: scale(1.02);
        }

        @keyframes fadeInScale {
            from { opacity: 0; transform: scale(0.95); }
            to { opacity: 1; transform: scale(1); }
        }

        .preview-placeholder {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: var(--space-4);
            color: var(--text-tertiary);
        }

        .placeholder-icon {
            width: 100px;
            height: 100px;
            background: var(--bg-secondary);
            border: 2px dashed var(--border-default);
            border-radius: var(--radius-lg);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 2.5rem;
            opacity: 0.6;
        }

        .placeholder-text {
            font-size: 1rem;
            font-weight: 500;
        }

        .placeholder-hint {
            font-size: 0.875rem;
            color: var(--text-disabled);
        }

        /* 提示词输入框 */
        .prompt-card:focus-within {
            border-color: var(--accent-primary);
            box-shadow: 0 0 0 3px var(--accent-glow);
        }

        .prompt-textarea {
            width: 100%;
            min-height: 100px;
            padding: var(--space-4);
            background: var(--bg-secondary);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-lg);
            color: var(--text-primary);
            font-family: inherit;
            font-size: 1rem;
            line-height: 1.6;
            resize: vertical;
            transition: all var(--transition-fast);
        }

        .prompt-textarea:focus {
            outline: none;
            background: var(--bg-elevated);
            border-color: var(--accent-primary);
        }

        .prompt-textarea::placeholder {
            color: var(--text-tertiary);
        }

        /* 参数网格 */
        .parameters-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: var(--space-4);
        }

        @media (min-width: 640px) {
            .parameters-grid {
                grid-template-columns: repeat(3, 1fr);
            }
        }

        .param-card {
            background: var(--bg-elevated);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-lg);
            padding: var(--space-4);
            transition: all var(--transition-fast);
        }

        .param-card:hover {
            border-color: var(--border-strong);
            transform: translateY(-2px);
            box-shadow: var(--shadow-md);
        }

        .param-label {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 0.875rem;
            font-weight: 500;
            color: var(--text-secondary);
            margin-bottom: var(--space-3);
        }

        /* 下拉选择器 */
        .custom-select {
            width: 100%;
            padding: var(--space-3) var(--space-4);
            padding-right: var(--space-8);
            background: var(--bg-secondary);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
            color: var(--text-primary);
            font-size: 0.9375rem;
            cursor: pointer;
            transition: all var(--transition-fast);
            appearance: none;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b6b76' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 12px center;
        }

        .custom-select:hover {
            border-color: var(--accent-primary);
            background-color: var(--bg-hover);
        }

        .custom-select:focus {
            outline: none;
            border-color: var(--accent-primary);
            box-shadow: 0 0 0 3px var(--accent-glow);
        }

        /* 滑块 */
        .slider-container {
            display: flex;
            flex-direction: column;
            gap: var(--space-2);
        }

        .slider-value {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 40px;
            padding: var(--space-1) var(--space-2);
            background: var(--bg-secondary);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
            font-size: 0.875rem;
            font-weight: 600;
            color: var(--accent-primary);
        }

        .custom-slider {
            width: 100%;
            height: 6px;
            -webkit-appearance: none;
            appearance: none;
            background: var(--bg-secondary);
            border-radius: var(--radius-full);
            outline: none;
            cursor: pointer;
        }

        .custom-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 18px;
            height: 18px;
            background: var(--accent-primary);
            border: 3px solid var(--bg-elevated);
            border-radius: 50%;
            cursor: pointer;
            box-shadow: var(--shadow-md);
            transition: all var(--transition-fast);
        }

        .custom-slider::-webkit-slider-thumb:hover {
            background: var(--accent-hover);
            transform: scale(1.1);
            box-shadow: var(--shadow-glow);
        }

        .custom-slider::-moz-range-thumb {
            width: 18px;
            height: 18px;
            background: var(--accent-primary);
            border: 3px solid var(--bg-elevated);
            border-radius: 50%;
            cursor: pointer;
        }

        /* 输入框 */
        .custom-input {
            width: 100%;
            padding: var(--space-3) var(--space-4);
            background: var(--bg-secondary);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
            color: var(--text-primary);
            font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
            font-size: 0.9375rem;
            transition: all var(--transition-fast);
        }

        .custom-input:hover {
            border-color: var(--border-strong);
            background: var(--bg-hover);
        }

        .custom-input:focus {
            outline: none;
            border-color: var(--accent-primary);
            background: var(--bg-elevated);
            box-shadow: 0 0 0 3px var(--accent-glow);
        }

        .custom-input::placeholder {
            color: var(--text-tertiary);
        }

        .input-hint {
            font-size: 0.75rem;
            color: var(--text-tertiary);
            margin-top: var(--space-2);
        }

        .seed-row {
            display: flex;
            gap: var(--space-2);
        }

        .seed-row .custom-input {
            flex: 1;
        }

        .dice-btn {
            padding: var(--space-3);
            background: var(--bg-secondary);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
            color: var(--text-secondary);
            cursor: pointer;
            transition: all var(--transition-fast);
            font-size: 1rem;
        }

        .dice-btn:hover {
            background: var(--bg-hover);
            border-color: var(--accent-primary);
            color: var(--accent-primary);
            transform: rotate(180deg);
        }

        /* 生成按钮 */
        .action-section {
            display: flex;
            flex-direction: column;
            gap: var(--space-4);
        }

        .generate-button {
            width: 100%;
            padding: var(--space-4) var(--space-6);
            background: linear-gradient(135deg, var(--accent-primary), var(--accent-hover));
            border: none;
            border-radius: var(--radius-xl);
            color: white;
            font-size: 1.125rem;
            font-weight: 600;
            cursor: pointer;
            transition: all var(--transition-base);
            box-shadow: var(--shadow-md);
            position: relative;
            overflow: hidden;
        }

        .generate-button::before {
            content: '';
            position: absolute;
            inset: 0;
            background: linear-gradient(135deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0));
            opacity: 0;
            transition: opacity var(--transition-base);
        }

        .generate-button:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-glow);
        }

        .generate-button:hover::before {
            opacity: 1;
        }

        .generate-button:active {
            transform: translateY(0);
        }

        .generate-button:disabled {
            background: var(--bg-hover);
            color: var(--text-disabled);
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
        }

        .button-content {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: var(--space-2);
        }

        /* 加载动画 */
        .loading-spinner {
            width: 20px;
            height: 20px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top-color: white;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        /* 进度条 */
        .progress-section {
            display: none;
        }

        .progress-section.visible {
            display: block;
        }

        .progress-container {
            width: 100%;
            background: var(--bg-secondary);
            border-radius: var(--radius-full);
            height: 8px;
            overflow: hidden;
            position: relative;
        }

        .progress-bar {
            height: 100%;
            background: linear-gradient(90deg, var(--accent-primary), var(--accent-hover), var(--accent-primary));
            background-size: 200% 100%;
            border-radius: var(--radius-full);
            transition: width var(--transition-base);
            animation: shimmer 2s linear infinite;
            box-shadow: 0 0 10px var(--accent-glow);
        }

        @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }

        .progress-text {
            margin-top: var(--space-2);
            font-size: 0.875rem;
            color: var(--text-secondary);
            text-align: center;
        }

        /* API 信息卡片 */
        .api-card {
            background: var(--bg-secondary);
            border: 1px solid var(--border-subtle);
        }

        .api-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: var(--space-4);
        }

        .api-actions {
            display: flex;
            gap: var(--space-2);
        }

        .icon-button {
            display: flex;
            align-items: center;
            gap: var(--space-1);
            padding: var(--space-2) var(--space-3);
            background: var(--bg-elevated);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
            color: var(--text-secondary);
            font-size: 0.8125rem;
            cursor: pointer;
            transition: all var(--transition-fast);
        }

        .icon-button:hover {
            background: var(--bg-hover);
            border-color: var(--accent-primary);
            color: var(--accent-primary);
        }

        .code-block {
            padding: var(--space-4);
            background: var(--bg-primary);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-lg);
            font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
            font-size: 0.8125rem;
            color: var(--text-secondary);
            overflow-x: auto;
            white-space: pre-wrap;
            word-break: break-all;
        }

        .code-block .endpoint {
            color: var(--accent-primary);
        }

        /* 响应式设计 */
        @media (max-width: 639px) {
            .main-content {
                padding: var(--space-4) var(--space-3);
                gap: var(--space-4);
            }

            .header {
                padding: var(--space-3) var(--space-4);
            }

            .logo-title {
                font-size: 1.125rem;
            }

            .preview-card {
                min-height: 280px;
            }

            .generate-button {
                padding: var(--space-4);
                font-size: 1rem;
            }

            .api-header {
                flex-direction: column;
                align-items: flex-start;
                gap: var(--space-3);
            }
        }

        /* 减弱动画（用户偏好） */
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
                animation-duration: 0.01ms !important;
                transition-duration: 0.01ms !important;
            }
        }

        /* 图片操作按钮 */
        .image-actions {
            position: absolute;
            bottom: var(--space-4);
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            gap: var(--space-2);
            background: rgba(0, 0, 0, 0.7);
            backdrop-filter: blur(8px);
            padding: var(--space-2) var(--space-3);
            border-radius: var(--radius-lg);
        }

        .action-btn {
            padding: var(--space-2) var(--space-3);
            background: var(--bg-elevated);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
            color: var(--text-primary);
            font-size: 0.8125rem;
            cursor: pointer;
            transition: all var(--transition-fast);
        }

        .action-btn:hover {
            background: var(--accent-primary);
            border-color: var(--accent-primary);
        }

        /* 历史记录网格 */
        .history-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
            gap: var(--space-3);
            margin-top: var(--space-3);
        }

        .history-item {
            aspect-ratio: 1;
            border-radius: var(--radius-md);
            overflow: hidden;
            cursor: pointer;
            transition: all var(--transition-fast);
            border: 2px solid transparent;
        }

        .history-item:hover {
            border-color: var(--accent-primary);
            transform: scale(1.05);
        }

        .history-item img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        /* 负面提示词部分 */
        .negative-prompt-section {
            margin-top: var(--space-2);
        }
    </style>
</head>
<body>

<!-- 顶部导航栏 -->
<header class="header">
    <div class="header-inner">
        <div class="logo-section">
            <div class="logo-icon">Z</div>
            <h1 class="logo-title">Z-Image Turbo</h1>
        </div>
        <span class="badge">v2.3.0</span>
    </div>
</header>

<!-- 主内容区 -->
<main class="main-content">
    <!-- 图像预览区 -->
    <div class="card preview-card">
        <div class="preview-placeholder" id="placeholder">
            <div class="placeholder-icon">🎨</div>
            <p class="placeholder-text">你的创意将在此呈现</p>
            <p class="placeholder-hint">输入提示词，按 Ctrl+Enter 或点击生成按钮开始</p>
        </div>
        <img id="resultImg" class="preview-image" style="display:none" onclick="window.open(this.src)">
        <div class="image-actions" id="imageActions" style="display:none">
            <button class="action-btn" onclick="downloadImage()" title="下载图片">⬇️ 下载</button>
            <button class="action-btn" onclick="copyImageUrl()" title="复制链接">🔗 复制链接</button>
        </div>
    </div>

    <!-- 提示词输入 -->
    <div class="card prompt-card">
        <div class="card-header">
            <h2 class="card-title">💬 提示词</h2>
        </div>
        <textarea
            id="prompt"
            class="prompt-textarea"
            placeholder="描述你想生成的图像，例如：一只在未来城市中飞翔的机械蝴蝶，霓虹灯光，8K 高清..."
        >A cute cat in cyberpunk city, neon lights, 8k quality</textarea>
        <div class="negative-prompt-section">
            <label class="param-label" style="margin-top: var(--space-3);">
                <span>🚫 负面提示词 (可选)</span>
            </label>
            <input
                type="text"
                id="negativePrompt"
                class="custom-input"
                placeholder="不想出现的内容，如：blurry, low quality, text..."
            >
        </div>
    </div>

    <!-- 参数控制网格 -->
    <div class="parameters-grid">
        <!-- 尺寸比例 -->
        <div class="param-card">
            <label class="param-label">
                <span>📐 尺寸比例</span>
            </label>
            <select id="sizeSelect" class="custom-select">
                <option value="1024x1024">1:1 正方形</option>
                <option value="1152x896">9:7 横向</option>
                <option value="896x1152">7:9 竖向</option>
                <option value="1152x864">4:3 横向</option>
                <option value="864x1152">3:4 竖向</option>
                <option value="1216x832">3:2 横向</option>
                <option value="832x1216">2:3 竖向</option>
                <option value="1344x768">16:9 宽屏</option>
                <option value="768x1344">9:16 竖屏</option>
            </select>
        </div>

        <!-- 生成步数 -->
        <div class="param-card">
            <label class="param-label">
                <span>⚡ 生成步数</span>
                <span class="slider-value" id="stepsVal">8</span>
            </label>
            <div class="slider-container">
                <input type="range" id="steps" class="custom-slider" min="1" max="20" value="8"
                       oninput="document.getElementById('stepsVal').innerText=this.value">
            </div>
        </div>

        <!-- 随机种子 -->
        <div class="param-card">
            <label class="param-label">
                <span>🎲 随机种子</span>
            </label>
            <div class="seed-row">
                <input type="number" id="seed" class="custom-input" placeholder="留空随机">
                <button class="dice-btn" onclick="randomSeed()" title="随机生成">🎲</button>
            </div>
            <p class="input-hint">固定种子可复现结果</p>
        </div>
    </div>

    <!-- 生成按钮和进度 -->
    <div class="action-section">
        <button id="genBtn" class="generate-button" onclick="startGeneration()">
            <span class="button-content" id="btnContent">
                <span>🚀</span>
                <span>生成图像</span>
            </span>
        </button>

        <div class="progress-section" id="progressSection">
            <div class="progress-container">
                <div class="progress-bar" id="progressBar" style="width: 0%"></div>
            </div>
            <p class="progress-text" id="statusText">准备中...</p>
        </div>
    </div>

    <!-- API 信息 -->
    <div class="card api-card">
        <div class="api-header">
            <h3 class="card-title">📡 API 端点</h3>
            <div class="api-actions">
                <button class="icon-button" onclick="copyEndpoint()">📋 复制</button>
            </div>
        </div>
        <div class="code-block">
<span class="endpoint">${origin}/v1/images/generations</span>  (图像生成)
<span class="endpoint">${origin}/v1/chat/completions</span>  (Chat 模式)
<span class="endpoint">${origin}/v1/models</span>  (模型列表)
<span class="endpoint">${origin}/v1/health</span>  (健康检查)
        </div>
    </div>

    <!-- 生成历史 -->
    <div class="card history-card" id="historyCard" style="display:none">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;">
            <h3 class="card-title">📜 生成历史</h3>
            <button class="icon-button" onclick="clearHistory()">🗑️ 清空</button>
        </div>
        <div class="history-grid" id="historyGrid"></div>
    </div>

    <!-- 隐藏的 API Key -->
    <input type="hidden" id="apiKey" value="${apiKey}">
</main>

<script>
    // --- 历史记录管理 ---
    const HISTORY_KEY = 'zimage_history';
    const MAX_HISTORY = 20;

    function getHistory() {
        try {
            return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        } catch { return []; }
    }

    function saveToHistory(url, prompt) {
        const history = getHistory();
        history.unshift({ url, prompt, timestamp: Date.now() });
        if (history.length > MAX_HISTORY) history.pop();
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        renderHistory();
    }

    function renderHistory() {
        const history = getHistory();
        const card = document.getElementById('historyCard');
        const grid = document.getElementById('historyGrid');

        if (history.length === 0) {
            card.style.display = 'none';
            return;
        }

        card.style.display = 'block';
        grid.innerHTML = history.map((item, i) =>
            '<div class="history-item" onclick="loadFromHistory(' + i + ')" title="' + (item.prompt || '').slice(0, 50) + '">' +
            '<img src="' + item.url + '" loading="lazy" alt="历史图片">' +
            '</div>'
        ).join('');
    }

    function loadFromHistory(index) {
        const history = getHistory();
        if (history[index]) {
            const img = document.getElementById('resultImg');
            const ph = document.getElementById('placeholder');
            const actions = document.getElementById('imageActions');
            img.src = history[index].url;
            img.style.display = 'block';
            ph.style.display = 'none';
            actions.style.display = 'flex';
            if (history[index].prompt) {
                document.getElementById('prompt').value = history[index].prompt;
            }
        }
    }

    function clearHistory() {
        if (confirm('确定要清空所有历史记录吗？')) {
            localStorage.removeItem(HISTORY_KEY);
            renderHistory();
        }
    }

    // --- 图片操作 ---
    function downloadImage() {
        const img = document.getElementById('resultImg');
        if (!img.src) return;

        const link = document.createElement('a');
        link.href = img.src;
        link.download = 'zimage_' + Date.now() + '.png';
        link.target = '_blank';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function copyImageUrl() {
        const img = document.getElementById('resultImg');
        if (!img.src) return;

        navigator.clipboard.writeText(img.src).then(() => {
            const btn = event.target.closest('.action-btn');
            const original = btn.innerHTML;
            btn.innerHTML = '✅ 已复制';
            setTimeout(() => btn.innerHTML = original, 2000);
        });
    }

    // --- 基础功能 ---
    function randomSeed() {
        document.getElementById('seed').value = Math.floor(Math.random() * 1000000);
    }

    function copyEndpoint() {
        const text = '${origin}/v1/images/generations';
        navigator.clipboard.writeText(text).then(() => {
            const btn = event.target.closest('.icon-button');
            btn.innerHTML = '✅ 已复制';
            setTimeout(() => btn.innerHTML = '📋 复制', 2000);
        });
    }

    async function startGeneration() {
        const prompt = document.getElementById('prompt').value.trim();
        if(!prompt) return alert('请输入提示词');

        const negativePrompt = document.getElementById('negativePrompt')?.value.trim() || '';
        const seed = document.getElementById('seed').value;
        const steps = document.getElementById('steps').value;
        const size = document.getElementById('sizeSelect').value;
        const btn = document.getElementById('genBtn');
        const btnContent = document.getElementById('btnContent');
        const progressSection = document.getElementById('progressSection');
        const pBar = document.getElementById('progressBar');
        const sText = document.getElementById('statusText');
        const img = document.getElementById('resultImg');
        const ph = document.getElementById('placeholder');
        const actions = document.getElementById('imageActions');

        // Reset UI
        btn.disabled = true;
        btnContent.innerHTML = '<div class="loading-spinner"></div><span>生成中...</span>';
        progressSection.classList.add('visible');
        pBar.style.width = '5%';
        sText.innerText = '正在初始化...';
        sText.style.color = 'var(--text-secondary)';
        img.style.display = 'none';
        actions.style.display = 'none';
        ph.style.display = 'flex';
        ph.querySelector('.placeholder-text').innerText = '正在请求 GPU 资源...';
        ph.querySelector('.placeholder-hint').innerText = '请稍候，这可能需要几秒钟';

        try {
            // 1. 提交任务
            const requestBody = {
                prompt,
                size: size,
                steps: parseInt(steps),
                seed: seed ? parseInt(seed) : null,
                client_poll: true
            };
            if (negativePrompt) requestBody.negative_prompt = negativePrompt;

            const res = await fetch('/v1/images/generations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + document.getElementById('apiKey').value
                },
                body: JSON.stringify(requestBody)
            });

            if(!res.ok) throw new Error(await res.text());
            const initData = await res.json();

            if(initData.status !== 'submitted') throw new Error("任务提交失败");

            const taskId = initData.task_id;
            const authContext = initData.auth_context;

            // 2. 客户端轮询
            let progress = 10;
            const pollInterval = setInterval(async () => {
                try {
                    if(progress < 90) progress += (Math.random() * 5);
                    pBar.style.width = progress + '%';
                    sText.innerText = '生成中... ' + Math.floor(progress) + '%';

                    const qRes = await fetch('/v1/query/status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ task_id: taskId, auth_context: authContext })
                    });

                    const qData = await qRes.json();

                    if(qData.status === 'success') {
                        clearInterval(pollInterval);
                        pBar.style.width = '100%';
                        sText.innerText = '✅ 生成完成！点击图片查看大图';
                        sText.style.color = 'var(--success)';
                        ph.style.display = 'none';
                        img.src = qData.url;
                        img.style.display = 'block';
                        actions.style.display = 'flex';
                        saveToHistory(qData.url, prompt);
                        resetButton();
                    } else if(qData.status === 'failed') {
                        throw new Error(qData.error || 'Unknown Error');
                    }
                } catch(e) {
                    clearInterval(pollInterval);
                    sText.innerText = '❌ ' + e.message;
                    sText.style.color = 'var(--error)';
                    resetButton();
                }
            }, 1500);

        } catch(e) {
            sText.innerText = '❌ 请求失败: ' + e.message;
            sText.style.color = 'var(--error)';
            ph.querySelector('.placeholder-text').innerText = '生成失败';
            ph.querySelector('.placeholder-hint').innerText = e.message;
            resetButton();
        }
    }

    function resetButton() {
        const btn = document.getElementById('genBtn');
        const btnContent = document.getElementById('btnContent');
        btn.disabled = false;
        btnContent.innerHTML = '<span>🚀</span><span>生成图像</span>';
    }

    // --- 键盘快捷键 ---
    document.addEventListener('keydown', function(e) {
        // Ctrl+Enter 或 Cmd+Enter 生成图片
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (!document.getElementById('genBtn').disabled) {
                startGeneration();
            }
        }
    });

    // --- 页面加载时渲染历史 ---
    document.addEventListener('DOMContentLoaded', renderHistory);
</script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
