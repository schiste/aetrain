// Display formatters and small geometry helpers shared across UI
// components and the map surface. Pure functions, no DOM access.

import type { GeoPoint } from "../../types/planner-dataset.ts";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes !== 0 && !minutes) {
    return "—";
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  if (hours > 0) {
    return remainder > 0 ? `${hours}h${String(remainder).padStart(2, "0")}` : `${hours}h`;
  }

  return `${remainder}min`;
}

export function formatLeg(minutes: number): string {
  if (minutes === 0) {
    return "0h";
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours > 0 && remainder > 0) {
    return `${hours}h${String(remainder).padStart(2, "0")}`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }

  return `${remainder}min`;
}

export function formatPopulation(population: number): string {
  if (population >= 1_000_000) {
    return `${(population / 1_000_000).toFixed(1)}M`;
  }

  return `${Math.round(population / 1_000)}k`;
}

export function haversine(a: GeoPoint, b: GeoPoint): number {
  const radiusKm = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  return radiusKm * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
