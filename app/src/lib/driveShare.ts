// Grants an invited member edit access to a shared book's spreadsheet via
// the Drive API, so a household/group can log transactions together
// (PLAN.md section 7).

import { getAccessToken } from "./googleAuth";

export async function shareSpreadsheetWithEmail(fileId: string, email: string): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "writer", type: "user", emailAddress: email }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`แชร์ไฟล์ไม่สำเร็จ (${res.status}): ${body}`);
  }
}
