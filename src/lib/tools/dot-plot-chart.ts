import { ChartTool } from "./types";

export const dotPlotChartTool: ChartTool = {
  type: "function",
  chartType: "dot",
  function: {
    name: "render_dot_plot",
    description:
      "Render a Cleveland dot plot: one dot per category positioned along a value axis, instead of a bar. Prefer this over render_bar_chart once there are more than about a dozen categories to compare — bars start crowding and their shared axis baseline adds visual weight that dots don't need, making dots easier to scan and compare precisely at that scale.",
    parameters: {
      type: "object",
      properties: {
        categoryKey: {
          type: "string",
          description: "Categorical column, one dot per distinct value.",
        },
        valueKey: {
          type: "string",
          description: "Numeric column determining each dot's position on the value axis.",
        },
        title: { type: "string", description: "Short, human-readable chart title." },
      },
      required: ["categoryKey", "valueKey"],
    },
  },
};
