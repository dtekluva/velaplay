// what things cost, copied from the game so the server can check every purchase
import plotsJson from "./data/plots.json";

// every plot that can be bought: price and kind (o open land, e estate lot, b part of the Banana Island lot, u a 300 m² unit in Banana Island West or Ikoyi)
export const PLOTS: Record<string, [number, "o" | "e" | "b" | "u"]> = plotsJson as any;
export const isUnit = (k: string) => PLOTS[k]?.[1] === "u";
// a house on Banana Island West units: its site (x0, z0, x1, z1) and the units under it, as the game sends them
export function unitsOf(key: string, house: any): string[] | null {
  if (!isUnit(key) || !house || !Array.isArray(house.units)) return null;
  const u = house.units.filter((k: unknown) => typeof k === "string" && isUnit(k));
  return u.length === house.units.length && u.includes(key) && u.length <= 48 ? [...new Set<string>(u)] : null;
}
export const BIG_KEYS = Object.keys(PLOTS).filter((k) => PLOTS[k][1] === "b");
export const START_MONEY = 10_000_000;
export const DOZER_PRICE = 35_000;
export const PLOT = 24;

export interface HouseType { cost: number; furnish: number; w: number; d: number; site?: [number, number]; big?: boolean }
export const HOUSES: Record<string, HouseType> = {
  cabin: { cost: 25000, furnish: 0, w: 8, d: 7 },
  bungalow: { cost: 45000, furnish: 15000, w: 12, d: 8 },
  family: { cost: 70000, furnish: 25000, w: 11, d: 10 },
  duplex: { cost: 95000, furnish: 30000, w: 11, d: 10 },
  mansionette: { cost: 150000, furnish: 45000, w: 16, d: 12, site: [19, 22] },
  mansion: { cost: 650000, furnish: 120000, w: 40, d: 22, big: true },
};
export const FURN: Record<string, number> = {
  sofa: 85000, armchair: 35000, coffee: 18000, tv: 120000, dbed: 95000, sbed: 45000, wardrobe: 60000, nightstand: 12000,
  dining: 70000, counter: 90000, fridge: 150000, desk: 40000, rug: 15000, lamp: 9000, plant: 6000, shelf: 30000,
  roundrug: 20000, pendant: 25000, agave: 9000, stove: 75000, blender: 35000, shower: 120000, toilet: 45000, vanity: 60000, bathtub: 140000,
  // the home setup update: electronics, the Naija kitchen, the spa bathroom, statement pieces
  tv75: 450000, tv43: 95000, theatre: 180000, gaming: 520000, ac: 380000, fan: 25000, inverter: 850000,
  cooker: 180000, microwave: 60000, island: 220000, cabinets: 85000, freezer: 160000, dispenser: 70000, washer: 280000,
  jacuzzi: 1200000, dvanity: 140000, heater: 45000, kbed: 260000, dresser: 75000, sectional: 320000, art: 40000, chandelier: 150000,
};
export const BATH_ITEMS = new Set(["shower", "toilet", "vanity", "bathtub"]);
const FENCE_RATE: Record<string, number> = { rail: 80, wall: 120, high: 180 };
// the same sums as the game's fenceQuote()
export function fenceCost(type: HouseType, fence: any, house?: any): number {
  const rate = fence && FENCE_RATE[fence.kind]; if (!rate) return 0;
  const s = house?.site, n = Array.isArray(house?.units) ? house.units.length : 0;
  const plotPer = Array.isArray(s) && s.length === 4 && n ? Math.min(2 * (Math.abs(s[2] - s[0]) + Math.abs(s[3] - s[1])), 2 * (15 * n + 40)) : 4 * PLOT;   // round a parcel of units: its own perimeter
  const per = type.big ? 2 * (96 + 72) : fence.area === "compound" ? 2 * ((type.site ? type.site[0] : type.w) + 5 + (type.site ? type.site[1] : type.d) + 7) : plotPer;
  return Math.round(per * rate / 100) * 100;
}
// which plot a bulldozer cell belongs to (cell index = i * 720 + j, i and j in metres from the map corner)
export const plotOfCell = (idx: number) => `${Math.floor(Math.floor(idx / 720) / PLOT)},${Math.floor((idx % 720) / PLOT)}`;
