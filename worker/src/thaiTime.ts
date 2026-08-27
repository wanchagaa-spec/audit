// Reading a time out of a short Thai reply (PLAN.md 17.80).
//
// Used when a photo of an appointment card gave a subject and a date but no
// readable time, and the bot asked for it. The input is therefore narrow —
// an answer to "กี่โมง" — not free text, which is what makes a
// deterministic parser the right tool instead of another model call.
//
// **Narrow on purpose.** Thai clock talk is genuinely ambiguous: "3 โมง" is
// nine in the morning under one reckoning and three in the afternoon under
// another, and people use both. Anything this cannot read without guessing
// is refused and asked again, because the whole point of the feature is not
// putting someone at a clinic at the wrong hour.

/** Digits, then the Thai spoken forms that carry their own half of the day.
 * Bare "N โมง" is accepted only for 6-11, where no Thai speaker means the
 * afternoon; 1-5 needs "บ่าย" or "ทุ่ม" to be unambiguous, so it is not
 * guessed at. */
export function parseThaiTime(raw: string): string | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const half = /ครึ่ง/.test(text) ? 30 : 0;

  const pad = (h: number, m: number) =>
    h >= 0 && h <= 23 && m >= 0 && m <= 59 ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` : null;

  if (/^เที่ยงคืน/.test(text)) return pad(0, half);
  if (/^เที่ยง/.test(text)) return pad(12, half);

  // 09:30, 9:30, 09.30, 9.30 — the written forms, and the only ones where
  // the minutes come from the text rather than from "ครึ่ง".
  const digits = text.match(/^(\d{1,2})[:.](\d{2})/);
  if (digits) return pad(Number(digits[1]), Number(digits[2]));

  // ตี 5 → 05:00. Covers 1-5; "ตี 6" is not something people say.
  const dawn = text.match(/^ตี\s*(\d{1,2})/);
  if (dawn) {
    const h = Number(dawn[1]);
    return h >= 1 && h <= 5 ? pad(h, half) : null;
  }

  // บ่าย 2 / บ่ายสองโมง → 14:00. บ่ายโมง on its own is one o'clock.
  const afternoon = text.match(/^บ่าย\s*(\d{1,2})?/);
  if (afternoon) {
    const h = afternoon[1] ? Number(afternoon[1]) : 1;
    return h >= 1 && h <= 5 ? pad(h + 12, half) : null;
  }

  // N ทุ่ม → 19:00–24:00 territory. 1 ทุ่ม is seven in the evening.
  const evening = text.match(/^(\d{1,2})\s*ทุ่ม/);
  if (evening) {
    const h = Number(evening[1]);
    return h >= 1 && h <= 5 ? pad(h + 18, half) : null;
  }

  // N โมงเช้า is explicit; bare N โมง is only safe from 6 to 11.
  const morning = text.match(/^(\d{1,2})\s*โมง(เช้า)?/);
  if (morning) {
    const h = Number(morning[1]);
    if (morning[2]) return h >= 1 && h <= 11 ? pad(h, half) : null;
    return h >= 6 && h <= 11 ? pad(h, half) : null;
  }

  // A bare number is not a time. "9" could be nine in the morning or nine at
  // night, and this is the one place guessing is not affordable.
  return null;
}
