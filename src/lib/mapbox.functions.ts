import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const MAPBOX_API_URL = "https://api.mapbox.com/geocoding/v5/mapbox.places";

const searchSchema = z.object({
  query: z.string().min(1).max(200),
  proximity: z
    .object({ lng: z.number(), lat: z.number() })
    .optional(),
  country: z.string().optional(),
  bbox: z.string().optional(),
});

export type MapboxFeature = {
  id: string;
  name: string;
  place_name: string;
  center: [number, number];
  category?: string;
};

export const searchLocations = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => searchSchema.parse(data))
  .handler(async ({ data }): Promise<MapboxFeature[]> => {
    const mapboxKey = process.env.MAPBOX_API_KEY;
    if (!mapboxKey) {
      throw new Error("Mapbox credentials are not configured");
    }

    const params = new URLSearchParams({
      access_token: mapboxKey,
      autocomplete: "true",
      limit: "8",
      types: "poi,address,place,locality,neighborhood",
    });
    if (data.proximity) {
      params.set("proximity", `${data.proximity.lng},${data.proximity.lat}`);
    }
    if (data.country) {
      params.set("country", data.country);
    }
    if (data.bbox) {
      params.set("bbox", data.bbox);
    }

    const encoded = encodeURIComponent(data.query);
    const url = `${MAPBOX_API_URL}/${encoded}.json?${params.toString()}`;

    const res = await fetch(url);

    if (!res.ok) {
      const body = await res.text();
      console.error(`Mapbox search failed [${res.status}]: ${body}`);
      throw new Error(`Mapbox search failed [${res.status}]`);
    }

    const json = (await res.json()) as {
      features: Array<{
        id: string;
        text: string;
        place_name: string;
        center: [number, number];
        properties?: { category?: string };
      }>;
    };

    return json.features.map((f) => ({
      id: f.id,
      name: f.text,
      place_name: f.place_name,
      center: f.center,
      category: f.properties?.category,
    }));
  });

const reverseGeocodeSchema = z.object({
  lng: z.number(),
  lat: z.number(),
});

export type ReverseGeocodeResult = {
  countryCode: string | null;
  countryName: string | null;
};

export const reverseGeocode = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => reverseGeocodeSchema.parse(data))
  .handler(async ({ data }): Promise<ReverseGeocodeResult> => {
    const mapboxKey = process.env.MAPBOX_API_KEY;
    if (!mapboxKey) {
      throw new Error("Mapbox credentials are not configured");
    }

    const params = new URLSearchParams({
      access_token: mapboxKey,
      types: "country,region",
    });

    const url = `${MAPBOX_API_URL}/${data.lng},${data.lat}.json?${params.toString()}`;

    const res = await fetch(url);

    if (!res.ok) {
      const body = await res.text();
      console.error(`Reverse geocode failed [${res.status}]: ${body}`);
      throw new Error(`Reverse geocode failed [${res.status}]`);
    }

    const json = (await res.json()) as {
      features: Array<{
        id: string;
        text: string;
        properties: { short_code?: string };
      }>;
    };

    const countryFeature = json.features.find(
      (f) => f.id.startsWith("country"),
    );

    return {
      countryCode: countryFeature?.properties?.short_code?.toUpperCase() ?? null,
      countryName: countryFeature?.text ?? null,
    };
  });
