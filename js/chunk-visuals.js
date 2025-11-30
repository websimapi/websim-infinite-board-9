import * as THREE from 'three';
import { Terrain } from './board-gen.js';

/**
 * Adds chunk visuals (terrain, water, nodes, trails) to the scene.
 * 
 * @param {THREE.Scene} scene 
 * @param {AssetManager} assets 
 * @param {TerrainVisuals} terrainVisuals 
 * @param {Map} meshMap 
 * @param {Map} chunkGroups 
 * @param {THREE.Raycaster} raycaster 
 * @param {Object} chunkData 
 * @param {Object|null} prevChunkData 
 * @param {Object|null} nextChunkData 
 * @returns {THREE.Group}
 */
export function addChunkVisualsToScene(
    scene,
    assets,
    terrainVisuals,
    meshMap,
    chunkGroups,
    chunkData,
    prevChunkData = null,
    nextChunkData = null
) {
    // Remove existing chunk visual if updating
    if (chunkGroups.has(chunkData.index)) {
        const oldGroup = chunkGroups.get(chunkData.index);
        scene.remove(oldGroup);
        // Cleanup meshes from meshMap that belong to this chunk
        chunkData.nodes.forEach(node => meshMap.delete(node.id));
        // Dispose geometries
        oldGroup.traverse(o => {
            if (o.geometry && 
                o.geometry !== assets.nodeGeometry && 
                o.geometry !== assets.waterGeometry &&
                o.geometry !== assets.trailDotGeometry
            ) {
                o.geometry.dispose();
            }
        });
        chunkGroups.delete(chunkData.index);
    }

    const group = new THREE.Group();

    // 0. Prepare Path Segments (Merging current edges and next chunk edges)
    const pathSegments = [];

    const processEdge = (edge, nodesSource, otherNodesSource) => {
        let startNode = nodesSource.find(n => n.id === edge.from);
        if (!startNode) {
            const mesh = meshMap.get(edge.from);
            if (mesh) startNode = mesh.userData;
        }

        let endNode = nodesSource.find(n => n.id === edge.to);
        if (!endNode && otherNodesSource) {
            endNode = otherNodesSource.find(n => n.id === edge.to);
        }

        if (startNode && endNode) {
            pathSegments.push({
                sx: startNode.x, sy: startNode.y, sz: startNode.z,
                ex: endNode.x, ey: endNode.y, ez: endNode.z,
                lenSq: (endNode.x - startNode.x) ** 2 + (endNode.z - startNode.z) ** 2
            });
        }
    };

    chunkData.edges.forEach(edge => processEdge(edge, chunkData.nodes));

    if (nextChunkData) {
        nextChunkData.edges.forEach(edge => processEdge(edge, chunkData.nodes, nextChunkData.nodes));
    }

    // 1. Generate Terrain Strips (Center, Left, Right)
    // Collect all nodes that might affect terrain height
    const allNodes = [...chunkData.nodes];
    if (prevChunkData) allNodes.push(...prevChunkData.nodes);
    if (nextChunkData) allNodes.push(...nextChunkData.nodes);

    const terrainMeshes = [];
    // 3 strips covering 750m width
    const centerTerrain = terrainVisuals.generateTerrainStrip(chunkData.index, 0, true, pathSegments, allNodes);
    const leftTerrain = terrainVisuals.generateTerrainStrip(chunkData.index, -250, false, null, null);
    const rightTerrain = terrainVisuals.generateTerrainStrip(chunkData.index, 250, false, null, null);

    // Tag for identification
    centerTerrain.userData = { isGround: true };
    leftTerrain.userData = { isGround: true };
    rightTerrain.userData = { isGround: true };

    terrainMeshes.push(centerTerrain, leftTerrain, rightTerrain);

    group.add(centerTerrain);
    group.add(leftTerrain);
    group.add(rightTerrain);

    // 2. Add Water Plane
    const waterMesh = new THREE.Mesh(assets.waterGeometry, assets.waterMaterial);
    // Center water properly on the 250m chunk
    waterMesh.position.set(0, Terrain.WATER_LEVEL, -chunkData.index * 250 - 125);
    waterMesh.receiveShadow = true;
    waterMesh.userData = { isWater: true };
    group.add(waterMesh);

    // Raycasts for trails should also consider water
    terrainMeshes.push(waterMesh);

    // 3. Nodes
    chunkData.nodes.forEach(node => {
        const mesh = new THREE.Mesh(assets.nodeGeometry, assets.nodeMaterial.clone());
        mesh.position.set(node.x, node.y + 0.2, node.z);
        mesh.userData = { isNode: true, id: node.id, ...node };

        // Identify floating nodes
        if (Math.abs(node.y - (Terrain.WATER_LEVEL + 0.2)) < 0.1) {
            mesh.userData.isFloating = true;
            mesh.userData.baseY = mesh.position.y;
            
            // Calculate exact visual ground height at this location to prevent clipping
            const hInfo = terrainVisuals.getModifiedHeight(node.x, node.z, pathSegments, allNodes);
            // Mesh is height 0.5 centered (extends +/- 0.25). 
            // We want bottom of mesh (y-0.25) to be at or above ground (hInfo.y).
            // So min center y = hInfo.y + 0.25.
            mesh.userData.minY = hInfo.y + 0.25;
        }

        if (node.id === 'node_start') {
            mesh.material.emissive.setHex(0x00ff88);
        }

        group.add(mesh);
        meshMap.set(node.id, mesh);
    });

    // Ensure matrices are updated for accurate raycasting
    centerTerrain.updateMatrixWorld();
    leftTerrain.updateMatrixWorld();
    rightTerrain.updateMatrixWorld();
    waterMesh.updateMatrixWorld();

    scene.add(group);
    chunkGroups.set(chunkData.index, group);
    return group;
}