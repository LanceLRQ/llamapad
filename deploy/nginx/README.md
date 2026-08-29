# nginx 反向代理部署示例

面板经 nginx 以域名访问时的参考配置。两种拓扑，**推荐 B（子域名）**。

> **HTTPS 是可选的，不是必须。** 局域网直接访问 `IP:28960` 无需任何 nginx 配置，也无需证书。
> 面板自身只跑 HTTP，TLS 由 nginx 终止——这样证书管理、协议版本、HSTS 这些都交给更擅长的组件。
> 面板会读 `X-Forwarded-Proto` 自动判断当前是否 HTTPS 并据此决定会话 cookie 是否加 `Secure`，
> 所以同一个镜像在「局域网 HTTP 直连」与「nginx HTTPS」两种部署下都能正常登录，无需改配置。
> 下面的示例都带 TLS；只想用 HTTP 域名访问的话，把 `listen 443 ssl` 换成 `listen 80`、
> 删掉 `ssl_*` 与 301 跳转即可，其余（尤其 `proxy_buffering off`）原样保留。

## 为什么推荐子域名

Chat 页用 iframe 嵌入 llama.cpp 自带的 web UI，而该 web UI 的前端 bundle 里含**根绝对路径**请求
（`/v1/models`、`/props`、`/tools` 等）。这决定了它对部署路径敏感：

| 拓扑 | web UI 的根绝对路径 | 结果 |
|---|---|---|
| 面板反代 `/api/v1/proxy/llama/` | 打到面板域的 `/v1/models` | ❌ 404（面板无此路由） |
| 同域分路径 `https://域名/llama/` | 同样打到 `/v1/models` | ❌ 404 |
| **独立子域名 `https://llama-api.域名/`** | 打到子域名根，即 llama-server 自己 | ✅ 正确 |

子域名让 llama-server 位于根路径，web UI 无需任何改造即可工作——这也是 llamapad 不再为 Chat 页
维护 webui 反代的原因（面板反代仍保留，供 API 调用与「在新窗口打开」回退）。

## A. 单域名（面板可用，Chat 页需配 `chat.base_url` 指向别处）

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name llama.local.example.com;

    ssl_certificate     /etc/nginx/certs/llama.local.example.com.crt;
    ssl_certificate_key /etc/nginx/certs/llama.local.example.com.key;

    # 导入 YAML / 上传场景；模型文件不经面板上传，无需调到 GB 级
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:28960;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE（日志流 / 事件流 / 下载进度流）必须关缓冲，否则前端收不到实时行
        proxy_buffering off;
        proxy_cache off;
        # 日志流可长时间无数据（模型空闲），超时给足
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

server {
    listen 80;
    server_name llama.local.example.com;
    return 301 https://$host$request_uri;
}
```

## B. 子域名（推荐：面板 + llama-server 各一个子域名，Chat 页开箱可用）

```nginx
# ---------- 面板 ----------
server {
    listen 443 ssl;
    http2 on;
    server_name llama.local.example.com;

    ssl_certificate     /etc/nginx/certs/local.example.com.crt;
    ssl_certificate_key /etc/nginx/certs/local.example.com.key;

    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:28960;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

# ---------- llama-server（Chat 页 iframe 直连目标） ----------
server {
    listen 443 ssl;
    http2 on;
    server_name llama-api.local.example.com;

    ssl_certificate     /etc/nginx/certs/local.example.com.crt;
    ssl_certificate_key /etc/nginx/certs/local.example.com.key;

    # ⚠️ llama-server 无鉴权：子域名一旦可达即等于开放推理接口。
    # 内网部署可只靠网络边界；若子域名会暴露到不可信网络，务必在此加访问控制，
    # 例如放开 basic auth 或限制来源网段：
    #   allow 192.168.0.0/16; allow 10.0.0.0/8; deny all;

    location / {
        proxy_pass http://127.0.0.1:28960;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 流式生成必须关缓冲，否则 token 会被攒着一次性吐出
        proxy_buffering off;
        proxy_cache off;
        # 大模型首 token 可能等待很久（加载 + prompt eval）
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # 面板 Chat 页 iframe 从面板域加载本子域名，跨域由 llama-server 自身 CORS 全开承担；
        # 若后续给本子域名加了会拦截 OPTIONS 的访问控制，需在此放行预检
    }
}

server {
    listen 80;
    server_name llama.local.example.com llama-api.local.example.com;
    return 301 https://$host$request_uri;
}
```

配套的 `panel.yaml`：

```yaml
# paths 一节可省略：面板经 docker.sock 自动发现 ./models 的宿主机路径（见 deploy/README.md）。
# 本节唯一必需的是 chat.base_url —— HTTPS 部署下它没有默认值可推导
chat:
  # Chat 页 iframe 的基地址。留空 = 按浏览器地址推导 http://<面板 hostname>:<模型 host_port>
  # （局域网直接访问 IP:28960 的场景）；HTTPS 部署必须显式配置，否则明文直连会被
  # 浏览器按 mixed content 拦截
  base_url: https://llama-api.local.example.com
```

## 检查清单

部署后逐项确认：

- [ ] `https://llama.local.example.com` 能登录，刷新后会话保持（确认 `X-Forwarded-Proto` 已正确透传：
      缺了它面板会以为自己在 HTTP 下，cookie 不加 Secure——能用，但少一层保护）
- [ ] 监控页终端有实时日志滚动 —— 验证 `proxy_buffering off` 生效
- [ ] Chat 页 iframe 能打开 web UI 且能对话 —— 验证子域名与 `chat.base_url`
- [ ] 浏览器控制台无 mixed content 报错
- [ ] 下载一个小模型，进度条实时更新 —— 验证下载 SSE
