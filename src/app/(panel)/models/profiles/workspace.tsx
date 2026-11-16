"use client";

import { createContext, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";

import type { ModelView } from "@/server/modelsView";

type ProfileChange = { name: string; model: ModelView | null };

export const ProfileEditorContext = createContext<{
  editing: string | null;
  change: ProfileChange | null;
  close: (change?: ProfileChange) => void;
} | null>(null);

export default function ProfilesLayout({ children, editor }: { children: ReactNode; editor: ReactNode }) {
  const editing = /^\/models\/([^/]+)\/edit$/.exec(usePathname())?.[1] ?? null;
  const router = useRouter();
  const [change, setChange] = useState<ProfileChange | null>(null);

  function close(next?: ProfileChange) {
    if (next) setChange(next);
    router.back();
  }

  return (
    <ProfileEditorContext.Provider value={{ editing, change, close }}>
      <div className="@container -mx-[34px] -mt-7 -mb-12 h-[calc(100%+76px)]">
        <div className="flex h-full min-w-0">
          <div className={editing === null
            ? "flex min-w-0 flex-1 flex-col"
            : "hidden min-h-0 w-60 shrink-0 flex-col border-r bg-muted/25 @min-[58rem]:flex"}
          >
            {children}
          </div>
          {editing !== null && (
            <section className="flex min-h-0 min-w-0 flex-1 flex-col">{editor}</section>
          )}
        </div>
      </div>
    </ProfileEditorContext.Provider>
  );
}
