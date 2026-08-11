import type { EntryType } from "../types";
import { formatBaht, formatTime } from "../lib/format";

export interface AmountBadge {
  type: EntryType;
  amount: number;
  categoryIcon: string;
  categoryName: string;
}

export interface MessageBubbleProps {
  align: "left" | "right" | "center";
  authorName?: string;
  text: string;
  time: string;
  amountBadge?: AmountBadge;
  onEdit?: () => void;
  onDelete?: () => void;
}

export function MessageBubble({
  align,
  authorName,
  text,
  time,
  amountBadge,
  onEdit,
  onDelete,
}: MessageBubbleProps) {
  if (align === "center") {
    return (
      <div className="bubble-row center">
        <div className="bubble system">{text}</div>
      </div>
    );
  }

  return (
    <div className={`bubble-row ${align}`}>
      <div className={`bubble ${align === "right" ? "mine" : "theirs"}`}>
        {authorName && align === "left" && <div className="bubble-author">{authorName}</div>}
        <div className="bubble-text">{text}</div>
        {amountBadge && (
          <div className={`amount-badge ${amountBadge.type}`}>
            <span className="amount-badge-icon">{amountBadge.categoryIcon}</span>
            <span className="amount-badge-category">{amountBadge.categoryName}</span>
            <span className="amount-badge-amount">
              {amountBadge.type === "income" ? "+" : "-"}
              {formatBaht(amountBadge.amount)} บาท
            </span>
          </div>
        )}
        <div className="bubble-footer">
          <span className="bubble-time">{formatTime(time)}</span>
          {(onEdit || onDelete) && (
            <span className="bubble-actions">
              {onEdit && (
                <button type="button" onClick={onEdit} aria-label="แก้ไข">
                  แก้ไข
                </button>
              )}
              {onDelete && (
                <button type="button" onClick={onDelete} aria-label="ลบ">
                  ลบ
                </button>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
