const YT_TRANSCRIPT_AUTH = "Basic 68e5cdd226d92e0a63f6b424";

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const { pathname } = url;

  // Serve index.html at root
  if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    try {
      const htmlBytes = await Deno.readFile(new URL("./index.html", import.meta.url));
      return new Response(htmlBytes, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch {
      return new Response("index.html not found", { status: 500 });
    }
  }

  // Proxy to youtube-transcript.io
  if (pathname === "/api/transcript") {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const body = await request.json();
      const ids: string[] = Array.isArray(body?.ids)
        ? body.ids
        : body?.id
        ? [String(body.id)]
        : [];

      if (!ids.length) {
        return new Response(JSON.stringify({ error: "Missing 'id' or 'ids'" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const upstream = await fetch("https://www.youtube-transcript.io/api/transcripts", {
        method: "POST",
        headers: {
          "authorization": YT_TRANSCRIPT_AUTH,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ids }),
      });

      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") || "application/json",
          "access-control-allow-origin": "*",
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Upstream request failed" }), {
        status: 502,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }
  }

  return new Response("Not Found", { status: 404 });
});