import test from "node:test";
import assert from "node:assert/strict";

import { createPlannerModel, searchCities } from "./planner-core.ts";

const cities = [
  { name: "Paris", country: "France", interest: 9, lat: 48.8566, lon: 2.3522, pop: 2_100_000 },
  { name: "Lyon", country: "France", interest: 8, lat: 45.764, lon: 4.8357, pop: 515_000 },
  { name: "Dijon", country: "France", interest: 7, lat: 47.322, lon: 5.0415, pop: 156_000 },
  { name: "Marseille", country: "France", interest: 8, lat: 43.2965, lon: 5.3698, pop: 870_000 },
  { name: "Aix-en-Provence", country: "France", interest: 6, lat: 43.5297, lon: 5.4474, pop: 148_000 }
];

const routeData = {
  "Paris-Lyon": 120,
  "Paris-Dijon": 95,
  "Dijon-Lyon": 70,
  "Lyon-Marseille": 105,
  "Marseille-Aix-en-Provence": 15
};

test("createPlannerModel builds fastest path with indexed routing", () => {
  const model = createPlannerModel(cities, routeData);
  const route = model.dijkstra("Paris", "Marseille");

  assert.deepEqual(route!.path, ["Paris", "Lyon", "Marseille"]);
  assert.equal(route!.time, 225);
  assert.deepEqual(route!.geometry, [
    { lat: 48.8566, lon: 2.3522 },
    { lat: 45.764, lon: 4.8357 },
    { lat: 43.2965, lon: 5.3698 }
  ]);
});

test("dijkstraAll returns sparse reachable distances", () => {
  const model = createPlannerModel(cities, routeData);
  const distances = model.dijkstraAll("Paris");

  assert.equal(distances.Paris, 0);
  assert.equal(distances.Lyon, 120);
  assert.equal(distances.Marseille, 225);
  assert.equal(distances["Aix-en-Provence"], 240);
  assert.equal(Object.hasOwn(distances, "Unknown"), false);
});

test("searchCities normalizes diacritics and ranking", () => {
  const results = searchCities(cities, {
    limit: 3,
    query: "provence"
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]!.name, "Aix-en-Provence");
});

test("model searchCities reuses prepared search index", () => {
  const model = createPlannerModel(cities, routeData);
  const results = model.searchCities("france", 2);

  assert.deepEqual(results.map((city) => city.name), ["Paris", "Marseille"]);
});

test("createPlannerModel accepts prepared route pairs and search index", () => {
  const preparedSearchIndex = cities.map((city, cityIndex) => ({
    cityIndex,
    cityNameNormalized: city.name.toLowerCase(),
    countryNormalized: city.country.toLowerCase(),
    searchText: `${city.name.toLowerCase()} ${city.country.toLowerCase()}`
  }));
  const model = createPlannerModel(cities, routeData, {
    routePairs: [
      {
        from: "Paris",
        geometry: [
          { lat: 48.8566, lon: 2.3522 },
          { lat: 47.8, lon: 3.4 },
          { lat: 45.764, lon: 4.8357 }
        ],
        minutes: 120,
        to: "Lyon"
      },
      { from: "Paris", minutes: 95, to: "Dijon" },
      { from: "Dijon", minutes: 70, to: "Lyon" },
      { from: "Lyon", minutes: 105, to: "Marseille" },
      { from: "Marseille", minutes: 15, to: "Aix-en-Provence" }
    ],
    searchIndex: preparedSearchIndex
  });

  assert.equal(model.dijkstra("Paris", "Aix-en-Provence")?.time, 240);
  assert.deepEqual(model.searchCities("aix", 1).map((city) => city.name), ["Aix-en-Provence"]);
  assert.deepEqual(model.dijkstra("Paris", "Lyon")?.geometry, [
    { lat: 48.8566, lon: 2.3522 },
    { lat: 47.8, lon: 3.4 },
    { lat: 45.764, lon: 4.8357 }
  ]);
});
