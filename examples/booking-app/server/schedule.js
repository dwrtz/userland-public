// Studio hours and time helpers.
//
// Lesson times are wall-clock times in the studio's time zone. They are stored
// as UTC ISO strings (`starts_at`, `ends_at`) so they sort correctly and can be
// used later for reminders, calendars, or reports.

export const STUDIO_HOURS = {
  timeZone: "America/Los_Angeles",
  timeZoneLabel: "Pacific time",
  // Opening hours by weekday (0 = Sunday). Days that are not listed are closed.
  weekly: {
    1: ["15:00", "19:00"],
    2: ["15:00", "19:00"],
    3: ["15:00", "19:00"],
    4: ["15:00", "19:00"],
    6: ["09:00", "13:00"]
  },
  // Lessons can start every 30 minutes.
  slotStepMinutes: 30,
  // Requests need at least this much notice.
  minNoticeHours: 24,
  // How far ahead visitors can book.
  daysAhead: 14
};

const MINUTE = 60 * 1000;
const formatters = new Map();

function formatter(options, timeZone = STUDIO_HOURS.timeZone) {
  const key = JSON.stringify([timeZone, options]);
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.DateTimeFormat("en-US", { timeZone, ...options }));
  }
  return formatters.get(key);
}

/** Calendar parts of an instant, as seen in the studio's time zone. */
export function zonedParts(date) {
  const parts = {};
  const fields = formatter({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(date);
  for (const part of fields) parts[part.type] = part.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday
  };
}

/** Converts a studio-local date ("2026-10-01") and time ("15:30") to a UTC Date. */
export function studioTimeToDate(date, time) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // The zone offset can change across daylight saving time, so check it twice.
  let instant = wallClockAsUtc - offsetAt(wallClockAsUtc);
  instant = wallClockAsUtc - offsetAt(instant);
  return new Date(instant);
}

function offsetAt(timestamp) {
  const parts = zonedParts(new Date(timestamp));
  const [year, month, day] = parts.date.split("-").map(Number);
  const asUtc = Date.UTC(year, month - 1, day, parts.hour, parts.minute);
  return asUtc - Math.floor(timestamp / MINUTE) * MINUTE;
}

/** Adds whole days to a "YYYY-MM-DD" date string. */
export function addDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekdayOf(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function toMinutes(time) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function toTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Open days in the booking window, starting today in the studio's time zone. */
export function openDays(now = new Date()) {
  const today = zonedParts(now).date;
  const days = [];
  for (let offset = 0; offset <= STUDIO_HOURS.daysAhead; offset += 1) {
    const date = addDays(today, offset);
    if (STUDIO_HOURS.weekly[weekdayOf(date)]) days.push(date);
  }
  return days;
}

/**
 * Start times on `date` for a lesson of `durationMinutes`.
 * `busy` is a list of `{ starts_at, ends_at }` for bookings that hold a time.
 */
export function slotsForDay(date, durationMinutes, busy, now = new Date()) {
  const hours = STUDIO_HOURS.weekly[weekdayOf(date)];
  if (!hours) return [];
  const earliest = now.getTime() + STUDIO_HOURS.minNoticeHours * 60 * MINUTE;
  const taken = busy.map((booking) => [Date.parse(booking.starts_at), Date.parse(booking.ends_at)]);
  const slots = [];
  for (let start = toMinutes(hours[0]); start + durationMinutes <= toMinutes(hours[1]); start += STUDIO_HOURS.slotStepMinutes) {
    const time = toTime(start);
    const startsAt = studioTimeToDate(date, time);
    const endsAt = new Date(startsAt.getTime() + durationMinutes * MINUTE);
    const available = startsAt.getTime() >= earliest && !taken.some(([from, to]) => startsAt.getTime() < to && endsAt.getTime() > from);
    slots.push({ time, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), available });
  }
  return slots;
}

export function formatDayName(date) {
  return formatter({ weekday: "short" }, "UTC").format(new Date(`${date}T12:00:00Z`));
}

export function formatDayNumber(date) {
  return String(Number(date.slice(8, 10)));
}

export function formatMonthShort(date) {
  return formatter({ month: "short" }, "UTC").format(new Date(`${date}T12:00:00Z`));
}

export function formatDateLong(date) {
  return formatter({ weekday: "long", month: "long", day: "numeric" }, "UTC").format(new Date(`${date}T12:00:00Z`));
}

/** "4:30 pm" for a studio-local "16:30". */
export function formatClock(time) {
  const [hour, minute] = time.split(":").map(Number);
  const suffix = hour >= 12 ? "pm" : "am";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** Studio-local date and time labels for a stored UTC instant. */
export function describeInstant(iso) {
  const parts = zonedParts(new Date(iso));
  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return {
    date: parts.date,
    time,
    dayName: formatDayName(parts.date),
    dayNumber: formatDayNumber(parts.date),
    month: formatMonthShort(parts.date),
    dateLong: formatDateLong(parts.date),
    clock: formatClock(time)
  };
}

/** "3 hours ago", "2 days ago". Used for request and activity times. */
export function timeAgo(iso, now = new Date()) {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / MINUTE));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
