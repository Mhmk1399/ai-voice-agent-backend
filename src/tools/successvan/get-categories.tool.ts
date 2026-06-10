import { contextProvider } from "../../context/successvan-context.provider.js";
import type { Tool, ToolOutput } from "../tool.types.js";
import type { CategoryContext } from "../../context/context-provider.interface.js";

interface GetCategoriesInput {
  officeId?: string;
}

export const getCategoriesTool: Tool<GetCategoriesInput, CategoryContext[]> = {
  name: "getCategories",
  description:
    "Get active vehicle categories, optionally filtered by office ID.",

  async execute(input: GetCategoriesInput): Promise<ToolOutput & { data?: CategoryContext[] }> {
    const ctx = await contextProvider.load();
    let cats = ctx.categories;
    if (input.officeId) {
      cats = cats.filter(
        (c) => !c.officeId || c.officeId === input.officeId
      );
    }
    return { success: true, data: cats };
  },
};
