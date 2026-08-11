import { useState } from "react";
import { useApp } from "../context/AppContext";
import { generateId } from "../lib/id";

export function BookSwitcher() {
  const { books, currentBookId, switchBook, addBook } = useApp();
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");

  async function createGroupBook() {
    const trimmed = name.trim();
    if (!trimmed) return;
    await addBook({ id: generateId(), name: trimmed, kind: "group", members: [] });
    setName("");
    setShowNew(false);
  }

  return (
    <div className="book-switcher">
      <select value={currentBookId} onChange={(e) => switchBook(e.target.value)}>
        {books.map((b) => (
          <option key={b.id} value={b.id}>
            {b.kind === "group" ? "👥 " : "👤 "}
            {b.name}
          </option>
        ))}
      </select>
      {showNew ? (
        <div className="new-book-form">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ชื่อสมุดกลุ่ม เช่น ค่าใช้จ่ายบ้าน"
          />
          <button type="button" onClick={createGroupBook}>
            สร้าง
          </button>
          <button type="button" onClick={() => setShowNew(false)}>
            ยกเลิก
          </button>
        </div>
      ) : (
        <button type="button" className="link-button" onClick={() => setShowNew(true)}>
          + สร้างสมุดกลุ่ม
        </button>
      )}
    </div>
  );
}
