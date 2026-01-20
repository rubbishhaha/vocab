/**
 * Mindmap Storage API with Cloudflare KV
 * Provides sync between local storage and cloud storage
 */

interface MindmapData {
	tree: any;
	currentCenterId: string;
	viewOffset: { x: number; y: number };
	deletedNodes: string[];
	timestamp: string;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		
		// CORS headers
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		// Handle CORS preflight
		if (req.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		// Vocab API routes
		if (url.pathname === '/api/state') {
			return handleVocabState(req, env, corsHeaders);
		}

		// Mindmap API routes
		if (url.pathname === '/api/sync') {
			return handleSync(req, env, corsHeaders);
		}

		// Redirect routes
		if (url.pathname === '/' || url.pathname === '') {
			return Response.redirect(new URL('/index.html', url).toString(), 301);
		}

		if (url.pathname === '/quiz' || url.pathname === '/quiz/') {
			url.pathname = '/quiz.html';
			return env.ASSETS.fetch(new Request(url, req));
		}

		if (url.pathname === '/vocab' || url.pathname === '/vocab/') {
			url.pathname = '/vocab.html';
			return env.ASSETS.fetch(new Request(url, req));
		}

		// Serve static assets
		const res = await env.ASSETS.fetch(req);
		if (res.status !== 404) return res;

		// SPA-style fallback
		const hasExtension = /\.[a-zA-Z0-9]+$/.test(url.pathname);
		if (!hasExtension) {
			url.pathname = '/index.html';
			return env.ASSETS.fetch(new Request(url, req));
		}

		return res;
	},

	async scheduled(event: any, env: Env, ctx: any): Promise<void> {
		console.log(`Scheduled task fired at ${event.cron}`);
	},
} satisfies ExportedHandler<Env>;

async function handleVocabState(req: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	const headers = { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' };
	
	try {
		switch (req.method) {
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
				const body = await req.json<any>();
				if (typeof body !== 'object' || !Array.isArray(body.items)) {
					return new Response(JSON.stringify({ error: 'Invalid state shape' }), { status: 400, headers });
				}
				await env.VOCAB.put('state', JSON.stringify(body));
				return new Response(null, { status: 204 });
			}
			case 'DELETE': {
				await env.VOCAB.delete('state');
				return new Response(null, { status: 204 });
			}
			default:
				return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
		}
	} catch (e) {
		return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
	}
}

async function handleSync(req: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	const headers = { ...corsHeaders, 'Content-Type': 'application/json' };
	
	try {
		if (req.method === 'GET') {
			// Get cloud data
			const cloudData = await env.MINDMAP_KV.get('mindmap_data', 'json');
			return new Response(JSON.stringify({
				success: true,
				data: cloudData
			}), { headers });
		}

		if (req.method === 'POST') {
			// Merge and save data
			const body = await req.json() as { localData: MindmapData | null };
			const localData = body.localData;
			
			// Get existing cloud data
			const cloudData = await env.MINDMAP_KV.get('mindmap_data', 'json') as MindmapData | null;
			
			let mergedData: MindmapData;
			
			if (!cloudData && localData) {
				// No cloud data, use local
				mergedData = localData;
			} else if (cloudData && !localData) {
				// No local data, use cloud
				mergedData = cloudData;
			} else if (cloudData && localData) {
				// Both exist, merge based on timestamp
				mergedData = mergeMindmapData(cloudData, localData);
			} else {
				// Neither exists
				return new Response(JSON.stringify({
					success: false,
					error: 'No data provided'
				}), {
					status: 400,
					headers
				});
			}
			
			// Save merged data to KV
			await env.MINDMAP_KV.put('mindmap_data', JSON.stringify(mergedData));
			
			return new Response(JSON.stringify({
				success: true,
				data: mergedData
			}), { headers });
		}

		return new Response(JSON.stringify({
			success: false,
			error: 'Method not allowed'
		}), {
			status: 405,
			headers
		});
	} catch (error) {
		console.error('handleSync error:', error);
		return new Response(JSON.stringify({
			success: false,
			error: String(error),
			stack: error instanceof Error ? error.stack : undefined
		}), {
			status: 500,
			headers
		});
	}
}

function mergeMindmapData(cloudData: MindmapData, localData: MindmapData): MindmapData {
	// Merge deleted nodes from both sources
	const cloudDeletedNodes = new Set(cloudData.deletedNodes || []);
	const localDeletedNodes = new Set(localData.deletedNodes || []);
	const allDeletedNodes = new Set([...cloudDeletedNodes, ...localDeletedNodes]);
	
	// Parse deletion records to get IDs
	const deletedIds = new Set<string>();
	for (let record of allDeletedNodes) {
		try {
			const parsed = JSON.parse(record);
			deletedIds.add(parsed.id);
		} catch (e) {
			// Skip invalid records
		}
	}
	
	// Compare timestamps to determine which is newer
	const cloudTime = new Date(cloudData.timestamp).getTime();
	const localTime = new Date(localData.timestamp).getTime();
	
	// Use the newer one as base
	const newerData = localTime > cloudTime ? localData : cloudData;
	const olderData = localTime > cloudTime ? cloudData : localData;
	
	// Merge trees: add branches from older data that don't exist in newer data
	// but skip nodes that were deleted
	const mergedTree = mergeNodes(newerData.tree, olderData.tree, deletedIds);
	
	return {
		tree: mergedTree,
		currentCenterId: newerData.currentCenterId,
		viewOffset: newerData.viewOffset,
		deletedNodes: Array.from(allDeletedNodes),
		timestamp: new Date().toISOString()
	};
}

function mergeNodes(newerNode: any, olderNode: any, deletedIds: Set<string>): any {
	if (!newerNode) return olderNode;
	if (!olderNode) return newerNode;
	
	// Don't restore deleted nodes
	if (deletedIds.has(newerNode.id)) return null;
	if (deletedIds.has(olderNode.id)) return null;
	
	const merged = { ...newerNode };
	
	// Merge children
	const newerChildren = newerNode.children || [];
	const olderChildren = olderNode.children || [];
	
	// Create a map of newer children by id
	const newerChildMap = new Map();
	newerChildren.forEach((child: any) => {
		newerChildMap.set(child.id, child);
	});
	
	// Add older children that don't exist in newer version
	const mergedChildren = [...newerChildren];
	olderChildren.forEach((oldChild: any) => {
		// Skip deleted nodes
		if (deletedIds.has(oldChild.id)) return;
		
		if (!newerChildMap.has(oldChild.id)) {
			// This branch doesn't exist in newer version, add it
			mergedChildren.push(oldChild);
		} else {
			// Child exists in both, recursively merge
			const newerChild = newerChildMap.get(oldChild.id);
			const mergedChild = mergeNodes(newerChild, oldChild, deletedIds);
			// Replace the newer child with merged version if not null
			if (mergedChild) {
				const index = mergedChildren.findIndex((c: any) => c.id === oldChild.id);
				if (index !== -1) {
					mergedChildren[index] = mergedChild;
				}
			}
		}
	});
	
	// Filter out null children (deleted ones)
	merged.children = mergedChildren.filter((c: any) => c !== null);
	return merged;
}

function todayStr(d = new Date()): string {
	return d.toISOString().slice(0, 10);
}
