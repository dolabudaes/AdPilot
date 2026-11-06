import { ensureSeedData } from "./dataStore";
import { buildDemoRows } from "./utils/criteoGenerator";

export function ensureDemoIfEmpty() {
  ensureSeedData(buildDemoRows(3000));
}
