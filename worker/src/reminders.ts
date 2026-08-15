// Proactive Google Tasks due-time reminders (PLAN.md 17.35) — the first
// feature in this bot that pushes to a user unprompted outside the existing
// 07:00 morning broadcast (greetingCommands.ts, PLAN.md 17.21). Personal
// accounts only, not groups — same precedent as that broadcast (confirmed
// with the user there): an unsolicited push into a group chat is more
// likely noise than a personal DM is.
//
// Runs on the same once-a-minute cron as everything else in index.ts's
// `scheduled` handler. Only tasks with a due *time* set (see tasks.ts's
// parseDueField — a due date with no time is treated as "no time set", the
// same convention this bot uses when creating tasks) get this near-due
// ping; a task due today with no time set instead shows up in the existing
// 07:00 broadcast as a same-day heads-up (buildTodayDueTasksLine in
// greetingCommands.ts), the same way today's Calendar events already do.

import { listIncompleteTasks } from "./tasks.ts";
import { refreshAccessToken } from "./googleAuth.ts";
import { groupIdFromSubject } from "./groupSubject.ts";
import { pushToLine } from "./line.ts";
import { applyPersona } from "./persona.ts";
import { getAccountLink, getTaskReminderSent, markTaskReminderSent } from "./state.ts";
import { toRfc3339 } from "./thaiDate.ts";
import type { Env } from "./index.ts";

// Personal `link:<lineUserId>` KV keys only — same prefix duplicated in
// greetingCommands.ts's broadcastMorningBriefings, for the same reason
// noted there (state.ts doesn't export it, and importing a runtime value
// from index.ts back here isn't an option).
const ACCOUNT_LINK_PREFIX = "link:";

const REMIND_CONCURRENCY_LIMIT = 5;
const REMIND_LEAD_MINUTES = 60;
// The cron fires every minute, but this check tolerates a few minutes of
// jitter either side of the 60-minute mark rather than requiring an exact
// single-minute match — the getTaskReminderSent/markTaskReminderSent pair
// in state.ts is what actually prevents a duplicate send within that wider
// window, not the precision of the window itself.
const REMIND_WINDOW_MINUTES = 5;

async function processInBatches<T>(items: T[], limit: number, handler: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.allSettled(items.slice(i, i + limit).map(handler));
  }
}

/** `now` defaults to the real current time in production — overridable so
 * tests can exercise the due-time window deterministically, the same
 * pattern broadcastMorningBriefings uses for its 07:00 gate. */
export async function pushTaskDueReminders(env: Env, kv: KVNamespace, now: Date = new Date()): Promise<void> {
  // Same list-once, no-cursor-pagination approach as broadcastMorningBriefings.
  const { keys } = await kv.list({ prefix: ACCOUNT_LINK_PREFIX });
  const personalUserIds = keys
    .map((k) => k.name.slice(ACCOUNT_LINK_PREFIX.length))
    .filter((subjectId) => groupIdFromSubject(subjectId) === null);

  await processInBatches(personalUserIds, REMIND_CONCURRENCY_LIMIT, async (lineUserId) => {
    try {
      const link = await getAccountLink(kv, lineUserId);
      if (!link) return;
      const accessToken = await refreshAccessToken({
        refreshToken: link.refreshToken,
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      });
      const tasks = await listIncompleteTasks(accessToken);
      for (const task of tasks) {
        if (!task.dueDateKey || !task.dueTime) continue;
        const dueAt = new Date(toRfc3339(task.dueDateKey, task.dueTime));
        const minutesUntilDue = (dueAt.getTime() - now.getTime()) / 60000;
        if (Math.abs(minutesUntilDue - REMIND_LEAD_MINUTES) > REMIND_WINDOW_MINUTES) continue;
        if (await getTaskReminderSent(kv, lineUserId, task.id)) continue;

        const body = await applyPersona(
          `⏰ อีกประมาณ 1 ชั่วโมงจะถึงกำหนด: "${task.title}" (${task.dueDateKey} ${task.dueTime})`,
          env.GEMINI_API_KEY
        );
        await pushToLine(lineUserId, body, env.LINE_CHANNEL_ACCESS_TOKEN);
        await markTaskReminderSent(kv, lineUserId, task.id);
      }
    } catch (err) {
      console.error("pushTaskDueReminders: failed for one user, continuing with the rest", lineUserId, err);
    }
  });
}
