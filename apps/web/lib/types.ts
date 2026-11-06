export * from "./analytics/types";

export interface RawCriteoRow {
  timestamp: string;
  uid: string;
  campaign: string;
  conversion: number;
  conversion_timestamp: string | null;
  conversion_id: string | null;
  attribution: number;
  click: number;
  click_pos: number | null;
  click_nb: number | null;
  cost: number;
  cpo: number;
  time_since_last_click: number | null;
  cat1: string | null;
  cat2: string | null;
  cat3: string | null;
  cat4: string | null;
  cat5: string | null;
  cat6: string | null;
  cat7: string | null;
  cat8: string | null;
  cat9: string | null;
}
