// utils/marketHours.js
export function isMarketOpen() {
  const now = new Date();
  const est = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = est.getDay();
  const hour = est.getHours();
  const minute = est.getMinutes();

  // Skip weekends
  if (day === 0 || day === 6) return false;

  // Regular market hours: 9:30 AM – 4:00 PM ET
  const openMinutes = 9 * 60 + 30;
  const closeMinutes = 16 * 60;
  const currentMinutes = hour * 60 + minute;

  return currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
}

export function isMarketClosed() {
  return !isMarketOpen();
}

export function getMarketStatus() {
  return isMarketOpen() ? "OPEN" : "CLOSED";
}
