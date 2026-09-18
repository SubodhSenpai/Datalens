import { ChartTool } from "./types";
import { barChartTool } from "./bar-chart";
import { stackedBarChartTool } from "./stacked-bar-chart";
import { dotPlotChartTool } from "./dot-plot-chart";
import { lineChartTool } from "./line-chart";
import { areaChartTool } from "./area-chart";
import { pieChartTool } from "./pie-chart";
import { scatterChartTool } from "./scatter-chart";
import { histogramChartTool } from "./histogram-chart";
import { radarChartTool } from "./radar-chart";
import { treemapChartTool } from "./treemap-chart";
import { heatmapChartTool } from "./heatmap-chart";
import { noChartTool } from "./no-chart";

export * from "./types";
export {
  barChartTool,
  stackedBarChartTool,
  dotPlotChartTool,
  lineChartTool,
  areaChartTool,
  pieChartTool,
  scatterChartTool,
  histogramChartTool,
  radarChartTool,
  treemapChartTool,
  heatmapChartTool,
  noChartTool,
};

// Full tool list to pass as `tools` on a chat.completions.create call so the
// model picks the chart (if any) that fits the question, instead of us
// asking it to freehand a chartType string field.
export const CHART_TOOLS: ChartTool[] = [
  barChartTool,
  stackedBarChartTool,
  dotPlotChartTool,
  lineChartTool,
  areaChartTool,
  pieChartTool,
  scatterChartTool,
  histogramChartTool,
  radarChartTool,
  treemapChartTool,
  heatmapChartTool,
  noChartTool,
];

export const CHART_TOOLS_BY_NAME: Record<string, ChartTool> = Object.fromEntries(
  CHART_TOOLS.map((tool) => [tool.function.name, tool])
);
