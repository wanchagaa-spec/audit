import { useApp } from "../context/AppContext";
import { OnboardingPermissions } from "./OnboardingPermissions";

export function LoginGate() {
  const { googleConfigured, googleUser, syncError, signIn, continueAsGuest } = useApp();

  return (
    <div className="login-gate">
      <h1>จดบัญชี</h1>
      <p className="muted">แอปจดบัญชีรายรับ-รายจ่ายแบบแชท</p>

      <OnboardingPermissions />

      <button
        type="button"
        className="primary-button"
        disabled={!googleConfigured}
        onClick={() => void signIn()}
      >
        เข้าสู่ระบบด้วย Google
      </button>
      {!googleConfigured && (
        <p className="muted">ยังไม่ได้ตั้งค่า Google Client ID บนเว็บนี้ ล็อกอินไม่ได้ตอนนี้</p>
      )}
      {syncError && !googleUser && <p className="error">{syncError}</p>}

      <button type="button" className="link-button" onClick={continueAsGuest}>
        ใช้งานแบบไม่ล็อกอิน (เก็บข้อมูลในเครื่องนี้เท่านั้น)
      </button>
    </div>
  );
}
