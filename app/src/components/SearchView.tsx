import { useMemo, useState } from "react";
import { useApp } from "../context/AppContext";
import { formatBaht } from "../lib/format";

export function SearchView() {
  const { transactions, categories, currentBookId } = useApp();
  const [keyword, setKeyword] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const results = useMemo(() => {
    return transactions
      .filter((t) => t.bookId === currentBookId)
      .filter((t) => !keyword || t.note.toLowerCase().includes(keyword.toLowerCase()) || t.rawText.toLowerCase().includes(keyword.toLowerCase()))
      .filter((t) => !categoryId || t.categoryId === categoryId)
      .filter((t) => !from || t.date >= from)
      .filter((t) => !to || t.date <= to)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, currentBookId, keyword, categoryId, from, to]);

  return (
    <div className="search-view">
      <div className="search-filters">
        <input placeholder="ค้นหาคำ" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">ทุกหมวดหมู่</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.icon} {c.name}
            </option>
          ))}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span>ถึง</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      <ul className="search-results">
        {results.map((t) => {
          const c = categories.find((cat) => cat.id === t.categoryId);
          return (
            <li key={t.id}>
              <span className="search-date">{t.date}</span>
              <span>
                {c?.icon} {c?.name}
              </span>
              <span className="search-note">{t.note}</span>
              <span className={t.type}>
                {t.type === "income" ? "+" : "-"}
                {formatBaht(t.amount)} บาท
              </span>
            </li>
          );
        })}
        {results.length === 0 && <li className="muted">ไม่พบรายการ</li>}
      </ul>
    </div>
  );
}
