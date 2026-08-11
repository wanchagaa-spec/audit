// Wraps Google Identity Services (GIS) for sign-in + OAuth access tokens.
// Requires VITE_GOOGLE_CLIENT_ID (see .env.example) from a Google Cloud
// project with the Sheets, Drive, and Picker APIs enabled.

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface GoogleUser {
  id: string;
  email: string;
  name: string;
}

let scriptLoaded: Promise<void> | null = null;

function loadGisScript(): Promise<void> {
  if (scriptLoaded) return scriptLoaded;
  scriptLoaded = new Promise((resolve, reject) => {
    if (document.getElementById("gis-script")) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.id = "gis-script";
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("โหลด Google Identity Services ไม่สำเร็จ"));
    document.head.appendChild(script);
  });
  return scriptLoaded;
}

function decodeIdToken(idToken: string): GoogleUser {
  const payload = JSON.parse(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  return { id: payload.sub, email: payload.email, name: payload.name ?? payload.email };
}

export function isGoogleConfigured(): boolean {
  return Boolean(CLIENT_ID);
}

export async function signInWithGoogle(): Promise<GoogleUser> {
  if (!CLIENT_ID) {
    throw new Error(
      "ยังไม่ได้ตั้งค่า VITE_GOOGLE_CLIENT_ID — ดูวิธีตั้งค่าใน README ก่อนใช้ฟีเจอร์ล็อกอิน"
    );
  }
  await loadGisScript();
  return new Promise((resolve, reject) => {
    const google = (window as unknown as { google: any }).google;
    google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (response: { credential: string }) => {
        try {
          resolve(decodeIdToken(response.credential));
        } catch (err) {
          reject(err as Error);
        }
      },
    });
    google.accounts.id.prompt();
  });
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (!CLIENT_ID) {
    throw new Error("ยังไม่ได้ตั้งค่า VITE_GOOGLE_CLIENT_ID");
  }
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now()) {
    return cachedAccessToken.token;
  }
  await loadGisScript();
  return new Promise((resolve, reject) => {
    const google = (window as unknown as { google: any }).google;
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (response: { access_token: string; expires_in: number; error?: string }) => {
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        cachedAccessToken = {
          token: response.access_token,
          expiresAt: Date.now() + response.expires_in * 1000 - 60_000,
        };
        resolve(response.access_token);
      },
    });
    client.requestAccessToken();
  });
}
