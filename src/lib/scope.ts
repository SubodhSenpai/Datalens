/**
 * Detects a question that names an uploaded file the user left out of the
 * selection. The planner never sees an unselected file, so it either gives
 * up or answers from whatever else is in scope — and both read as a bad
 * answer when the real cause is an unticked box in the file picker.
 *
 * Purely structural: the question's words are compared with the session's
 * own file names. "book_loans.csv" is mentioned by a question containing
 * both "book" and "loans"; "branches.xlsx — Branches_2025" by one containing
 * "branches".
 */
export function findUnselectedMentioned(
  question: string,
  datasets: { id: string; name: string }[],
  selectedIds: Iterable<string>
): string[] {
  const selected = new Set(selectedIds);
  const words = new Set(question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));

  return datasets
    .filter((d) => !selected.has(d.id))
    .filter((d) => {
      // Sheet suffix first ("file.xlsx — Sheet"), then the extension.
      const stem = d.name.toLowerCase().split(/\s+—\s+/)[0].replace(/\.(csv|xlsx|xls)$/, "");
      if (stem.length < 3) return false;
      if (words.has(stem)) return true;
      const parts = stem.split(/[^a-z0-9]+/).filter((p) => p.length >= 4);
      return parts.length > 0 && parts.every((p) => words.has(p));
    })
    .map((d) => d.name);
}
