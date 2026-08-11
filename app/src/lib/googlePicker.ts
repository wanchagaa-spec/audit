// Lets an invited member pick the shared spreadsheet a household/group
// admin sent them, without granting the app access to their whole Drive
// (PLAN.md section 7 — narrow drive.file scope via Picker selection).

import { getAccessToken } from "./googleAuth";

const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined;

let pickerApiLoaded: Promise<void> | null = null;

function loadPickerApi(): Promise<void> {
  if (pickerApiLoaded) return pickerApiLoaded;
  pickerApiLoaded = new Promise((resolve, reject) => {
    const gapi = (window as unknown as { gapi?: any }).gapi;
    if (gapi?.picker) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.onload = () => {
      (window as unknown as { gapi: any }).gapi.load("picker", { callback: resolve });
    };
    script.onerror = () => reject(new Error("โหลด Google Picker ไม่สำเร็จ"));
    document.head.appendChild(script);
  });
  return pickerApiLoaded;
}

export async function pickSharedSpreadsheet(): Promise<string | null> {
  if (!API_KEY) {
    throw new Error("ยังไม่ได้ตั้งค่า VITE_GOOGLE_API_KEY — ดูวิธีตั้งค่าใน README");
  }
  await loadPickerApi();
  const token = await getAccessToken();

  return new Promise((resolve) => {
    const google = (window as unknown as { google: any }).google;
    const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS).setMode(
      google.picker.DocsViewMode.LIST
    );
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .setCallback((data: any) => {
        if (data.action === google.picker.Action.PICKED) {
          resolve(data.docs[0].id as string);
        } else if (data.action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}
