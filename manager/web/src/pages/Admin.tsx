import { useState } from "react";
import { useLoad } from "../hooks";
import { ErrorBox, Page, Tabs } from "../components/ui";
import { AgentPlayground } from "../admin/AgentPlayground";
import { CatalogView } from "../admin/CatalogView";
import { FlowBuilder } from "../admin/FlowBuilder";
import { fetchCatalog } from "../admin/catalog";
import { VlmInput, listPrompts } from "../vlm/types";

type Tab = "builder" | "agents" | "catalog";

/** Admin: the graphic AI workflow builder (LangGraph), LangChain agents, and the catalog. */
export default function Admin() {
  const [tab, setTab] = useState<Tab>("builder");
  const catalog = useLoad(fetchCatalog, []);
  const prompts = useLoad(listPrompts, []);
  const [input, setInput] = useState<VlmInput | null>(null); // shared by the builder's runs and the agents
  return (
    <Page title="Admin · AI workflows" subtitle="Build AI workflows across the modules (YOLO, ballet rules, CLIP, VLM) and LangChain agents; runs are executed by LangGraph on the manager.">
      <Tabs value={tab} onChange={setTab} tabs={[["builder", "AI workflow builder"], ["agents", "Agents"], ["catalog", "Catalog & architecture"]]} />
      <ErrorBox error={catalog.error} />
      {catalog.data && tab === "builder" && <FlowBuilder catalog={catalog.data} prompts={prompts.data ?? []} onPromptsChanged={prompts.reload} input={input} onInput={setInput} />}
      {catalog.data && tab === "agents" && <AgentPlayground catalog={catalog.data} input={input} onInput={setInput} />}
      {catalog.data && tab === "catalog" && <CatalogView catalog={catalog.data} />}
    </Page>
  );
}
