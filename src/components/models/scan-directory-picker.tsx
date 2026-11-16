"use client";

import { useEffect, useState } from "react";
import { ArrowUpLeft, FolderOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { DirectoryNavRow } from "@/components/models/directory-nav-row";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";

export function ScanDirectoryPicker({ onAdd }: { onAdd: (dirs: string[]) => void }) {
  const t = useTranslations("pages.repos");
  const tPicker = useTranslations("common.filePicker");
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [listing, setListing] = useState<{ trail: string[]; dirs: string[] | null }>();
  const current = trail.at(-1);
  const dirs = listing?.trail === trail ? listing.dirs : undefined;

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const query = current === undefined ? "" : `?${new URLSearchParams({ path: current })}`;
    void apiFetch(`/api/v1/files/scan-directories${query}`)
      .then(async (response) => response.ok ? ((await response.json()) as { dirs: string[] }).dirs : null)
      .catch(() => null)
      .then((result) => {
        if (!disposed) setListing({ trail, dirs: result });
      });
    return () => { disposed = true; };
  }, [open, current, trail]);

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (next) {
        setTrail([]);
        setSelected([]);
      }
      setOpen(next);
    }}>
      <DialogTrigger render={<Button type="button" size="sm" variant="outline" />}>
        <FolderOpen className="size-3.5" />
        {tPicker("browse")}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("scanBrowseTitle")}</DialogTitle>
          <DialogDescription>{t("scanBrowseHint")}</DialogDescription>
        </DialogHeader>
        <nav aria-label={t("scanBrowseMounts")} className="min-w-0 overflow-hidden rounded-lg border bg-muted/25">
          <div className="flex min-w-0 items-center gap-2 border-b px-2 py-1.5">
            {current === undefined ? (
              <span className="px-2 py-1 text-xs font-medium">{t("scanBrowseMounts")}</span>
            ) : (
              <>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("scanBrowseUp")}
                  title={t("scanBrowseUp")}
                  onClick={() => setTrail(trail.slice(0, -1))}
                >
                  <ArrowUpLeft className="size-3.5" />
                </Button>
                <code title={current} className="min-w-0 truncate font-mono text-xs">{current}</code>
              </>
            )}
          </div>
          <div className="h-56 overflow-y-auto p-2 sm:h-64">
            {dirs === undefined ? (
              <p role="status" className="px-2 py-4 text-xs text-muted-foreground">{t("scanBrowseLoading")}</p>
            ) : dirs === null ? (
              <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-4">
                <p role="status" className="text-xs text-muted-foreground">{t("scanBrowseError")}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => setTrail([...trail])}>
                  {t("detailRetry")}
                </Button>
              </div>
            ) : dirs.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                {t(current === undefined ? "scanBrowseNoMounts" : "scanBrowseEmpty")}
              </p>
            ) : (
              <ul className="grid gap-0.5">
                {dirs.map((dir) => {
                  const label = current === undefined ? dir : dir.slice(dir.lastIndexOf("/") + 1);
                  return (
                    <li key={dir} className="flex min-w-0 items-center gap-1">
                      {current !== undefined && (
                        <Checkbox
                          aria-label={t("scanBrowseSelect", { name: label })}
                          checked={selected.includes(dir)}
                          onCheckedChange={(checked) => setSelected((previous) =>
                            checked ? [...previous, dir] : previous.filter((path) => path !== dir),
                          )}
                          className="ml-2"
                        />
                      )}
                      <DirectoryNavRow label={label} onClick={() => setTrail([...trail, dir])} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </nav>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>{t("scanScopeCancel")}</DialogClose>
          <Button
            type="button"
            disabled={selected.length === 0}
            onClick={() => {
              onAdd(selected);
              setOpen(false);
            }}
          >
            {t("scanBrowseAdd", { count: selected.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
