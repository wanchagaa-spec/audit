import { useState } from "react";
import { AppProvider, useApp } from "./context/AppContext";
import { BookSwitcher } from "./components/BookSwitcher";
import { ChatView } from "./components/ChatView";
import { Dashboard } from "./components/Dashboard";
import { SearchView } from "./components/SearchView";
import { Settings } from "./components/Settings";
import "./App.css";

type Tab = "chat" | "dashboard" | "search" | "settings";

function Shell() {
  const { loading } = useApp();
  const [tab, setTab] = useState<Tab>("chat");

  if (loading) {
    return <div className="loading-screen">กำลังโหลด...</div>;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>จดบัญชี</h1>
        <BookSwitcher />
      </header>

      <main className="app-main">
        {tab === "chat" && <ChatView />}
        {tab === "dashboard" && <Dashboard />}
        {tab === "search" && <SearchView />}
        {tab === "settings" && <Settings />}
      </main>

      <nav className="app-tabs">
        <button type="button" className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
          💬 แชท
        </button>
        <button type="button" className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>
          📊 สรุป
        </button>
        <button type="button" className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>
          🔍 ค้นหา
        </button>
        <button type="button" className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
          ⚙️ ตั้งค่า
        </button>
      </nav>
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

export default App;
