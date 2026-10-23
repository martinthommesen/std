import { today } from "foldkit/calendar";

/** The Date Pickers' current date in UTC, never the device's zone (5.7). */
export const calendarToday = today.inZone("UTC");
