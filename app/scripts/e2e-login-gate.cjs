const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));

  await page.goto("http://localhost:5174/", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/login-1-gate.png" });

  const bodyText = await page.textContent("body");
  console.log("SHOWS_LOGIN_HEADING:", bodyText.includes("จดบัญชี"));
  console.log("SHOWS_GOOGLE_BUTTON:", bodyText.includes("เข้าสู่ระบบด้วย Google"));
  console.log("SHOWS_GUEST_BUTTON:", bodyText.includes("ใช้งานแบบไม่ล็อกอิน"));
  console.log("HAS_CHAT_TABS_BEFORE_SKIP:", bodyText.includes("แชท") && bodyText.includes("ตั้งค่า"));

  await page.getByText("ใช้งานแบบไม่ล็อกอิน").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/login-2-after-skip.png" });

  const afterSkip = await page.textContent("body");
  console.log("HAS_CHAT_INPUT_AFTER_SKIP:", afterSkip.includes("พิมพ์รายการ"));

  // Reload to confirm the skip choice persists (doesn't show login gate again).
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const afterReload = await page.textContent("body");
  console.log("STAYS_LOGGED_OUT_OF_GATE_AFTER_RELOAD:", afterReload.includes("พิมพ์รายการ"));
  await page.screenshot({ path: "/tmp/login-3-after-reload.png" });

  await browser.close();
})().catch((err) => {
  console.error("E2E_FAILED", err);
  process.exit(1);
});
