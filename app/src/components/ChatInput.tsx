import { useState } from "react";
import type { FormEvent } from "react";

export function ChatInput({ onSend }: { onSend: (text: string) => void }) {
  const [value, setValue] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue("");
  }

  return (
    <form className="chat-input" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="พิมพ์รายการ เช่น ซื้อกาแฟ 60"
        aria-label="พิมพ์รายการ"
      />
      <button type="submit" disabled={!value.trim()}>
        ส่ง
      </button>
    </form>
  );
}
