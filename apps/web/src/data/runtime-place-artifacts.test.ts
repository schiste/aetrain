import test from "node:test";
import assert from "node:assert/strict";

import {
  adaptRuntimePlaces,
  type RawRuntimePlace,
  type RawRuntimePlaceRole
} from "./runtime-place-artifacts.ts";

function rawPlace(
  overrides: Partial<RawRuntimePlace> & {
    place_id: string;
    role: RawRuntimePlaceRole;
  }
): RawRuntimePlace {
  return {
    display_name: "Test Place",
    lat_e5: 4_812_345,
    lon_e5: 367_890,
    service_pattern_count: 1,
    ...overrides
  };
}

test("adaptRuntimePlaces decodes e5 fixed-point to degrees", () => {
  const [place] = adaptRuntimePlaces([
    rawPlace({
      place_id: "place-1",
      role: "replacement_bus_stop",
      lat_e5: 4_812_345,
      lon_e5: 367_890
    })
  ]);

  assert.ok(place);
  // e5 → degrees is a divide-by-100_000; assert the exact decoded value, not an
  // approximation, so a stray factor-of-10 regression is caught.
  assert.equal(place.lat, 48.12345);
  assert.equal(place.lon, 3.6789);
});

test("adaptRuntimePlaces passes role and identity fields through", () => {
  const [place] = adaptRuntimePlaces([
    rawPlace({
      place_id: "registry-place-7",
      role: "registry_place",
      display_name: "Marnay-sur-Seine"
    })
  ]);

  assert.ok(place);
  assert.equal(place.placeId, "registry-place-7");
  assert.equal(place.role, "registry_place");
  assert.equal(place.displayName, "Marnay-sur-Seine");
});

test("adaptRuntimePlaces defaults absent optional links to null", () => {
  const [place] = adaptRuntimePlaces([
    rawPlace({ place_id: "place-2", role: "replacement_bus_stop" })
  ]);

  assert.ok(place);
  // The registry-reveal filter keys off linkedCityId == null, so an absent link
  // must normalise to null (not undefined) for that predicate to hold.
  assert.equal(place.linkedCityId, null);
  assert.equal(place.linkedCityIndex, null);
  assert.equal(place.population, null);
});

test("adaptRuntimePlaces preserves a present city link", () => {
  const [place] = adaptRuntimePlaces([
    rawPlace({
      place_id: "place-3",
      role: "registry_place",
      linked_city_id: "city-troyes-fr",
      linked_city_index: 42,
      population: 61_652
    })
  ]);

  assert.ok(place);
  assert.equal(place.linkedCityId, "city-troyes-fr");
  assert.equal(place.linkedCityIndex, 42);
  assert.equal(place.population, 61_652);
});
