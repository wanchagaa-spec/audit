export function OnboardingPermissions() {
  return (
    <div className="onboarding-permissions">
      <p>แอปนี้จะขอสิทธิ์:</p>
      <ul>
        <li>สร้างและแก้ไข <strong>เฉพาะไฟล์ Google Sheets ที่แอปสร้างขึ้นเอง</strong> หรือไฟล์ที่คุณเลือกเปิดผ่านหน้าต่างเลือกไฟล์ของ Google</li>
        <li>จะ<strong>ไม่เข้าถึง</strong>ไฟล์อื่นในไดรฟ์ของคุณ</li>
      </ul>
      <p>ข้อมูลทั้งหมดเก็บอยู่ในไดรฟ์ของคุณเอง แอปไม่มีเซิร์ฟเวอร์เก็บข้อมูลของคุณแยกต่างหาก</p>
    </div>
  );
}
