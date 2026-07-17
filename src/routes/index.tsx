import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { searchLocations, reverseGeocode, type MapboxFeature, type ReverseContext } from "@/lib/mapbox.functions";
import { Search, MapPin, Loader2 } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Location Search — Powered by Mapbox" },
      {
        name: "description",
        content:
          "Search places, shops, and addresses with live autocomplete and view them instantly on an interactive map.",
      },
      { property: "og:title", content: "Location Search — Powered by Mapbox" },
      {
        property: "og:description",
        content: "Live location autocomplete with an interactive map.",
      },
    ],
  }),
  component: Index,
});

function useDebounced<T>(value: T, delay = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

function Index() {
  const search = useServerFn(searchLocations);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MapboxFeature[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<MapboxFeature | null>(null);
  const [proximity, setProximity] = useState<{ lng: number; lat: number } | null>(
    null,
  );
  const [country, setCountry] = useState<string | null>(null);
  const [bbox, setBbox] = useState<{ minLng: number; minLat: number; maxLng: number; maxLat: number } | null>(null);

  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const mapboxRef = useRef<any>(null);

  const debouncedQuery = useDebounced(query, 200);

  const publicToken = useMemo(
    () => import.meta.env.VITE_MAPBOX_PUBLIC_TOKEN as string | undefined,
    [],
  );

  // Get user location for proximity biasing
  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setProximity({ lng: pos.coords.longitude, lat: pos.coords.latitude }),
      () => {},
      { timeout: 4000 },
    );
  }, []);

  // Reverse-geocode to detect user's country and region bbox
  useEffect(() => {
    if (!proximity) return;
    let cancelled = false;
    reverseGeocode({ data: proximity })
      .then((r) => {
        if (cancelled) return;
        if (r.country) setCountry(r.country);
        if (r.bbox) {
          const [minLng, minLat, maxLng, maxLat] = r.bbox;
          setBbox({ minLng, minLat, maxLng, maxLat });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [proximity]);

  // Init map (dynamic import to avoid SSR crash)
  useEffect(() => {
    if (!publicToken || !mapContainer.current || mapRef.current) return;
    let cancelled = false;

    Promise.all([
      import("mapbox-gl"),
      import("mapbox-gl/dist/mapbox-gl.css"),
    ]).then(([mapboxgl]) => {
      if (cancelled || !mapContainer.current || mapRef.current) return;
      mapboxRef.current = mapboxgl.default;
      mapboxgl.default.accessToken = publicToken;
      mapRef.current = new mapboxgl.default.Map({
        container: mapContainer.current,
        style: "mapbox://styles/mapbox/streets-v12",
        center: [-74.006, 40.7128],
        zoom: 10,
      });
      mapRef.current.addControl(new mapboxgl.default.NavigationControl(), "top-right");
    }).catch(() => {});

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [publicToken]);

  // Recenter to user location once available
  useEffect(() => {
    if (proximity && mapRef.current && !selected) {
      mapRef.current.easeTo({ center: [proximity.lng, proximity.lat], zoom: 11 });
    }
  }, [proximity, selected]);

  // Live search
  useEffect(() => {
    let cancelled = false;
    if (!debouncedQuery.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    search({
      data: {
        query: debouncedQuery,
        proximity: proximity ?? undefined,
        country: country ?? undefined,
        bbox: bbox ?? undefined,
      },
    })
      .then((r) => {
        if (!cancelled) setResults(r);
      })
      .catch((e) => {
        console.error(e);
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, proximity, country, bbox, search]);

  const handleSelect = (feature: MapboxFeature) => {
    setSelected(feature);
    setQuery(feature.place_name);
    setOpen(false);
    const map = mapRef.current;
    const mapboxgl = mapboxRef.current;
    if (!map || !mapboxgl) return;
    markerRef.current?.remove();
    markerRef.current = new mapboxgl.Marker({ color: "#ef4444" })
      .setLngLat(feature.center)
      .setPopup(
        new mapboxgl.Popup({ offset: 24 }).setHTML(
          `<div style="font-family:system-ui;font-size:13px"><strong>${escapeHtml(
            feature.name,
          )}</strong><br/><span style="color:#666">${escapeHtml(
            feature.place_name,
          )}</span></div>`,
        ),
      )
      .addTo(map);
    map.flyTo({ center: feature.center, zoom: 15, essential: true });
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-5xl px-4 py-5">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Location Search
          </h1>
          <p className="text-xs text-muted-foreground">
            Type a place, shop, or address — suggestions appear near you.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        <div className="relative">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-3.5 h-4 w-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              placeholder="Search for shops, addresses, places…"
              className="h-12 w-full rounded-xl border border-input bg-card pl-10 pr-10 text-sm text-foreground shadow-sm outline-none transition-shadow placeholder:text-muted-foreground focus:border-ring focus:shadow-md"
            />
            {loading && (
              <Loader2 className="absolute right-3.5 h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>

          {open && query.trim() && (results.length > 0 || !loading) && (
            <ul className="absolute z-20 mt-2 w-full overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
              {results.length === 0 && !loading && (
                <li className="px-4 py-3 text-sm text-muted-foreground">
                  No matches found
                </li>
              )}
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleSelect(r)}
                    className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent"
                  >
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {r.name}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {r.place_name}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl border border-border shadow-sm">
          <div ref={mapContainer} className="h-[560px] w-full" />
        </div>

        {selected && (
          <div className="mt-4 rounded-xl border border-border bg-card p-4">
            <div className="text-sm font-medium text-foreground">{selected.name}</div>
            <div className="text-xs text-muted-foreground">{selected.place_name}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {selected.center[1].toFixed(5)}, {selected.center[0].toFixed(5)}
            </div>
          </div>
        )}

        {!publicToken && (
          <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            Mapbox public token is missing. Reconnect the Mapbox connector.
          </div>
        )}
      </main>
    </div>
  );
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
