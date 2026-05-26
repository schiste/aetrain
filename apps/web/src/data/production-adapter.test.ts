import test from "node:test";
import assert from "node:assert/strict";

import { buildProductionPlannerData } from "./production-adapter.ts";

test("buildProductionPlannerData carries decoded route geometry into planner artifacts", () => {
  const dataset = buildProductionPlannerData({
    meta: {
      dataset_version: "test-version",
      generated_at: "2026-05-08T18:00:00Z",
      schema_version: 1
    },
    rawCities: [
      {
        city_id: "paris-fr",
        country_code: "FR",
        display_name: "Paris",
        interest_score: 9,
        location: { lat: 48.8566, lon: 2.3522 },
        population: 2_100_000
      },
      {
        aliases: ["Avignon Centre", "Avignon TGV"],
        city_id: "lyon-fr",
        country_code: "FR",
        display_name: "Lyon",
        interest_score: 8,
        location: { lat: 45.764, lon: 4.8357 },
        population: 515_000
      }
    ],
    rawEdges: [
      {
        duration_min: 120,
        from_city_id: "paris-fr",
        to_city_id: "lyon-fr"
      }
    ],
    rawEdgeGeometries: {
      geometries: [
        {
          from_city_id: "paris-fr",
          points: [
            { lat_e5: 4_885_660, lon_e5: 235_220 },
            { lat_e5: 4_830_000, lon_e5: 290_000 },
            { lat_e5: 4_576_400, lon_e5: 483_570 }
          ],
          source: "gtfs_shape_segment",
          to_city_id: "lyon-fr"
        }
      ]
    }
  });

  assert.equal(dataset.plannerArtifacts!.routePairs!.length, 1);
  assert.deepEqual(dataset.plannerArtifacts!.routePairs![0]!.geometry, [
    { lat: 48.8566, lon: 2.3522 },
    { lat: 48.3, lon: 2.9 },
    { lat: 45.764, lon: 4.8357 }
  ]);
  assert.match(dataset.plannerArtifacts!.searchIndex![1]!.searchText, /avignon centre/);
});

test("buildProductionPlannerData uses rail map locations for markers and fallback stubs", () => {
  const dataset = buildProductionPlannerData({
    meta: {
      dataset_version: "test-version",
      generated_at: "2026-05-08T18:00:00Z",
      schema_version: 1
    },
    rawCities: [
      {
        city_id: "paris-fr",
        country_code: "FR",
        display_name: "Paris",
        interest_score: 9,
        location: { lat: 48.8566, lon: 2.3522 },
        map_location: { lat: 48.8801, lon: 2.3546 },
        population: 2_100_000
      },
      {
        city_id: "lyon-fr",
        country_code: "FR",
        display_name: "Lyon",
        interest_score: 8,
        location: { lat: 45.764, lon: 4.8357 },
        map_location: { lat: 45.7606, lon: 4.8594 },
        population: 515_000
      }
    ],
    rawEdges: [
      {
        duration_min: 120,
        from_city_id: "paris-fr",
        to_city_id: "lyon-fr"
      }
    ],
    rawEdgeGeometries: {
      geometries: []
    },
    rawStations: {
      stations: [
        {
          city_index: 0,
          display_name: "Paris Montparnasse",
          lat_e5: 4_884_055,
          lon_e5: 232_080,
          rail_anchor_lat_e5: 4_884_060,
          rail_anchor_lon_e5: 232_100,
          station_id: "station-uic-87391003",
          station_kind: "mainline_rail",
          station_scope: "customer_station",
          station_complex_id: "complex-paris-montparnasse",
          wikidata_qid: "Q3094940",
          uic_code: "87391003",
          prominence: 900
        }
      ]
    }
  });

  assert.equal(dataset.cities[0]!.lat, 48.8801);
  assert.equal(dataset.cities[0]!.lon, 2.3546);
  assert.deepEqual(dataset.stations, [
    {
      cityIndex: 0,
      cityName: "Paris",
      lat: 48.84055,
      lon: 2.3208,
      name: "Paris Montparnasse",
      railAnchorLat: 48.8406,
      railAnchorLon: 2.321,
      stationId: "station-uic-87391003",
      stationKind: "mainline_rail",
      stationScope: "customer_station",
      stationComplexId: "complex-paris-montparnasse",
      wikidataQid: "Q3094940",
      uicCode: "87391003",
      prominence: 900
    }
  ]);
  assert.deepEqual(dataset.plannerArtifacts!.routePairs![0]!.geometry, [
    { lat: 48.8801, lon: 2.3546 },
    { lat: 45.7606, lon: 4.8594 }
  ]);
});
