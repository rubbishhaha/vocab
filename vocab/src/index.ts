// Worker that serves static assets and exposes a tiny JSON API backed by KV.
// Frontend persists state via /api/state -> Cloudflare KV (binding: VOCAB).

interface Env {
	// Provided by wrangler "assets" binding
	ASSETS: Fetcher;
	// KV Namespace binding for app state
	VOCAB: KVNamespace;
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		// API: simple state CRUD stored under a single key in KV
		if (url.pathname === '/api/state') {
			const headers = { 'content-type': 'application/json; charset=utf-8' } as const;
			switch (request.method) {
				case 'GET': {
					const raw = await env.VOCAB.get('state');
					if (!raw) {
						const now = todayStr();
						const def = { items: [], counter: 0, debt: 0, lastDecay: now, createdAt: now };
						return new Response(JSON.stringify(def), { headers });
					}
					return new Response(raw, { headers });
				}
				case 'PUT': {
					try {
						const body = await request.json<any>();
						// minimal validation: require object with items array
						if (typeof body !== 'object' || !Array.isArray(body.items)) {
							return new Response(JSON.stringify({ error: 'Invalid state shape' }), { status: 400, headers });
						}
						await env.VOCAB.put('state', JSON.stringify(body));
						return new Response(null, { status: 204 });
					} catch (e) {
						return new Response(JSON.stringify({ error: 'Bad JSON' }), { status: 400, headers });
					}
				}
				case 'DELETE': {
					await env.VOCAB.delete('state');
					return new Response(null, { status: 204 });
				}
				default:
					return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
			}
		}

		// Redirect root to the vocab page for convenience
		if (url.pathname === '/' || url.pathname === '') {
			return Response.redirect(new URL('/vocab.html', url).toString(), 301);
		}

		// Convenience route: /vocab -> /vocab.html
		if (url.pathname === '/vocab' || url.pathname === '/vocab/') {
			url.pathname = '/vocab.html';
			return env.ASSETS.fetch(new Request(url, request));
		}

		// Try to serve a static asset first
		const res = await env.ASSETS.fetch(request);
		if (res.status !== 404) return res;

		// SPA-style fallback: if no extension, serve vocab.html
		const hasExtension = /\.[a-zA-Z0-9]+$/.test(url.pathname);
		if (!hasExtension) {
			url.pathname = '/vocab.html';
			return env.ASSETS.fetch(new Request(url, request));
		}

		return res; // true 404 for missing concrete assets
	},
} satisfies ExportedHandler<Env>;

function todayStr(d = new Date()): string {
	return d.toISOString().slice(0, 10);
}
