"use client";

import { Loader2, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function SettingsSaveFooter({ dirty, busy, saved, error, onSave }: {
  dirty: boolean;
  busy: boolean;
  saved: boolean;
  error?: string | null;
  onSave: () => void;
}) {
  const t = useTranslations("pages.settings");
  const edit = useTranslations("pages.modelEdit");
  const { pendingHref, confirmLeave, cancelLeave } = useUnsavedGuard(dirty);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button size="sm" disabled={!dirty || busy} onClick={onSave}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {busy ? t("panelSaving") : t("panelSave")}
        </Button>
        <span role="status" className="text-xs text-muted-foreground">{dirty ? t("panelUnsaved") : saved ? t("panelSaved") : t("panelUnchanged")}</span>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      <Dialog open={pendingHref !== null} onOpenChange={(open) => { if (!open) cancelLeave(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{edit("unsavedTitle")}</DialogTitle><DialogDescription>{edit("unsavedBody")}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={cancelLeave}>{edit("unsavedStay")}</Button><Button onClick={confirmLeave}>{edit("unsavedLeave")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
