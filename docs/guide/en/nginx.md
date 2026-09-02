# HTTPS Reverse Proxy

A reference nginx config for putting the panel behind HTTPS.

Reference config for accessing the panel through nginx with a domain name. There are two topologies, and **A (single domain)
is recommended** — the Chat page now runs through the panel's own built-in Playground, so a single domain is enough for
full functionality; a subdomain (B) is only needed if you want the header's "Open llama UI" link to reliably work even
on a domain with HSTS enabled, and is otherwise optional.

> **HTTPS is optional, not required.** Accessing `IP:28960` directly over the LAN needs no nginx config and no certificate
> at all. The panel itself only speaks HTTP; TLS is terminated by nginx — that way certificate management, protocol
> versions, and HSTS are all handled by a component better suited for them. The panel reads `X-Forwarded-Proto` to
> automatically detect whether it's on HTTPS and sets the session cookie's `Secure` flag accordingly, so the same image
> can sign in correctly whether deployed as "direct LAN HTTP" or "nginx HTTPS", with no config changes needed. The
> examples below all include TLS; if you only want to access it over a plain HTTP domain, swap `listen 443 ssl` for
> `listen 80`, drop the `ssl_*` directives and the 301 redirect, and keep everything else as-is (especially
> `proxy_buffering off`).

## Is a single domain enough

The Chat page used to embed llama.cpp's bundled web UI directly in an iframe, and that web UI's frontend bundle contains
requests with **root-absolute paths** (`/v1/models`, `/props`, `/tools`, etc.) — loading it cross-origin inevitably 404s.
That was the reason a subdomain used to be recommended.

The Chat page now uses the panel's own built-in Playground instead: the conversation, the parameter panel, and viewing
the request body all go through the panel's own same-origin reverse proxy at `/api/v1/proxy/llama/*`, so **the single-domain
topology (A) is enough on its own** — no second certificate, and no `chat.base_url`, required.

A subdomain (B) keeps one optional use: the header's "Open llama UI" link button opens a new tab and navigates **directly**
to llama-server (not through the panel's reverse proxy). That's a full-page navigation, not a cross-origin data fetch, so
it isn't subject to mixed-content restrictions on its own — but if that domain has HSTS enabled, the browser force-upgrades
this plain http target to https before connecting, and the connection fails. That's the case where you need `chat.base_url`
to explicitly point at a reachable address (an `IP:port` on the same network segment works fine — it doesn't have to match
the certificate's domain). This button is just a supplementary entry point to "open llama.cpp's bundled web UI" — it isn't
required for the Chat page to work.

## A. Single domain (recommended: the Chat page works out of the box, no `chat.base_url` needed)

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name llama.local.example.com;

    ssl_certificate     /etc/nginx/certs/llama.local.example.com.crt;
    ssl_certificate_key /etc/nginx/certs/llama.local.example.com.key;

    # For YAML imports / uploads; model files aren't uploaded through the panel, so GB-scale limits aren't needed
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:28960;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE (log stream / event stream / download progress stream) needs buffering off, or the frontend never gets real-time lines
        proxy_buffering off;
        proxy_cache off;
        # The log stream can go long stretches with no data (idle model), so give it a generous timeout
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

## B. Subdomain (optional: gives the "Open llama UI" link a stable address unaffected by HSTS)

```nginx
# ---------- Panel ----------
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

# ---------- llama-server (target of the header's "Open llama UI" link) ----------
server {
    listen 443 ssl;
    http2 on;
    server_name llama-api.local.example.com;

    ssl_certificate     /etc/nginx/certs/local.example.com.crt;
    ssl_certificate_key /etc/nginx/certs/local.example.com.key;

    # WARNING: llama-server has no built-in auth — once this subdomain is reachable, the inference API is wide open.
    # For internal deployments, network-boundary isolation alone may be enough; if this subdomain will be exposed
    # to an untrusted network, add access control here, e.g. basic auth or restricting the source network:
    #   allow 192.168.0.0/16; allow 10.0.0.0/8; deny all;

    location / {
        # Target is llama-server's host port (the model's host_port, 18080 by default),
        # not the panel's 28960 — pointing it at the panel proxies this subdomain back
        # to the panel, the external link still won't open the llama UI, and the access
        # control above ends up guarding the wrong target
        proxy_pass http://127.0.0.1:18080;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Streaming generation needs buffering off, or tokens get batched and dumped all at once
        proxy_buffering off;
        proxy_cache off;
        # Large models can take a long time to the first token (loading + prompt eval)
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # This subdomain is only ever reached via a full-page browser navigation (clicking "Open llama UI" opens a new
        # tab) — there's no cross-origin fetch involved, so CORS/preflight isn't a concern
    }
}

server {
    listen 80;
    server_name llama.local.example.com llama-api.local.example.com;
    return 301 https://$host$request_uri;
}
```

The matching `panel.yaml` (only needed if you want the "Open llama UI" link to avoid HSTS — the Chat page itself doesn't depend on it):

```yaml
# The paths section can be omitted: the panel auto-discovers ./models' host path via docker.sock
# (see "Deployment & Operations" (./deployment.md)).
# chat.base_url can likewise be omitted; it's only needed in the scenario described below
chat:
  # Target address for the header's "Open llama UI" link button. Empty = derived from the browser's address as
  # http://<panel hostname>:<model's host_port> (new-tab navigation, unaffected by mixed content); if that domain
  # has HSTS enabled, the browser force-upgrades this plain address to https and the connection fails — that's
  # when you need to set an explicit, reachable address here (it doesn't need to match the certificate's domain,
  # e.g. a LAN IP:port works)
  base_url: https://llama-api.local.example.com
```

## Checklist

Confirm each of these after deploying:

- [ ] `https://llama.local.example.com` signs in, and the session survives a refresh (confirm `X-Forwarded-Proto` is
      being passed through correctly: without it, the panel thinks it's on HTTP and the cookie isn't marked Secure —
      it still works, just with one less layer of protection)
- [ ] Container logs on the Logs page scroll in real time — verifies `proxy_buffering off` is in effect
- [ ] The Chat page can send a message and get a streamed reply — verifies the same-origin reverse proxy at
      `/api/v1/proxy/llama/*`, so a single domain is enough
- [ ] If you configured the B subdomain: the header's "Open llama UI" button opens llama.cpp's bundled web UI in a new tab
- [ ] Download a small model and watch the progress bar update in real time — verifies the download SSE
