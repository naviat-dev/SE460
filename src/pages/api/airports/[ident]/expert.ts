import type { APIRoute } from "astro";
import { getAirportExpertData } from "../../../../lib/airport-data";

export const GET: APIRoute = async ({ params }) => {
  const identifier = String(params.ident ?? "");
  if (!identifier) {
    return Response.json({ error: "Missing airport identifier." }, { status: 400 });
  }

  try {
    const expertData = await getAirportExpertData(identifier);
    if (!expertData) {
      return Response.json({ error: "Airport not found." }, { status: 404 });
    }

    return Response.json({ expert: expertData });
  } catch {
    return Response.json({ error: "Unable to load expert airport data." }, { status: 500 });
  }
};
