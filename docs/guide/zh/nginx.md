# HTTPS 反代

用 nginx 给面板套一层 HTTPS 的参考配置。

面板经 nginx 以域名访问时的参考配置。两种拓扑，**推荐 A（单域名）**——Chat 页现在走面板自建
Playground，单域名即可完整使用；子域名（B）仅在需要页头「打开 llama UI」外链在部署了 HSTS 的
域下也能稳定跳转时才有必要，属可选项。

> **HTTPS 是可选的，不是必须。** 局域网直接访问 `IP:28960` 无需任何 nginx 配置，也无需证书。
> 面板自身只跑 HTTP，TLS 由 nginx 终止——这样证书管理、协议版本、HSTS 这些都交给更擅长的组件。
> 面板会读 `X-Forwarded-Proto` 自动判断当前是否 HTTPS 并据此决定会话 cookie 是否加 `Secure`，
> 所以同一个镜像在「局域网 HTTP 直连」与「nginx HTTPS」两种部署下都能正常登录，无需改配置。
> 下面的示例都带 TLS；只想用 HTTP 域名访问的话，把 `listen 443 ssl` 换成 `listen 80`、
> 删掉 `ssl_*` 与 301 跳转即可，其余（尤其 `proxy_buffering off`）原样保留。

## 单域名是否够用

Chat 页曾经用 iframe 直接嵌入 llama.cpp 自带的 web UI，而该 web UI 的前端 bundle 里含**根绝对
路径**请求（`/v1/models`、`/props`、`/tools` 等），跨源加载必然 404——这是过去推荐子域名的
理由。

Chat 页现已改为面板自建 Playground：对话、参数栏、查看请求体全部经面板自己的同源反代
`/api/v1/proxy/llama/*` 访问 llama-server，**单域名拓扑（A）即可完整使用**，不需要第二张
证书，也不需要 `chat.base_url`。

子域名（B）保留了一个可选用途：页头「打开 llama UI」外链按钮会新开标签**直接**导航到
llama-server（不经面板反代）。这是一次整页导航而非跨域取数，本身不受 mixed content 限制；
但若该域启用了 HSTS，浏览器会把这个明文 http 目标强升为 https 再连接，届时会失败——这时才
需要 `chat.base_url` 显式指定一个可达地址（同网段的 `IP:端口` 即可，不必与证书域同名）。这个
按钮只是「打开 llama.cpp 自带 web UI」的补充入口，不是 Chat 页的必需功能。

## A. 单域名（推荐：Chat 页开箱可用，无需 `chat.base_url`）

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

## B. 子域名（可选：给「打开 llama UI」外链一个不受 HSTS 影响的稳定地址）

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

# ---------- llama-server（页头「打开 llama UI」外链目标） ----------
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
        # 目标是 llama-server 的宿主机端口（模型配置里的 host_port，默认 18080），
        # 不是面板的 28960——填成面板端口会让这个子域名反代回面板，外链依旧打不开
        # llama UI，上面那条访问控制也就加在了错的目标上
        proxy_pass http://127.0.0.1:18080;
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

        # 本子域名的唯一访问方式是浏览器整页导航（点「打开 llama UI」新开标签），
        # 不发生跨域 fetch，无需操心 CORS/预检
    }
}

server {
    listen 80;
    server_name llama.local.example.com llama-api.local.example.com;
    return 301 https://$host$request_uri;
}
```

配套的 `panel.yaml`（仅在需要「打开 llama UI」外链避开 HSTS 时才配置，Chat 页本身不依赖它）：

```yaml
# paths 一节可省略：面板经 docker.sock 自动发现 ./models 的宿主机路径（见[「部署与运维」](./deployment.md)）。
# chat.base_url 同样可省略，只在下面这个场景才需要显式配置
chat:
  # 页头「打开 llama UI」外链按钮的目标地址。留空 = 按浏览器地址推导
  # http://<面板 hostname>:<模型 host_port>（新标签导航，不受 mixed content 限制）；
  # 该域若启用了 HSTS，浏览器会把这个明文地址强升为 https 导致连接失败，此时才需要
  # 显式指定一个可达地址（不必与证书域同名，例如局域网 IP:端口）
  base_url: https://llama-api.local.example.com
```

## 检查清单

部署后逐项确认：

- [ ] `https://llama.local.example.com` 能登录，刷新后会话保持（确认 `X-Forwarded-Proto` 已正确透传：
      缺了它面板会以为自己在 HTTP 下，cookie 不加 Secure——能用，但少一层保护）
- [ ] 日志页的容器日志有实时滚动 —— 验证 `proxy_buffering off` 生效
- [ ] Chat 页能发消息并看到流式回复 —— 验证 `/api/v1/proxy/llama/*` 同源反代，单域名即可
- [ ] 若配了 B 的子域名：页头「打开 llama UI」按钮能在新标签打开 llama.cpp 自带 web UI
- [ ] 下载一个小模型，进度条实时更新 —— 验证下载 SSE
