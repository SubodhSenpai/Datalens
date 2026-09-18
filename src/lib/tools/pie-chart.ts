import { ChartTool } from "./types";

export const pieChartTool: ChartTool = {
  type: "function",
  chartType: "pie",
  function: {
    name: "render_pie_chart",
    description:
      "Render a pie chart showing a single numeric value's share across categories. Best for 'proportion', 'share', 'breakdown', or 'distribution' questions with a small number of categories (roughly 2-8). Do not use for more categories than that — prefer a bar chart instead.",
    parameters: {
      type: "object",
      properties: {
        categoryKey: {
          type: "string",
          description: "Categorical column whose distinct values become pie slices.",
        },
        valueKey: {
          type: "string",
          description: "Single numeric column whose value determines each slice's size.",
        },
        title: { type: "string", description: "Short, human-readable chart title." },
      },
      required: ["categoryKey", "valueKey"],
    },
  },
};
