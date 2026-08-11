const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const logs = [];
  page.on("console", (msg) => logs.push(`[console.${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));

  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  await page.screenshot({ path: "/tmp/1-initial.png" });

  const input = page.getByPlaceholder("พิมพ์รายการ เช่น ซื้อกาแฟ 60");
  await input.fill("ซื้อกาแฟ 60");
  await page.getByRole("button", { name: "ส่ง" }).click();
  await page.waitForTimeout(300);

  await input.fill("เงินเดือนเข้า 25000");
  await page.getByRole("button", { name: "ส่ง" }).click();
  await page.waitForTimeout(300);

  // Trigger a clarification flow: no amount.
  await input.fill("ซื้อของ");
  await page.getByRole("button", { name: "ส่ง" }).click();
  await page.waitForTimeout(300);
  await input.fill("120");
  await page.getByRole("button", { name: "ส่ง" }).click();
  await page.waitForTimeout(300);

  await page.screenshot({ path: "/tmp/2-after-chat.png", fullPage: true });

  const bodyText = await page.textContent("body");
  logs.push(`BODY_CONTAINS_60: ${bodyText.includes("60")}`);
  logs.push(`BODY_CONTAINS_25,000: ${bodyText.includes("25,000")}`);
  logs.push(`BODY_CONTAINS_120: ${bodyText.includes("120")}`);

  // Switch to dashboard tab.
  await page.getByRole("button", { name: /สรุป/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/3-dashboard.png", fullPage: true });

  // Switch to settings tab.
  await page.getByRole("button", { name: /ตั้งค่า/ }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/4-settings.png", fullPage: true });

  console.log(logs.join("\n"));
  await browser.close();
})().catch((err) => {
  console.error("E2E_FAILED", err);
  process.exit(1);
});
