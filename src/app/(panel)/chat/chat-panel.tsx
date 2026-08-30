"use client";

import { useEffect, useState } from "react";

import { ParamBar } from "./param-bar";
import { Playground } from "./playground";
import { apiFetch } from "@/lib/api";
import type { SamplingConfig } from "@/lib/props-drift";

/**
 * Chat 页的 client 合成层：唯一职责是持有"最近一次实际发出的请求体"这份
 * state，把它从 Playground 传到 ParamBar 的「查看请求体」弹层。
 *
 * 为什么需要这一层：page.tsx 是 server 组件（要读 DB 算合并后的模型配置），
 * 不能持有 React state；而这份 state 的生产者与消费者是两个平级的 client
 * 组件，只能由它们共同的 client 父级来托管。
 */
export function ChatPanel({
  config,
  ctxSize,
}: {
  config: SamplingConfig | null;
  ctxSize: number | null;
}) {
  const [lastBody, setLastBody] = useState<unknown>(null);

  // 首启动引导第四步「打开过 Playground」（UX P1 U22）打标：本组件只在有模型运行且
  // 已就绪时才被渲染，挂载即视为「打开过」。fire-and-forget，失败不提示
  useEffect(() => {
    apiFetch("/api/v1/settings/onboarding_playground_seen", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "1" }),
    }).catch(() => {});
  }, []);

  return (
    <>
      {config !== null && ctxSize !== null && (
        <ParamBar config={config} ctxSize={ctxSize} lastBody={lastBody} />
      )}
      <Playground onBodyChange={setLastBody} />
    </>
  );
}
