# Monitoring & Logs

Monitoring metrics are consolidated on the Overview page (`/`); the Logs page (`/logs`) only keeps two troubleshooting tools — run history and container logs — so the same numbers aren't shown twice in two places.

## Overview page: 13 combined reading + chart cards

The left column of the Overview page is the monitoring card area — 13 cards total, in four groups:

| Group | Cards |
| --- | --- |
| Host (6 cards) | CPU utilization, Memory, Load average, Disk free, Disk I/O (read/write), Network I/O (received/sent) |
| GPU (2 cards) | VRAM, GPU utilization |
| Container (2 cards) | CPU (container), Memory (container) |
| Inference (3 cards) | Generation rate, KV Cache, Active slots |

Each card is a combination of "current value in the card header + history chart" (Disk free is the exception — see below). These two parts come from **two data streams with different cadences and different sources**:

- **The header's headline number**: refreshes on the interval set by the refresh-interval selector at the top of the page (5 seconds by default, and the choice is remembered in this browser) — it's the reading at this exact moment. Even while looking at the 7-day chart's coarser history, the header still won't show a stale value from that coarser granularity.
- **The history chart**: switches with the time-range tabs at the top of the page (`30m` / `2h` / `24h` / `7d`; see "How far back can history go" below).

Disk free is the one exception: it changes too slowly for a line chart to show any trend, so it's downgraded to a header reading only (paired with a used/free donut chart) — no history chart, and no expand option.

The two GPU cards and the three inference cards each come from the same probe, so they either all have data together, or are all empty together — you'll never see "utilization has data but VRAM is empty." The host and container cards, on the other hand, are independent of each other — missing CPU data doesn't mean Disk I/O will be missing too.

## Multi-GPU aggregation

With multiple GPUs, VRAM, utilization, temperature and power draw are each combined differently — check which one you're looking at before reading the numbers:

| Metric | Aggregation | In the history chart? |
| --- | --- | --- |
| VRAM usage | Sum | Yes |
| GPU utilization | Arithmetic mean | Yes |
| Temperature | Max across cards | No (subtitle in the card header only) |
| Power draw | Sum | No (subtitle in the card header only) |

Temperature uses the max rather than the average because what this metric cares about is "is any card running close to overheating" — an average would flatten one card at 85°C and one at 45°C into a seemingly-normal 65°C. With multiple GPUs, the card header subtitle adds "{n} GPUs combined"; a single GPU shows nothing extra (no ambiguity to clear up).

## CPU% conventions

Container CPU% and host CPU% are two numbers with different conventions and different ranges.

Container CPU% matches `docker stats`'s convention and is **expressed per-core**: on a 16-core machine, full load shows as 1600%, not 100%. The card header subtitle "{core count} cores · full load {cores×100}%" spells out this machine's full-load reference value.

Host CPU% is whole-machine utilization and always falls between 0–100 (multiple cores are already folded into one overall utilization figure at the system level, so there's no need to multiply by core count again).

So these two numbers aren't directly comparable — a container card showing 400% and a host card showing 25% describe the same thing on a 16-core machine (4 cores' worth of usage).

## How far back can history go

The longer the time span, the coarser the chart's sampling points:

| Time range | Sampling granularity | Retention |
| --- | --- | --- |
| Last 2 hours | 5 seconds | 2 hours |
| Last 48 hours | 1 minute | 48 hours |
| Older | 15 minutes | 14 days |

The panel automatically picks the finest granularity available for the selected time range — no manual selection needed.

Restarting the panel discards the last two hours of 5-second-level detail, so that stretch of the chart gets coarser; the 48-hour and 14-day history live on disk and aren't affected by a restart.

## Host disk I/O and network throughput both depend on the `/proc` mount

CPU / Memory / Load / Disk free can all be collected by the panel container on its own, but **both disk I/O rate and network throughput rate require the host's `/proc` to also be mounted in** (the `/proc:/host/proc:ro` line in `docker-compose.yml`).

Without this line, these two metric groups silently default to empty (no error, no impact on the rest) — worth watching for on deployments upgrading from an older version, since this mount is a container-level config: `docker compose restart` won't apply it, you need `docker compose up -d` to recreate the container.

## GPU monitoring prerequisites

The two GPU cards (VRAM, utilization) depend on the panel container being able to call `nvidia-smi`, which comes from `gpus: all` in `docker-compose.yml`. Without this line, both cards are hidden and a notice appears at the top of the charts area; on a CPU-only deployment, this is expected.

## Logs page: run history and container logs

The Logs page (`/logs`) has two groups:

- **History**: one row per model start/stop, listing the model, start time, duration, average tok/s, and peak VRAM. Peak VRAM shows the **net increase** (peak minus the pre-start baseline), not the whole card's usage the instant after starting — this machine often has other unrelated tasks running on the same card at the same time, so showing the raw peak would make it look like "this model is eating this much VRAM"; subtracting the pre-start baseline gives you this run's actual net cost.
- **Container Logs**: the `llama.cpp` container's live log stream, pushed to the page in real time — no manual refresh needed.

## Webhook notifications

Events like download completion or model start/stop can be pushed to Bark / Telegram / WeCom or a custom endpoint; the config entry point is the "Monitoring & notifications" group on the [Settings page](./settings.md).

## Known limitations

The generation rate can't capture generations shorter than the 5-second collection interval — if a single inference finishes within 5 seconds, the collection heartbeat may never catch it even once, and the card header and chart will show as empty rather than 0; that doesn't mean the inference didn't happen.
