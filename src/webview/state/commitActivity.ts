import type { CommitActivityDay } from "../components/repositoryHomeTypes.js";

export interface CalendarDay {
  readonly dateKey: string;
  readonly date: Date;
  readonly commitCount: number;
  readonly isInWindow: boolean;
}

export interface CalendarMonthLabel {
  readonly dateKey: string;
  readonly label: string;
  readonly columnIndex: number;
}

function parseDateKey(dateKey: string): Date | undefined {
  const dateParts = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(dateKey);
  if (dateParts === null) return undefined;
  const year = Number(dateParts[1]);
  const monthIndex = Number(dateParts[2]) - 1;
  const day = Number(dateParts[3]);
  const parsedDate = new Date(year, monthIndex, day);
  if (
    parsedDate.getFullYear() !== year ||
    parsedDate.getMonth() !== monthIndex ||
    parsedDate.getDate() !== day
  )
    return undefined;
  parsedDate.setHours(0, 0, 0, 0);
  return parsedDate;
}

export function dateKeyFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shiftDate(date: Date, dayOffset: number): Date {
  const shiftedDate = new Date(date);
  shiftedDate.setDate(shiftedDate.getDate() + dayOffset);
  shiftedDate.setHours(0, 0, 0, 0);
  return shiftedDate;
}

export function shiftMonth(date: Date, monthOffset: number): Date {
  const shiftedDate = new Date(date);
  const originalDay = shiftedDate.getDate();
  shiftedDate.setDate(1);
  shiftedDate.setMonth(shiftedDate.getMonth() + monthOffset);
  const lastDayOfTargetMonth = new Date(
    shiftedDate.getFullYear(),
    shiftedDate.getMonth() + 1,
    0,
  ).getDate();
  shiftedDate.setDate(Math.min(originalDay, lastDayOfTargetMonth));
  shiftedDate.setHours(0, 0, 0, 0);
  return shiftedDate;
}

export function formatDateLabel(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function formatMonthLabel(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: "short" }).format(date);
}

export function buildCalendarMonthLabels(
  calendarDays: readonly CalendarDay[],
): readonly CalendarMonthLabel[] {
  let previousVisibleMonthKey: string | undefined;
  const monthLabels: CalendarMonthLabel[] = [];

  calendarDays.forEach((calendarDay, calendarIndex) => {
    if (!calendarDay.isInWindow) return;
    const visibleMonthKey = `${calendarDay.date.getFullYear()}-${calendarDay.date.getMonth()}`;
    if (visibleMonthKey === previousVisibleMonthKey) return;
    previousVisibleMonthKey = visibleMonthKey;
    monthLabels.push({
      dateKey: calendarDay.dateKey,
      label: formatMonthLabel(calendarDay.date),
      columnIndex: Math.floor(calendarIndex / 7) + 1,
    });
  });

  return monthLabels;
}

export function buildCalendarDays(
  commitActivity: readonly CommitActivityDay[],
): readonly CalendarDay[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const windowStart = shiftDate(today, -364);
  const mondayIndex = (windowStart.getDay() + 6) % 7;
  const calendarStart = shiftDate(windowStart, -mondayIndex);
  const todayMondayIndex = (today.getDay() + 6) % 7;
  const calendarEnd = shiftDate(today, 6 - todayMondayIndex);
  const commitCountsByDate = new Map<string, number>();

  for (const activityDay of commitActivity) {
    const parsedDate = parseDateKey(activityDay.date);
    if (
      parsedDate === undefined ||
      parsedDate < windowStart ||
      parsedDate > today
    )
      continue;
    commitCountsByDate.set(activityDay.date, activityDay.commitCount);
  }

  const calendarDays: CalendarDay[] = [];
  for (
    let calendarDate = calendarStart;
    calendarDate <= calendarEnd;
    calendarDate = shiftDate(calendarDate, 1)
  ) {
    const dateKey = dateKeyFromDate(calendarDate);
    calendarDays.push({
      dateKey,
      date: calendarDate,
      commitCount: commitCountsByDate.get(dateKey) ?? 0,
      isInWindow: calendarDate >= windowStart && calendarDate <= today,
    });
  }
  return calendarDays;
}
