// Lightweight IP → city/country lookup using ip-api.com's free, keyless
// endpoint (45 req/min). Results are cached for the lifetime of the
// process. Private/loopback addresses short-circuit to "local".

export type GeoInfo = {
  city: string | null;
  country: string | null;
  // Set when the API call failed or the IP was non-public.
  note?: string;
};

const cache = new Map<string, GeoInfo>();
const inflight = new Map<string, Promise<GeoInfo>>();

export function lookupCached(ip: string): GeoInfo | null {
  return cache.get(ip) ?? null;
}

export async function lookup(ip: string): Promise<GeoInfo> {
  const cached = cache.get(ip);
  if (cached) return cached;
  const existing = inflight.get(ip);
  if (existing) return existing;
  const p = (async (): Promise<GeoInfo> => {
    if (isPrivateOrLocal(ip)) {
      const info: GeoInfo = { city: null, country: null, note: "local" };
      cache.set(ip, info);
      return info;
    }
    try {
      const r = await fetch(
        `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city,regionName,query,message`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j: any = await r.json();
      const info: GeoInfo =
        j?.status === "success"
          ? { city: j.city || null, country: j.countryCode || j.country || null }
          : { city: null, country: null, note: j?.message || "lookup failed" };
      cache.set(ip, info);
      return info;
    } catch (e: any) {
      const info: GeoInfo = { city: null, country: null, note: String(e?.message ?? e) };
      cache.set(ip, info);
      return info;
    } finally {
      inflight.delete(ip);
    }
  })();
  inflight.set(ip, p);
  return p;
}

function isPrivateOrLocal(ip: string): boolean {
  if (ip === "local" || ip === "(self)" || ip === "::1" || ip === "127.0.0.1") return true;
  // IPv4 private ranges
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1]!, b = +m[2]!;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // IPv6 ULA / link-local
  if (/^fe80:/i.test(ip)) return true;
  if (/^fc[0-9a-f]{2}:/i.test(ip) || /^fd[0-9a-f]{2}:/i.test(ip)) return true;
  return false;
}

export function formatGeo(info: GeoInfo | null): string {
  if (!info) return "…";
  if (info.note === "local") return "local";
  const parts = [info.city, info.country].filter(Boolean);
  return parts.length ? parts.join(", ") : (info.note ?? "?");
}
