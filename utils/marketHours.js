// utils/marketHours.js
export function isMarketOpen() {
  const now = new Date();
  const estNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));

  const day = estNow.getDay();      // 0=Sun ... 6=Sat
  const hour = estNow.getHours();
  const minute = estNow.getMinutes();

  // Market open Monday–Friday 9:30 AM – 4:00 PM ET
  const isWeekday = day >= 1 && day <= 5;
  const isOpen = (hour > 9 || (hour === 9 && minute >= 30)) && hour < 16;

  return isWeekday && isOpen;
}

export function getMarketStatus() {
  return isMarketOpen() ? "open" : "closed";
}
