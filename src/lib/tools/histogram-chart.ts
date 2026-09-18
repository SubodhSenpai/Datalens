import { ChartTool } from "./types";

export const histogramChartTool: ChartTool = {
  type: "function",
  chartType: "histogram",
  function: {
    name: "render_histogram",
    description:
      "Render a histogram showing how the values of a single numeric column are distributed across binned ranges. Best for 'distribution of X', 'spread of X', or 'how is X distributed' questions — not for comparing categories (use render_bar_chart) or showing a value over time (use render_line_chart).",
    parameters: {
      type: "object",
      properties: {
        valueKey: {
          type: "string",
          description: "Numeric column whose distribution should be plotted.",
        },
        bins: {
          type: "number",
          description: "Number of equal-width bins to split the value range into. Defaults to 10.",
        },
        title: { type: "string", description: "Short, human-readable chart title." },
      },
      required: ["valueKey"],
    },
  },
};
