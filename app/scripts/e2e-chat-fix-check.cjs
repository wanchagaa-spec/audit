const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));

  await page.goto("http://localhost:5175/", { waitUntil: "networkidle" });
  await page.getByText("ใช้งานแบบไม่ล็อกอิน").click();
  await page.waitForTimeout(300);

  const input = page.getByPlaceholder("พิมพ์รายการ เช่น ซื้อกาแฟ 60");

  await input.fill("สวัสดี");
  await page.getByRole("button", { name: "ส่ง" }).click();
  await page.waitForTimeout(300);

  await input.fill("เงินเข้า 16000");
  await page.getByRole("button", { name: "ส่ง" }).click();
  await page.waitForTimeout(300);

  await page.screenshot({ path: "/tmp/chat-fix-check.png", fullPage: true });

  const body = await page.textContent("body");
  console.log("NOT_ASKED_AMOUNT_FOR_GREETING:", !body.includes("จำนวนเงินเท่าไหร่คะ"));
  console.log("SHOWS_16000:", body.includes("16,000"));
  console.log("SHOWS_INCOME_CATEGORY:", body.includes("เงินโอน") || body.includes("ได้รับ"));

  await browser.close();
})().catch((err) => {
  console.error("E2E_FAILED", err);
  process.exit(1);
});
