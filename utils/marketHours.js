// utils/marketHours.js
export function isMarketOpen() {
  const estNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const day = estNow.getDay(); // 0=Sun ... 6=Sat
  const hour = estNow.getHours();
  const minute = estNow.getMinutes();

  // Open Mon–Fri 9:30–16:00 ET
  const weekday = day >= 1 && day <= 5;
  const open = (hour > 9 || (hour === 9 && minute >= 30)) && hour < 16;
  return weekday && open;
}

export function getMarketStatus() {
  return isMarketOpen() ? "open" : "closed";
}
