"use client";

import { useState } from "react";

import type { ModelNameServiceInput } from "@/lib/relay-model-names";
import type { UpstreamView } from "@/lib/upstream-types";
import { ModelNamesCard } from "./model-names-card";
import { UpstreamsSection } from "./upstreams-section";

/**
 * 页面主体的两栏骨架：左主栏（托管服务 + 外部上游）、右固定栏（可用模型名 + 接入信息）。
 *
 * 外部上游列表由客户端轮询刷新（UpstreamsSection），而右栏的「可用模型名」要读同一份，
 * 两者分在不同的栏里，所以列表状态上提到这里，服务端只给初值。托管服务区与接入信息是
 * 纯展示的 server 组件，以插槽传进来。
 *
 * 右栏 440px 是为了让接入信息里的完整地址排成一行；1400px 以下收窄到 372px，把宽度让给主栏。
 * xl 起右栏固定、只有主栏自己纵向滚动（外层给本组件一个定高，见 page.tsx）；
 * 窄屏退化为单栏，右栏的卡片跟在主栏后面按正常文档流排，不固定、不限高。
 * 两个滚动区都用 scrollbar-gutter: stable 配对称内边距：滚动条常显的系统（Windows、
 * Linux 桌面）上，滚动条占自己那条槽，不压内容、不贴卡片边。
 */
export function RelayWorkspace({
  initialUpstreams,
  services,
  managedDefault,
  managed,
  access,
}: {
  initialUpstreams: UpstreamView[];
  services: ModelNameServiceInput[];
  managedDefault: string | null;
  managed: React.ReactNode;
  access: React.ReactNode;
}) {
  const [upstreams, setUpstreams] = useState(initialUpstreams);

  return (
    <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
      <div className="@container flex min-w-0 flex-col gap-7 px-7 py-6 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-5 xl:[scrollbar-gutter:stable]">
        {managed}
        <UpstreamsSection items={upstreams} setItems={setUpstreams} />
      </div>
      <aside className="flex flex-col gap-3 px-7 pb-6 xl:min-h-0 xl:w-[372px] xl:shrink-0 xl:overflow-y-auto xl:px-4 xl:py-6 xl:[scrollbar-gutter:stable] min-[87.5rem]:w-[440px]">
        <ModelNamesCard services={services} upstreams={upstreams} managedDefault={managedDefault} />
        {access}
      </aside>
    </div>
  );
}
