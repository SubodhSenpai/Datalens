import { ChartTool } from "./types";

export const lineChartTool: ChartTool = {
  type: "function",
  chartType: "line",
  function: {
    name: "render_line_chart",
    description:
      "Render a line chart of a numeric value against an ordered axis (typically time). Best for trend, 'over time', monthly/yearly, and timeline questions. The x-axis column should be date-bucketed (day/month/year) before this is used, not a raw high-cardinality timestamp.",
    parameters: {
      type: "object",
      properties: {
        xKey: {
          type: "string",
          description: "Ordered column (usually a bucketed date) to use as the x-axis.",
        },
        yKeys: {
          type: "array",
          items: { type: "string" },
          description: "One or more numeric columns to plot as lines over the x-axis (multiple keys render multiple lines).",
        },
        title: { type: "string", description: "Short, human-readable chart title." },
      },
      required: ["xKey", "yKeys"],
    },
  },
};
