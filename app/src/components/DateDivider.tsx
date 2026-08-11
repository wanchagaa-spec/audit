import { formatDateDivider } from "../lib/format";

export function DateDivider({ dateKey }: { dateKey: string }) {
  return (
    <div className="date-divider">
      <span>{formatDateDivider(dateKey)}</span>
    </div>
  );
}
