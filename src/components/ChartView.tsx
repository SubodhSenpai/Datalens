"use client";

import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ScatterChart, Scatter, ZAxis, AreaChart, Area,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
} from "recharts";
import { ChartType, ChartDataPoint, ChartConfig } from "@/lib/types";
import { CHART_COLORS } from "@/lib/utils";

interface ChartViewProps {
  type: ChartType;
  data: ChartDataPoint[];
  config?: ChartConfig;
}

const TOOLTIP_STYLE = {
  backgroundColor: "#FFFDF7",
  border: "2px solid #1B1A15",
  borderRadius: "10px",
  color: "#1B1A15",
  fontSize: 12,
  fontWeight: 600,
};

const AXIS_STYLE = { fontSize: 11, fill: "#4A4739", fontWeight: 600 };

export default function ChartView({ type, data, config }: ChartViewProps) {
  const xKey   = config?.xKey   ?? "label";
  const yKeys  = config?.yKeys  ?? ["value"];
  const colors = config?.colors ?? CHART_COLORS;

  if (!data || data.length === 0 || type === "none") {
    return (
      <div className="flex items-center justify-center h-40 border-2 border-dashed border-ink rounded-xl text-text-secondary text-sm font-medium bg-bg-surface">
        No chart visualization available.
      </div>
    );
  }

  const isNumericX = data.length > 0 && typeof data[0][xKey] === "number";

  return (
    <div className="flex flex-col gap-3">
      {config?.title && <h4 className="text-sm font-bold">{config.title}</h4>}
      <div className="overflow-hidden rounded-xl border-2 border-ink bg-bg-card p-2">
        <ResponsiveContainer width="100%" height={300}>
          {type === "bar" || type === "histogram" ? (
            <BarChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,26,21,0.12)" />
              <XAxis dataKey={xKey} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "rgba(242,199,68,0.15)" }} />
              {yKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: "#4A4739", fontWeight: 600 }} />}
              {yKeys.map((key, i) => (
                <Bar key={key} dataKey={key} fill={colors[i % colors.length]} stroke="#1B1A15" strokeWidth={1.5} radius={[6, 6, 0, 0]} />
              ))}
            </BarChart>
          ) : type === "stacked-bar" ? (
            <BarChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,26,21,0.12)" />
              <XAxis dataKey={xKey} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "rgba(242,199,68,0.15)" }} />
              {yKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: "#4A4739", fontWeight: 600 }} />}
              {yKeys.map((key, i) => (
                <Bar key={key} dataKey={key} stackId="stacked" fill={colors[i % colors.length]} stroke="#1B1A15" strokeWidth={1.5} />
              ))}
            </BarChart>
          ) : type === "area" ? (
            <AreaChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,26,21,0.12)" />
              <XAxis dataKey={xKey} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              {yKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: "#4A4739", fontWeight: 600 }} />}
              {yKeys.map((key, i) => (
                <Area key={key} type="monotone" dataKey={key} fill={colors[i % colors.length]} stroke={colors[i % colors.length]} fillOpacity={0.35} strokeWidth={2} />
              ))}
            </AreaChart>
          ) : type === "line" ? (
            <LineChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,26,21,0.12)" />
              <XAxis dataKey={xKey} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              {yKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: "#4A4739", fontWeight: 600 }} />}
              {yKeys.map((key, i) => (
                <Line key={key} type="monotone" dataKey={key} stroke={colors[i % colors.length]}
                  strokeWidth={3} dot={{ r: 4, fill: colors[i % colors.length], stroke: "#1B1A15", strokeWidth: 1.5 }} activeDot={{ r: 6, stroke: "#1B1A15", strokeWidth: 2 }} />
              ))}
            </LineChart>
          ) : type === "dot" ? (
            <LineChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,26,21,0.12)" />
              <XAxis dataKey={xKey} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              {yKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: "#4A4739", fontWeight: 600 }} />}
              {yKeys.map((key, i) => (
                <Line key={key} type="monotone" dataKey={key} stroke="transparent"
                  dot={{ r: 5, fill: colors[i % colors.length], stroke: "#1B1A15", strokeWidth: 1.5 }} activeDot={{ r: 7, stroke: "#1B1A15", strokeWidth: 2 }} />
              ))}
            </LineChart>
          ) : type === "pie" ? (
            <PieChart>
              <Pie data={data} dataKey="value" nameKey={xKey} cx="50%" cy="50%"
                outerRadius={110} innerRadius={50} paddingAngle={3}>
                {data.map((_, idx) => (
                  <Cell key={idx} fill={colors[idx % colors.length]} stroke="#1B1A15" strokeWidth={2} />
                ))}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 12, color: "#4A4739", fontWeight: 600 }} />
            </PieChart>
          ) : type === "scatter" ? (
            <ScatterChart margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,26,21,0.12)" />
              <XAxis dataKey={xKey} type={isNumericX ? "number" : "category"} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <YAxis dataKey="value" type="number" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <ZAxis range={[40, 160]} />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ strokeDasharray: "3 3" }} />
              <Scatter data={data} fill={colors[0]} stroke="#1B1A15" strokeWidth={1.5} />
            </ScatterChart>
          ) : type === "radar" ? (
            <RadarChart cx="50%" cy="50%" outerRadius={90} data={data}>
              <PolarGrid stroke="rgba(27,26,21,0.15)" />
              <PolarAngleAxis dataKey={xKey} tick={AXIS_STYLE} />
              <PolarRadiusAxis tick={AXIS_STYLE} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              {yKeys.map((key, i) => (
                <Radar key={key} name={key} dataKey={key} stroke={colors[i % colors.length]} fill={colors[i % colors.length]} fillOpacity={0.4} />
              ))}
              {yKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: "#4A4739", fontWeight: 600 }} />}
            </RadarChart>
          ) : (
            <BarChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,26,21,0.12)" />
              <XAxis dataKey={xKey} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "rgba(242,199,68,0.15)" }} />
              {yKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: "#4A4739", fontWeight: 600 }} />}
              {yKeys.map((key, i) => (
                <Bar key={key} dataKey={key} fill={colors[i % colors.length]} stroke="#1B1A15" strokeWidth={1.5} radius={[6, 6, 0, 0]} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
