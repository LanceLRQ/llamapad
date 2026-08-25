"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 未保存离开拦截（UX P0 Task 11 / U11）：App Router 没有官方导航事件，
 * 组合两路拦截——
 * 1) beforeunload：覆盖刷新 / 关闭标签 / 外链跳转（浏览器原生确认框）；
 * 2) 捕获阶段拦截站内 <a> 左键点击：preventDefault 后把目标 href 交给
 *    调用方的确认 UI，确认后以 router.push 放行。
 *
 * 已知限制（有意为之，防误导）：编程式 router.push 不经过 <a>，不被拦截——
 * 表单自身的保存 / 删除后跳转本就带用户意图，不该被拦；Next 官方推出
 * navigation blocker API 后可整体替换本 hook。
 *
 * dirtyRef 惰性读最新脏标记：监听只装一次，脏状态变化不重装（拦截回调
 * 闭包里取 ref，避免 dirty 抖动期间漏拦）。
 */
export function useUnsavedGuard(dirty: boolean) {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const dirtyRef = useRef(dirty);
  // 渲染后同步最新脏标记（拦截回调读 ref，脏状态变化不重装监听）
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // 脏态期间装 beforeunload；干净时卸载（浏览器不再弹原生确认）
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // 捕获阶段拦站内链接（常装：回调内部按脏标记短路，干净时零成本）
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!dirtyRef.current) return;
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      if (anchor === null || anchor === undefined) return;
      const href = anchor.getAttribute("href");
      // 只拦站内同源路径（含 hash 路由目标）；外链/锚点交给浏览器默认行为
      if (href === null || !href.startsWith("/") || href.startsWith("//")) return;
      event.preventDefault();
      setPendingHref(href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  const confirmLeave = useCallback(() => {
    const href = pendingHref;
    setPendingHref(null);
    if (href !== null) router.push(href);
  }, [pendingHref, router]);

  const cancelLeave = useCallback(() => setPendingHref(null), []);

  return { pendingHref, confirmLeave, cancelLeave };
}
