import { ChartType } from "../types";

// OpenAI-compatible function-calling tool shape, as accepted by the `tools`
// param on chat.completions.create (works for OpenRouter-hosted models too).
export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
}

export interface ChartTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
  };
  /** The ChartType this tool's invocation maps back to when executing the plan. */
  chartType: ChartType;
}
