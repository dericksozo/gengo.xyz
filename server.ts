Deno.serve((request) => {
  const { pathname } = new URL(request.url);

  if (pathname === "/") {
    return new Response("hello word", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new Response("Not Found", { status: 404 });
});