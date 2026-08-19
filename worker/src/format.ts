// The two formatters every reply in this bot goes through, split out of
// commands.ts (PLAN.md 17.59) purely to break an import cycle.
//
// commands.ts builds the month summary, which now needs the recurring-bill
// block; the code that builds that block needs formatBaht. Leaving both in
// commands.ts would have made commands.ts and the recurring module import
// each other — the exact cycle viewAuth.ts already duplicates a one-line
// helper to avoid. These two depend on nothing but the category list, so
// they are the right things to move rather than duplicate.
//
// commands.ts re-exports both, so every existing import of them still works.

import { DEFAULT_CATEGORIES } from "./categories.ts";

export function formatBaht(n: number): string {
  return n.toLocaleString("th-TH", { maximumFractionDigits: 2 });
}

export function categoryLabel(categoryId: string): string {
  const cat = DEFAULT_CATEGORIES.find((c) => c.id === categoryId);
  return `${cat?.icon ?? "📦"} ${cat?.name ?? "อื่น ๆ"}`;
}
