import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const MAPBOX_API_URL = "https://api.mapbox.com/geocoding/v5/mapbox.places";

function getMapboxKey(): string {
  const key = process.env.MAPBOX_API_KEY;
  if (!key) throw new Error("Mapbox credentials are not configured");
  return key;
}

const searchSchema = z.object({
  query: z.string().min(1).max(200),
  proximity: z
    .object({ lng: z.number(), lat: z.number() })
    .optional(),
  country: z.string().length(2).optional(),
  bbox: z
    .object({
      minLng: z.number(),
      minLat: z.number(),
      maxLng: z.number(),
      maxLat: z.number(),
    })
    .optional(),
});

export type MapboxFeature = {
  id: string;
  name: string;
  place_name: string;
  center: [number, number];
  category?: string;
};

type RawMapboxFeature = {
  id: string;
  text: string;
  place_name: string;
  center: [number, number];
  relevance?: number;
  properties?: { category?: string };
};

type OsmFeature = {
  place_id: number;
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  category?: string;
  type?: string;
  name?: string;
  display_name: string;
};

export const searchLocations = createServerFn({ method: "GET" })
  .validator((data: unknown) => searchSchema.parse(data))
  .handler(async ({ data }): Promise<MapboxFeature[]> => {
    const mapboxKey = getMapboxKey();

    const [mapboxResults, osmResults] = await Promise.all([
      searchMapbox(mapboxKey, data.query, data.proximity, data.country, data.bbox),
      searchOpenStreetMap(data.query, data.country, data.proximity),
    ]);

    let all = [...mapboxResults, ...osmResults];
    let ranked = rankAndDedupe(all, data.query, data.proximity);

    if (ranked.length < 3 && data.query.trim().length >= 3) {
      const [relaxedMapbox, relaxedOsm] = await Promise.all([
        searchMapbox(mapboxKey, data.query, data.proximity),
        searchOpenStreetMap(data.query, undefined, data.proximity),
      ]);
      const relaxedAll = [...relaxedMapbox, ...relaxedOsm, ...all];
      ranked = rankAndDedupe(relaxedAll, data.query, data.proximity);
    }

    return ranked.slice(0, 10);
  });

async function searchMapbox(
  key: string,
  query: string,
  proximity?: { lng: number; lat: number },
  country?: string,
  bbox?: { minLng: number; minLat: number; maxLng: number; maxLat: number },
): Promise<MapboxFeature[]> {
  const params = new URLSearchParams({
    access_token: key,
    autocomplete: "true",
    fuzzyMatch: "true",
    limit: "10",
    types: "poi,address,place,locality,neighborhood",
  });
  if (proximity) {
    params.set("proximity", `${proximity.lng},${proximity.lat}`);
  }
  if (country) {
    params.set("country", country.toLowerCase());
  }
  if (bbox) {
    params.set("bbox", `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}`);
  }

  const encoded = encodeURIComponent(query);
  const url = `${MAPBOX_API_URL}/${encoded}.json?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`Mapbox search failed [${res.status}]: ${body}`);
    return [];
  }

  const json = (await res.json()) as { features: RawMapboxFeature[] };
  return json.features.map((f) => ({
    id: f.id,
    name: f.text,
    place_name: f.place_name,
    center: f.center,
    category: f.properties?.category,
  }));
}

async function searchOpenStreetMap(
  query: string,
  country?: string,
  proximity?: { lng: number; lat: number },
): Promise<MapboxFeature[]> {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "10",
    addressdetails: "1",
  });

  if (country) {
    params.set("countrycodes", country.toLowerCase());
  }

  if (proximity) {
    const delta = 0.75;
    params.set(
      "viewbox",
      `${proximity.lng - delta},${proximity.lat + delta},${proximity.lng + delta},${
        proximity.lat - delta
      }`,
    );
  }

  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "en",
      "User-Agent": "MapSearchMagic/1.0",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`OpenStreetMap search failed [${res.status}]: ${body}`);
    return [];
  }

  const json = (await res.json()) as OsmFeature[];
  return json
    .map((f) => ({
      id: `osm.${f.osm_type}.${f.osm_id || f.place_id}`,
      name: f.name || f.display_name.split(",")[0]?.trim() || f.display_name,
      place_name: f.display_name,
      center: [Number(f.lon), Number(f.lat)] as [number, number],
      category: [f.category, f.type].filter(Boolean).join(" · ") || undefined,
    }))
    .filter((f) => Number.isFinite(f.center[0]) && Number.isFinite(f.center[1]));
}

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[] = new Array(cols);

  for (let j = 0; j < cols; j++) d[j] = j;

  for (let i = 1; i < rows; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j < cols; j++) {
      const temp = d[j];
      d[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, d[j], d[j - 1]);
      prev = temp;
    }
  }

  const maxLen = Math.max(a.length, b.length);
  return 1 - d[cols - 1] / maxLen;
}

function rankAndDedupe(
  results: MapboxFeature[],
  query: string,
  proximity?: { lng: number; lat: number },
) {
  const seen = new Set<string>();
  return results
    .map((result, index) => ({
      result,
      index,
      score: scoreResult(result, query),
      distance: proximity ? distanceKm(result.center, proximity) : 0,
    }))
    .filter(({ result }) => {
      const key = `${normalize(result.name)}:${result.center[0].toFixed(4)}:${result.center[1].toFixed(4)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.distance - b.distance || a.index - b.index)
    .map(({ result }) => result);
}

function scoreResult(result: MapboxFeature, query: string) {
  const normalizedQuery = normalize(query);
  const name = normalize(result.name);
  const place = normalize(result.place_name);
  const tokens = tokenize(query);

  if (name === normalizedQuery) return 8;
  if (name.startsWith(normalizedQuery)) return 7;
  if (name.includes(normalizedQuery)) return 6;
  if (place.includes(normalizedQuery)) return 5;
  if (tokens.length > 1 && tokens.every((token) => place.includes(token))) return 4;
  if (tokens.some((token) => name.startsWith(token))) return 3;
  if (tokens.some((token) => place.includes(token))) return 2;

  const nameRatio = levenshteinRatio(normalizedQuery, name);
  const placeRatio = levenshteinRatio(normalizedQuery, place);
  if (nameRatio >= 0.65) return 2;
  if (placeRatio >= 0.5) return 1;

  return 0;
}

function tokenize(value: string) {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 1);
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function distanceKm(center: [number, number], proximity: { lng: number; lat: number }) {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(center[1] - proximity.lat);
  const dLng = toRad(center[0] - proximity.lng);
  const lat1 = toRad(proximity.lat);
  const lat2 = toRad(center[1]);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const reverseSchema = z.object({
  lng: z.number(),
  lat: z.number(),
});

export type ReverseContext = {
  country?: string;
  countryName?: string;
  region?: string;
  place?: string;
  bbox?: [number, number, number, number];
};

export const reverseGeocode = createServerFn({ method: "GET" })
  .validator((data: unknown) => reverseSchema.parse(data))
  .handler(async ({ data }): Promise<ReverseContext> => {
    const mapboxKey = getMapboxKey();

    const params = new URLSearchParams({
      access_token: mapboxKey,
      types: "country,region,place",
    });

    const url = `${MAPBOX_API_URL}/${data.lng},${data.lat}.json?${params.toString()}`;

    const res = await fetch(url);

    if (!res.ok) {
      const body = await res.text();
      console.error(`Mapbox reverse failed [${res.status}]: ${body}`);
      throw new Error(`Mapbox reverse failed [${res.status}]`);
    }

    const json = (await res.json()) as {
      features: Array<{
        id: string;
        text: string;
        place_type: string[];
        bbox?: [number, number, number, number];
        properties?: { short_code?: string };
      }>;
    };

    const ctx: ReverseContext = {};
    for (const f of json.features) {
      const type = f.place_type[0];
      if (type === "country") {
        ctx.country = f.properties?.short_code?.toLowerCase();
        ctx.countryName = f.text;
        if (!ctx.bbox && f.bbox) ctx.bbox = f.bbox;
      } else if (type === "region") {
        ctx.region = f.text;
      } else if (type === "place") {
        ctx.place = f.text;
      }
    }
    return ctx;
  });
