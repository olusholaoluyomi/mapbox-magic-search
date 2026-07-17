import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const MAPBOX_API_URL = "https://api.mapbox.com/geocoding/v5/mapbox.places";

const searchSchema = z.object({
  query: z.string().min(1).max(200),
  proximity: z
    .object({ lng: z.number(), lat: z.number() })
    .optional(),
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
