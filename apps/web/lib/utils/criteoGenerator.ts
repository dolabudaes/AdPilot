import { RawCriteoRow } from "../types";

const campaigns = ["Campaign A", "Campaign B", "Campaign C", "Campaign D", "Campaign E"];

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function pick<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function buildDemoRows(rows = 2600): RawCriteoRow[] {
  const now = Date.now();
  const data: RawCriteoRow[] = [];

  for (let i = 0; i < rows; i += 1) {
    const campaign = pick(campaigns);
    const impressionTime = new Date(now - i * 1000 * 60 * 60).toISOString();
    const click = Math.random() < 0.18 ? 1 : 0;
    const conversion = click && Math.random() < 0.12 ? 1 : 0;
    const attributed = conversion && Math.random() < 0.7 ? 1 : 0;

    data.push({
      timestamp: impressionTime,
      uid: `uid-${Math.floor(i / 3)}`,
      campaign,
      conversion,
      conversion_timestamp: conversion ? impressionTime : null,
      conversion_id: conversion ? `conv-${i}` : null,
      attribution: attributed,
      click,
      click_pos: click ? Math.max(1, Math.floor(rand(1, 4))) : null,
      click_nb: click ? Math.max(1, Math.floor(rand(1, 3))) : null,
      cost: Number(rand(0.15, 3.8).toFixed(4)),
      cpo: attributionCostProxy(attributed),
      time_since_last_click: click ? rand(1, 2000) : null,
      cat1: `c1-${Math.floor(rand(1, 5))}`,
      cat2: `c2-${Math.floor(rand(1, 6))}`,
      cat3: `c3-${Math.floor(rand(1, 4))}`,
      cat4: `c4-${Math.floor(rand(1, 8))}`,
      cat5: `c5-${Math.floor(rand(1, 10))}`,
      cat6: `c6-${Math.floor(rand(1, 8))}`,
      cat7: `c7-${Math.floor(rand(1, 5))}`,
      cat8: `c8-${Math.floor(rand(1, 6))}`,
      cat9: `c9-${Math.floor(rand(1, 3))}`,
    });
  }

  return data;
}

function attributionCostProxy(attributed: number) {
  if (!attributed) return 0;
  return Number(rand(15, 45).toFixed(2));
}
