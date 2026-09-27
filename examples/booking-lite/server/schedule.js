// The slots this app offers. Edit this list and publish again: the next time
// someone opens the slot list, the app adds any slot that isn't stored yet.
// Slots that already exist, booked or not, are left alone, and slots in the
// past are never added. `starts_at` is a date and time in UTC.
//
// Sample slots (replace before real use; see AGENT.md, "Use your own slots"):
// an intro call tomorrow and a planning session the day after, at 16:00 UTC.
// Because they are relative to today, a new pair appears every day.
export function scheduledSlots(now) {
  return [
    { title: "Intro call", starts_at: sampleTime(now, 1) },
    { title: "Planning session", starts_at: sampleTime(now, 2) }
  ];
}

function sampleTime(now, daysFromNow) {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + daysFromNow);
  date.setUTCHours(16, 0, 0, 0);
  return date.toISOString();
}
