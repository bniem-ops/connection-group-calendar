// Month-grid rendering. Pure DOM, no framework.

import { GROUP_TIMEZONE } from "../config.js";
import { zonedTimeToInstant, ymd, zonedParts, formatTime } from "./tz.js";

const MAX_CHIPS = 3;

// The visible grid always starts on the Sunday on/before the 1st and covers
// 6 weeks, so layout never jumps.
export function monthGridRange(year, month /* 1-12 */) {
  const first = zonedTimeToInstant(year, month, 1, 0, 0);
  const firstWeekday = zonedParts(first).weekday; // "Sun".."Sat"
  const order = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const lead = order.indexOf(firstWeekday);
  const start = new Date(first.getTime() - lead * 86400000);
  const end = new Date(start.getTime() + 42 * 86400000);
  return { start, end };
}

export function renderMonth(container, { year, month, occurrencesByDate, catColor, onDayClick, onEventClick }) {
  container.innerHTML = "";
  const { start } = monthGridRange(year, month);
  const todayStr = ymd(new Date());

  for (let i = 0; i < 42; i++) {
    const dayInstant = new Date(start.getTime() + i * 86400000);
    // Use noon to dodge any DST edge when reading the date parts.
    const noon = new Date(dayInstant.getTime() + 12 * 3600000);
    const p = zonedParts(noon);
    const dateStr = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

    const cell = document.createElement("div");
    cell.className = "cell";
    if (p.month !== month) cell.classList.add("cell--other");
    if (dateStr === todayStr) cell.classList.add("cell--today");
    cell.dataset.date = dateStr;

    const num = document.createElement("div");
    num.className = "cell__num";
    num.textContent = p.day;
    cell.appendChild(num);

    const list = (occurrencesByDate.get(dateStr) || []).slice();
    list.sort((a, b) => a.start - b.start);

    list.slice(0, MAX_CHIPS).forEach((occ) => {
      const chip = document.createElement("div");
      chip.className = "ev";
      chip.style.background = catColor(occ.event.category_id);
      const title = occ.overrideTitle || occ.event.title;
      chip.textContent = occ.event.all_day ? title : `${formatTime(occ.start)} ${title}`;
      chip.title = title;
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        onEventClick(occ);
      });
      cell.appendChild(chip);
    });

    if (list.length > MAX_CHIPS) {
      const more = document.createElement("div");
      more.className = "ev ev--more";
      more.textContent = `+${list.length - MAX_CHIPS} more`;
      cell.appendChild(more);
    }

    cell.addEventListener("click", () => onDayClick(dateStr, list));
    container.appendChild(cell);
  }
}

export const TZ_NOTE = `Times shown in ${GROUP_TIMEZONE}`;
