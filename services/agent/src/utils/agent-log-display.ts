/**
 * Formats timestamps for /agentlog-style output: [HH:mm] or [Yesterday HH:mm].
 */
export function formatAgentLogLineTime(date: Date): string {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const pad = (n: number) => n.toString().padStart(2, '0');
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  if (date >= startOfToday) {
    return hhmm;
  }
  if (date >= startOfYesterday && date < startOfToday) {
    return `Yesterday ${hhmm}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${hhmm}`;
}
