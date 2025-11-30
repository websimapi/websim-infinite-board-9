import * as THREE from 'three';

/**
 * Build a graph representation from the current chunks map.
 * @param {Map<number, Object>} chunks
 * @returns {{nodesById: Map<string, Object>, adjacency: Map<string, Array<{id: string, weight: number}>>}}
 */
export function buildGraph(chunks) {
    const nodesById = new Map();
    const adjacency = new Map();

    for (const chunk of chunks.values()) {
        for (const node of chunk.nodes) {
            nodesById.set(node.id, node);
            if (!adjacency.has(node.id)) {
                adjacency.set(node.id, []);
            }
        }
    }

    for (const chunk of chunks.values()) {
        for (const edge of chunk.edges) {
            const a = nodesById.get(edge.from);
            const b = nodesById.get(edge.to);
            if (!a || !b) continue;
            const dist = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
            adjacency.get(a.id).push({ id: b.id, weight: dist });
            adjacency.get(b.id).push({ id: a.id, weight: dist });
        }
    }

    return { nodesById, adjacency };
}

/**
 * Compute the shortest path between two node IDs using Dijkstra's algorithm.
 * @param {Map<number, Object>} chunks
 * @param {string} startId
 * @param {string} endId
 * @returns {Array<Object>|null}
 */
export function computeShortestPath(chunks, startId, endId) {
    const { nodesById, adjacency } = buildGraph(chunks);
    if (!nodesById.has(startId) || !nodesById.has(endId)) return null;

    const dist = new Map();
    const prev = new Map();
    const visited = new Set();

    for (const id of nodesById.keys()) {
        dist.set(id, Infinity);
    }
    dist.set(startId, 0);

    // Dijkstra loop
    while (true) {
        let currentId = null;
        let best = Infinity;
        for (const [id, d] of dist) {
            if (!visited.has(id) && d < best) {
                best = d;
                currentId = id;
            }
        }
        if (currentId === null) break;
        if (currentId === endId) break;

        visited.add(currentId);
        const neighbors = adjacency.get(currentId) || [];
        for (const { id: nbId, weight } of neighbors) {
            if (visited.has(nbId)) continue;
            const alt = dist.get(currentId) + weight;
            if (alt < dist.get(nbId)) {
                dist.set(nbId, alt);
                prev.set(nbId, currentId);
            }
        }
    }

    if (!prev.has(endId) && startId !== endId) return null;

    const pathIds = [];
    let u = endId;
    pathIds.unshift(u);
    while (prev.has(u)) {
        u = prev.get(u);
        pathIds.unshift(u);
    }

    const pathNodes = pathIds.map(id => nodesById.get(id)).filter(Boolean);
    return pathNodes.length >= 2 ? pathNodes : null;
}