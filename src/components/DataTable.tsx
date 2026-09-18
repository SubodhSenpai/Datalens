"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface DataTableProps {
  data: Record<string, unknown>[];
  columns: string[];
  pageSize?: number;
}

export default function DataTable({ data, columns, pageSize = 10 }: DataTableProps) {
  const [page, setPage] = useState(0);
  const totalPages = Math.ceil(data.length / pageSize);
  const pageData   = data.slice(page * pageSize, (page + 1) * pageSize);

  const formatCell = (value: unknown): string => {
    if (value === null || value === undefined) return "—";
    if (typeof value === "number")
      return Number.isInteger(value)
        ? value.toLocaleString()
        : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return String(value);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-xl border-2 border-ink">
        <table className="w-full border-collapse text-[13px] min-w-[400px]">
          <thead>
            <tr>
              {columns.map(col => (
                <th key={col} className="px-3.5 py-2.5 text-left text-[11px] font-bold uppercase tracking-widest bg-mustard border-b-2 border-ink whitespace-nowrap sticky top-0">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageData.map((row, i) => (
              <tr key={i} className="hover:bg-mint/50 transition-colors even:bg-bg-surface">
                {columns.map(col => (
                  <td key={col} className="px-3.5 py-2.5 font-medium border-b border-ink/15 last:border-0 whitespace-nowrap max-w-[240px] overflow-hidden text-ellipsis">
                    {formatCell(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="text-xs text-text-secondary font-semibold">
            {page * pageSize + 1}–{Math.min((page + 1) * pageSize, data.length)} of {data.length.toLocaleString()}
          </span>
          <div className="flex items-center gap-1">
            <button
              id="table-prev-btn"
              className="btn-ghost px-2 py-1 text-xs disabled:opacity-40"
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft size={13} /> Prev
            </button>
            <span className="text-xs font-bold px-2">{page + 1} / {totalPages}</span>
            <button
              id="table-next-btn"
              className="btn-ghost px-2 py-1 text-xs disabled:opacity-40"
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page === totalPages - 1}
            >
              Next <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
