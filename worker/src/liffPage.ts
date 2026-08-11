export function renderLiffPage(liffId: string): string {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>เชื่อมบัญชี Google</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 2rem 1.5rem; text-align: center; color: #1c1e21; }
  p { line-height: 1.6; }
  .error { color: #d63031; }
</style>
</head>
<body>
  <h2>กำลังเชื่อมบัญชี Google...</h2>
  <p id="status">กรุณารอสักครู่</p>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <script>
    (async () => {
      const statusEl = document.getElementById("status");
      try {
        await liff.init({ liffId: "${liffId}" });
        if (!liff.isLoggedIn()) {
          liff.login();
          return;
        }
        const profile = await liff.getProfile();
        const res = await fetch("/link/init?lineUserId=" + encodeURIComponent(profile.userId));
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        window.location.href = data.url;
      } catch (err) {
        statusEl.textContent = "เกิดข้อผิดพลาด: " + (err && err.message ? err.message : String(err));
        statusEl.className = "error";
      }
    })();
  </script>
</body>
</html>`;
}

export function renderLinkedPage(): string {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>เชื่อมบัญชีสำเร็จ</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 2rem 1.5rem; text-align: center; color: #1c1e21; }
</style>
</head>
<body>
  <h2>เชื่อมบัญชีสำเร็จ ✅</h2>
  <p>ปิดหน้าต่างนี้แล้วกลับไปแชทกับบอทใน LINE ได้เลย</p>
</body>
</html>`;
}
