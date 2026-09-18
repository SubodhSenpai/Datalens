import { ChartTool } from "./types";

export const scatterChartTool: ChartTool = {
  type: "function",
  chartType: "scatter",
  function: {
    name: "render_scatter_chart",
    description:
      "Render a scatter plot of one numeric column against another, one point per row. Best for 'relationship between', 'correlation', or 'X vs Y' questions comparing two numeric measures.",
    parameters: {
      type: "object",
      properties: {
        xKey: { type: "string", description: "Numeric column for the x-axis." },
        yKey: { type: "string", description: "Numeric column for the y-axis." },
        title: { type: "string", description: "Short, human-readable chart title." },
      },
      required: ["xKey", "yKey"],
    },
  },
};
