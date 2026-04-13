import type { APIRoute } from "astro";
import { searchAirports, toAirportSummary } from "../../../lib/airport-data";

export const GET: APIRoute = async ({ url }) => {
  const query = String(url.searchParams.get("q") ?? "");
  const limitParam = Number(url.searchParams.get("limit") ?? "20");
  const limit = Number.isFinite(limitParam) ? limitParam : 20;

  if (!query.trim()) {
    return Response.json({ airports: [] });
  }

  try {
    const matches = await searchAirports(query, limit);
    return Response.json({
      airports: matches.map((airport) => toAirportSummary(airport)),
    });
  } catch {
    return Response.json(
      {
        error: "Airport search is temporarily unavailable.",
        airports: [],
      },
      {
        status: 500,
      },
    );
  }
};
