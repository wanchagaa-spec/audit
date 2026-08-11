import { useMemo, useState } from "react";
import {
  Chart as ChartJS,
  ArcElement,
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
} from "chart.js";
import { Pie, Bar, Line } from "react-chartjs-2";
import { useApp } from "../context/AppContext";
import {
  cumulativeBalance,
  expenseByCategory,
  incomeExpenseByMonth,
  monthsBack,
} from "../lib/analytics";
import { formatBaht, monthKey } from "../lib/format";

ChartJS.register(
  ArcElement,
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend
);

const PALETTE = [
  "#6C5CE7", "#00B894", "#0984E3", "#FDCB6E", "#E17055",
  "#D63031", "#00CEC9", "#6D8B74", "#A29BFE", "#FAB1A0", "#636E72",
];

export function Dashboard() {
  const { transactions, categories, budgets, currentBookId } = useApp();
  const [month] = useState(monthKey());

  const bookTx = useMemo(
    () => transactions.filter((t) => t.bookId === currentBookId),
    [transactions, currentBookId]
  );

  const categorySlices = useMemo(
    () => expenseByCategory(bookTx, categories, month),
    [bookTx, categories, month]
  );

  const months = useMemo(() => monthsBack(6), []);
  const monthTotals = useMemo(() => incomeExpenseByMonth(bookTx, months), [bookTx, months]);
  const balancePoints = useMemo(() => cumulativeBalance(bookTx), [bookTx]);

  const monthExpenseTotal = categorySlices.reduce((s, c) => s + c.total, 0);
  const monthBudgets = budgets.filter((b) => b.bookId === currentBookId && b.month === month);

  if (bookTx.length === 0) {
    return (
      <div className="dashboard empty">
        <p>ยังไม่มีข้อมูลรายรับ-รายจ่าย ลองจดรายการในหน้าแชทก่อนนะ</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <section className="dashboard-card">
        <h3>สัดส่วนรายจ่ายเดือนนี้</h3>
        {categorySlices.length === 0 ? (
          <p className="muted">ยังไม่มีรายจ่ายเดือนนี้</p>
        ) : (
          <>
            <Pie
              data={{
                labels: categorySlices.map((c) => `${c.icon} ${c.name}`),
                datasets: [
                  {
                    data: categorySlices.map((c) => c.total),
                    backgroundColor: categorySlices.map((_, i) => PALETTE[i % PALETTE.length]),
                  },
                ],
              }}
            />
            <ul className="top-categories">
              {categorySlices.slice(0, 5).map((c) => {
                const pct = monthExpenseTotal ? Math.round((c.total / monthExpenseTotal) * 100) : 0;
                const budget = monthBudgets.find((b) => b.categoryId === c.categoryId);
                return (
                  <li key={c.categoryId}>
                    <span>
                      {c.icon} {c.name}
                    </span>
                    <span>
                      {formatBaht(c.total)} บาท ({pct}%)
                      {budget && c.total > budget.limitAmount && (
                        <strong className="over-budget"> เกินงบ!</strong>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      <section className="dashboard-card">
        <h3>รายรับ vs รายจ่าย ย้อนหลัง 6 เดือน</h3>
        <Bar
          data={{
            labels: monthTotals.map((m) => m.month),
            datasets: [
              { label: "รายรับ", data: monthTotals.map((m) => m.income), backgroundColor: "#00B894" },
              { label: "รายจ่าย", data: monthTotals.map((m) => m.expense), backgroundColor: "#D63031" },
            ],
          }}
        />
      </section>

      <section className="dashboard-card">
        <h3>แนวโน้มเงินคงเหลือสะสม</h3>
        <Line
          data={{
            labels: balancePoints.map((p) => p.date),
            datasets: [
              {
                label: "เงินคงเหลือสะสม",
                data: balancePoints.map((p) => p.balance),
                borderColor: "#6C5CE7",
                backgroundColor: "rgba(108,92,231,0.15)",
                fill: true,
                tension: 0.3,
              },
            ],
          }}
        />
      </section>
    </div>
  );
}
