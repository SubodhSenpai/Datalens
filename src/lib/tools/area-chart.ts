import { ChartTool } from "./types";

export const areaChartTool: ChartTool = {
  type: "function",
  chartType: "area",
  function: {
    name: "render_area_chart",
    description:
      "Render a filled area chart of a numeric value over an ordered axis (typically time). Best for cumulative totals, running totals, or 'over time' questions where the magnitude under the curve matters, not just the direction of a trend line. The x-axis column should be date-bucketed (day/month/year), not a raw high-cardinality timestamp. Prefer render_line_chart for simple trend lines with multiple series that would overlap if filled.",
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
          description: "One or more numeric columns to plot as stacked/overlaid areas over the x-axis.",
        },
        stacked: {
          type: "boolean",
          description: "Whether multiple yKeys should stack on top of each other (true) or overlay with transparency (false). Defaults to false.",
        },
        title: { type: "string", description: "Short, human-readable chart title." },
      },
      required: ["xKey", "yKeys"],
    },
  },
};
