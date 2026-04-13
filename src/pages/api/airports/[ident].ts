import type { APIRoute } from "astro";
import { getAirportByIdentifier, toAirportSummary } from "../../../lib/airport-data";

export const GET: APIRoute = async ({ params }) => {
  const identifier = String(params.ident ?? "");
  if (!identifier) {
    return Response.json({ error: "Missing airport identifier." }, { status: 400 });
  }

  try {
    const airport = await getAirportByIdentifier(identifier);
    if (!airport) {
      return Response.json({ error: "Airport not found." }, { status: 404 });
    }

    return Response.json({ airport: toAirportSummary(airport) });
  } catch {
    return Response.json({ error: "Airport lookup failed." }, { status: 500 });
  }
};
