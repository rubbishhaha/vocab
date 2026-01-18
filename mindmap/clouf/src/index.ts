/**
 * Mindmap Storage API with Cloudflare KV
 * Provides sync between local storage and cloud storage
 */

interface MindmapData {
	tree: any;
	currentCenterId: string;
	viewOffset: { x: number; y: number };
	timestamp: string;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		
		// CORS headers
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		// Handle CORS preflight
		if (req.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		// API routes
		if (url.pathname === '/api/sync') {
			return handleSync(req, env, corsHeaders);
		}

		// Serve static assets
		return env.ASSETS.fetch(req);
	},

	async scheduled(event: any, env: Env, ctx: any): Promise<void> {
		console.log(`Scheduled task fired at ${event.cron}`);
	},
} satisfies ExportedHandler<Env>;

async function handleSync(req: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	try {
		if (req.method === 'GET') {
			// Get cloud data
			const cloudData = await env.MINDMAP_KV.get('mindmap_data', 'json');
			return new Response(JSON.stringify({
				success: true,
				data: cloudData
			}), {
				headers: { ...corsHeaders, 'Content-Type': 'application/json' }
			});
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
					headers: { ...corsHeaders, 'Content-Type': 'application/json' }
				});
			}
			
			// Save merged data to KV
			await env.MINDMAP_KV.put('mindmap_data', JSON.stringify(mergedData));
			
			return new Response(JSON.stringify({
				success: true,
				data: mergedData
			}), {
				headers: { ...corsHeaders, 'Content-Type': 'application/json' }
			});
		}

		return new Response('Method not allowed', {
			status: 405,
			headers: corsHeaders
		});
	} catch (error) {
		return new Response(JSON.stringify({
			success: false,
			error: String(error)
		}), {
			status: 500,
			headers: { ...corsHeaders, 'Content-Type': 'application/json' }
		});
	}
}

function mergeMindmapData(cloudData: MindmapData, localData: MindmapData): MindmapData {
	// Compare timestamps to determine which is newer
	const cloudTime = new Date(cloudData.timestamp).getTime();
	const localTime = new Date(localData.timestamp).getTime();
	
	// Use the newer one as base
	const newerData = localTime > cloudTime ? localData : cloudData;
	const olderData = localTime > cloudTime ? cloudData : localData;
	
	// Merge trees: add branches from older data that don't exist in newer data
	const mergedTree = mergeNodes(newerData.tree, olderData.tree);
	
	return {
		tree: mergedTree,
		currentCenterId: newerData.currentCenterId,
		viewOffset: newerData.viewOffset,
		timestamp: new Date().toISOString()
	};
}

function mergeNodes(newerNode: any, olderNode: any): any {
	if (!newerNode) return olderNode;
	if (!olderNode) return newerNode;
	
	const merged = { ...newerNode };
	
	// Merge children
	const newerChildren = newerNode.children || [];
	const olderChildren = olderNode.children || [];
	
	// Create a map of newer children by name
	const newerChildMap = new Map();
	newerChildren.forEach((child: any) => {
		newerChildMap.set(child.name, child);
	});
	
	// Add older children that don't exist in newer version
	const mergedChildren = [...newerChildren];
	olderChildren.forEach((oldChild: any) => {
		if (!newerChildMap.has(oldChild.name)) {
			// This branch doesn't exist in newer version, add it
			mergedChildren.push(oldChild);
		} else {
			// Child exists in both, recursively merge
			const newerChild = newerChildMap.get(oldChild.name);
			const mergedChild = mergeNodes(newerChild, oldChild);
			// Replace the newer child with merged version
			const index = mergedChildren.findIndex((c: any) => c.name === oldChild.name);
			if (index !== -1) {
				mergedChildren[index] = mergedChild;
			}
		}
	});
	
	merged.children = mergedChildren;
	return merged;
}

