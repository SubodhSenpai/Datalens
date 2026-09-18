import { ChartTool } from "./types";

export const noChartTool: ChartTool = {
  type: "function",
  chartType: "none",
  function: {
    name: "render_table_only",
    description:
      "Skip charting and show only the tabular result. Use this for single-scalar answers (one row, one number), raw row listings/previews, or any question a chart wouldn't clarify.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};
