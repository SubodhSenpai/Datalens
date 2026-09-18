import { ChartTool } from "./types";

export const heatmapChartTool: ChartTool = {
  type: "function",
  chartType: "heatmap",
  function: {
    name: "render_heatmap",
    description:
      "Render a heatmap: a grid of two categorical dimensions with a numeric value shown as color intensity at each intersection. Best for questions that need a value broken down by TWO categories at once (e.g. 'revenue by region and month'), where the goal is spotting patterns, clusters, or outliers across many combinations rather than reading exact numbers. Needs a reasonably dense grid (roughly 9+ cells) to be worth it — for a single category dimension, use render_bar_chart or render_dot_plot instead.",
    parameters: {
      type: "object",
      properties: {
        rowKey: {
          type: "string",
          description: "Categorical column for the grid's rows.",
        },
        columnKey: {
          type: "string",
          description: "Categorical column for the grid's columns.",
        },
        valueKey: {
          type: "string",
          description: "Numeric column whose value sets each cell's color intensity.",
        },
        title: { type: "string", description: "Short, human-readable chart title." },
      },
      required: ["rowKey", "columnKey", "valueKey"],
    },
  },
};
