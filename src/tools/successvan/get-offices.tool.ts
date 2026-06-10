import { contextProvider } from "../../context/successvan-context.provider.js";
import type { Tool, ToolOutput } from "../tool.types.js";
import type { OfficeContext } from "../../context/context-provider.interface.js";

export const getOfficesTool: Tool<Record<string, never>, OfficeContext[]> = {
  name: "getOffices",
  description: "Get all active SuccessVan offices from the database.",

  async execute(): Promise<ToolOutput & { data?: OfficeContext[] }> {
    const ctx = await contextProvider.load();
    return { success: true, data: ctx.offices };
  },
};
