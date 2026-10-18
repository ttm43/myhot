// Beijing (Asia/Shanghai, fixed UTC+8, no DST) calendar helpers shared by web and backend.

const OFFSET_MS = 8 * 3600 * 1000;

/** YYYY-MM-DD of the instant in Beijing time. */
export function beijingDate(instant: Date | string | number): string {
  const d = new Date(new Date(instant).getTime() + OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

/** HH:mm of the instant in Beijing time. */
export function beijingTime(instant: Date | string | number): string {
  const d = new Date(new Date(instant).getTime() + OFFSET_MS);
  return d.toISOString().slice(11, 16);
}

/** UTC instant of 00:00 Beijing on the given calendar day. */
export function beijingMidnight(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00+08:00`));
}

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export function beijingWeekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}
