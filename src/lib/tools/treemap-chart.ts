import { ChartTool } from "./types";

export const treemapChartTool: ChartTool = {
  type: "function",
  chartType: "treemap",
  function: {
    name: "render_treemap",
    description:
      "Render a treemap of nested rectangles sized by a numeric value per category. Best for part-to-whole / proportion questions with many categories (roughly 9+) where render_pie_chart would be too cluttered — the relative size of each rectangle shows its share of the total at a glance.",
    parameters: {
      type: "object",
      properties: {
        categoryKey: {
          type: "string",
          description: "Categorical column whose distinct values become treemap rectangles.",
        },
        valueKey: {
          type: "string",
          description: "Numeric column whose value determines each rectangle's size.",
        },
        title: { type: "string", description: "Short, human-readable chart title." },
      },
      required: ["categoryKey", "valueKey"],
    },
  },
};
