# จดบัญชี — Chat Expense Tracker

แอปจดบัญชีรายรับ-รายจ่ายแบบแชท (PWA) ตามแผนใน [`../PLAN.md`](../PLAN.md)
ทุกอย่างรันในเบราว์เซอร์ ไม่มีเซิร์ฟเวอร์ของตัวเอง — ข้อมูลเก็บในเครื่อง (IndexedDB)
และซิงก์ขึ้น Google Sheets ของผู้ใช้แต่ละคนเอง

## รันตอน dev

```bash
npm install
npm run dev
```

เปิด Phase 1 (แชท + parsing + เก็บ local) ใช้งานได้ทันทีโดยไม่ต้องตั้งค่าอะไรเพิ่ม

## การตั้งค่า Google Cloud (จำเป็นสำหรับ Phase 2–3: login / sync / แชร์สมุดกลุ่ม)

1. สร้างโปรเจกต์ใหม่ที่ [Google Cloud Console](https://console.cloud.google.com/)
2. เปิดใช้ API สามตัว: **Google Sheets API**, **Google Drive API**, **Google Picker API**
3. ไปที่ "OAuth consent screen" ตั้งเป็น External + เพิ่มอีเมลทดสอบของคุณ (ระหว่างพัฒนา)
4. ไปที่ "Credentials" สร้าง:
   - **OAuth client ID** ชนิด Web application — ใส่ Authorized JavaScript origins เป็น
     `http://localhost:5173` (dev) และโดเมนที่จะ deploy จริง (เช่น
     `https://<user>.github.io`)
   - **API key** — ใช้กับ Google Picker
5. คัดลอก `.env.example` เป็น `.env.local` แล้วใส่ค่า:

   ```
   VITE_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
   VITE_GOOGLE_API_KEY=xxxx
   ```

6. รัน `npm run dev` ใหม่ — ปุ่ม "เข้าสู่ระบบด้วย Google" ในหน้าตั้งค่าจะใช้งานได้

สิทธิ์ที่ขอมีแค่ `drive.file` (เฉพาะไฟล์ที่แอปสร้างเอง หรือไฟล์ที่ผู้ใช้เลือกผ่าน Picker)
ตามที่อธิบายไว้ในหน้าตั้งค่าของแอป

## Deploy ขึ้น GitHub Pages (ฟรีถาวร)

มี workflow ให้แล้วที่ `.github/workflows/deploy.yml` — พุชขึ้น branch `main` แล้วเปิด
ใช้งาน GitHub Pages (Settings → Pages → Source: GitHub Actions) ระบบจะ build/deploy ให้อัตโนมัติ

ถ้าจะใช้ Google Sign-In บนเว็บที่ deploy จริง ต้องเพิ่ม secrets ที่ repo
(Settings → Secrets → Actions): `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY` และเพิ่ม
โดเมน GitHub Pages ของคุณใน Authorized JavaScript origins ของ OAuth client ด้วย

ทางเลือกอื่นที่ฟรีถาวรเหมือนกัน: Cloudflare Pages (เชื่อม repo แล้วตั้ง build command เป็น
`npm run build`, output directory เป็น `dist`, root directory เป็น `app`)

## โครงสร้างโค้ดคร่าว ๆ

- `src/lib/parser.ts`, `src/lib/chatEngine.ts` — ตีความข้อความ + flow ถามกลับเมื่อไม่ชัดเจน
- `src/lib/db.ts` — IndexedDB (offline-first storage)
- `src/lib/googleAuth.ts`, `sheetsService.ts`, `driveShare.ts`, `googlePicker.ts`, `sync.ts` — เชื่อม Google Sheets/Drive
- `src/lib/notifications.ts` — แจ้งเตือนจดบัญชีตามเวลาที่ตั้ง
- `src/context/AppContext.tsx` — state กลางของแอปทั้งหมด
- `src/components/` — หน้าจอ: แชท (`ChatView`), สรุป/กราฟ (`Dashboard`), ค้นหา (`SearchView`), ตั้งค่า (`Settings`)

## ข้อจำกัดที่รู้อยู่แล้ว (ตรงกับ PLAN.md)

- การซิงก์ระหว่างอุปกรณ์เป็นแบบ "union by id" — รายการที่ถูกลบในเครื่องหนึ่งจะยังไม่หายจาก
  Google Sheets จนกว่าจะซิงก์ครบทุกฝั่ง (แผนถัดไปคือใส่ tombstone/สถานะลบ)
- แจ้งเตือนตามเวลาที่ตั้งแม่นยำเต็มที่บน Android/Chrome เท่านั้น บน iOS Safari มีข้อจำกัดเรื่อง
  การแจ้งเตือนพื้นหลังของเบราว์เซอร์เอง (ดู `src/lib/notifications.ts`)
- Parsing ข้อความเป็นแบบ rule-based (regex + dictionary) ยังไม่ใช่ AI — ตั้งใจไว้แบบนั้นเพื่อให้
  ไม่มีค่าใช้จ่ายต่อการใช้งาน (ดูตัวเลือกอัปเกรดเป็น LLM แบบใส่ API key เองใน PLAN.md เฟส 4)

## Smoke test

`scripts/e2e-check.cjs` ใช้ Playwright เปิดแอปจริงแล้วลองจดรายการ/ตอบคำถามบอต/ดูกราฟ
ใช้ตอน dev server รันอยู่ (`npm run dev`) แล้วรัน `node scripts/e2e-check.cjs`
