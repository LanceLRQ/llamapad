import { getDb } from "@/server/db";
import { scanTree } from "@/server/fsScanner";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { decorateModels } from "@/server/modelsView";
import { createModelRepo } from "@/server/repo/models";
import { ProfilesView } from "./profiles-view";

export const dynamic = "force-dynamic";

export default async function ModelsPage({ searchParams }: { searchParams: Promise<{ ns?: string }> }) {
  const { ns: rawNs } = await searchParams;
  const root = getPanelModelsRoot();
  const models = await decorateModels(getDb(), getRuntimeService(), root);
  const namespaces = createModelRepo(getDb()).listNamespaces();
  const folders = scanTree(root).map((group) => group.folder);
  const namespace = rawNs !== undefined && namespaces.includes(rawNs) ? rawNs : "all";

  return <ProfilesView models={models} namespace={namespace} namespaces={namespaces} folders={folders} />;
}
