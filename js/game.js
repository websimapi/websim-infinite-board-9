import * as THREE from 'three';
import { BoardGenerator } from './board-gen.js';
import { Storage } from './storage.js';
import { Graphics } from './graphics.js';
import { computeShortestPath } from './pathfinding.js';

export class Game {
    constructor() {
        this.graphics = new Graphics(document.body);
        this.generator = new BoardGenerator();
        
        this.chunks = new Map();
        this.currentNode = null;
        this.isMoving = false;
        this.moveProgress = 0;
        this.startMovePos = new THREE.Vector3();
        this.targetMovePos = new THREE.Vector3();
        this.moveDuration = 0;     // seconds needed for current move
        this.moveElapsed = 0;      // seconds elapsed in current move
        this.clock = new THREE.Clock(); // for time-based movement
        this.lastLogicalPos = new THREE.Vector3(); // track last logical position for per-frame distance

        // Queued multi-step path (list of remaining nodes to visit)
        this.pathQueue = [];

        // Places visited counter
        this.score = 0;
        this.scoreEl = document.getElementById('score');

        // Total distance traveled (split walking vs swimming) in meters
        this.distanceWalkedMeters = 0;
        this.distanceSwamMeters = 0;
        this.stepsEl = document.getElementById('steps-km');
        this.swamEl = document.getElementById('swam-km');
        
        this.init();
        
        window.addEventListener('resize', () => this.graphics.resize());
        
        // Touch/Click handling
        const canvas = this.graphics.renderer.domElement;
        canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
        
        document.getElementById('reset-btn').addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent click-through to board
            this.reset();
        });

        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    async init() {
        const savedState = Storage.getPlayerState();
        
        // Always ensure chunk 0
        await this.ensureChunk(0);
        
        let startNode = this.chunks.get(0).nodes.find(n => n.id === 'node_start');

        if (savedState && savedState.currentNodeId) {
            this.score = savedState.score || 0;
            // Backwards compatible: older saves used distanceMeters for total
            const legacyTotal = savedState.distanceMeters || 0;
            this.distanceWalkedMeters = savedState.distanceWalkedMeters != null ? savedState.distanceWalkedMeters : legacyTotal;
            this.distanceSwamMeters = savedState.distanceSwamMeters || 0;
            this.updateScoreUI();
            
            // Load necessary chunk
            const chunkIdx = this.getChunkIndexFromNodeId(savedState.currentNodeId);
            await this.ensureChunk(chunkIdx);
            // Load previous chunk for edges if needed
            if (chunkIdx > 0) await this.ensureChunk(chunkIdx - 1);
            
            // Verify node exists in this version of the world
            const mesh = this.graphics.meshMap.get(savedState.currentNodeId);
            if (mesh) {
                this.currentNode = mesh.userData;
            } else {
                // Fallback if node not found (e.g. version change invalidating ID)
                console.warn("Saved node not found, resetting to start.");
                this.currentNode = startNode;
                this.score = 0;
                this.distanceWalkedMeters = 0;
                this.distanceSwamMeters = 0;
                this.updateScoreUI();
            }
        } else {
            this.currentNode = startNode;
            this.updateScoreUI();
        }

        this.graphics.createPlayer(new THREE.Vector3(this.currentNode.x, this.currentNode.y, this.currentNode.z));
        this.graphics.updateCamera(new THREE.Vector3(this.currentNode.x, this.currentNode.y, this.currentNode.z));
        this.lastLogicalPos.set(this.currentNode.x, this.currentNode.y, this.currentNode.z);
        
        this.checkChunkLoad();

        // Generate background chunks (visual only)
        this.ensureChunk(-1);
        this.ensureChunk(-2);
    }

    getChunkIndexFromNodeId(id) {
        if(id === 'node_start') return 0;
        const parts = id.split('_'); 
        if(parts[0].startsWith('c')) {
            return parseInt(parts[0].substring(1));
        }
        return 0;
    }

    async ensureChunk(index) {
        if (this.chunks.has(index)) return;

        let chunkData = Storage.getChunk(index);
        
        if (!chunkData) {
            let prevExitNodes = [];
            if (index > 0) {
                if (!this.chunks.has(index - 1)) await this.ensureChunk(index - 1);
                prevExitNodes = this.chunks.get(index - 1).exitNodes;
            }
            chunkData = this.generator.generateChunk(index, prevExitNodes);
            Storage.saveChunk(index, chunkData);
        }

        this.chunks.set(index, chunkData);
        
        // Visualize current chunk and refresh neighbors to ensure smooth seams
        const prevChunk = this.chunks.get(index - 1);
        const nextChunk = this.chunks.get(index + 1);

        this.graphics.addChunkVisuals(chunkData, prevChunk, nextChunk);

        // Update neighbors if they exist
        if (prevChunk) {
            const prevPrev = this.chunks.get(index - 2);
            this.graphics.addChunkVisuals(prevChunk, prevPrev, chunkData);
        }

        if (nextChunk) {
            const nextNext = this.chunks.get(index + 2);
            this.graphics.addChunkVisuals(nextChunk, chunkData, nextNext);
        }
    }

    onPointerDown(event) {
        if (this.isMoving) return;
        if (event.button !== 0) return; // Only Left Click to move
        event.preventDefault();
        
        const node = this.graphics.getIntersectedNode(event.clientX, event.clientY);
        if (node && node.id !== this.currentNode.id) {
            this.attemptMove(node);
        }
    }

    onPointerMove(event) {
        event.preventDefault();

        // If moving, we lock the path visuals to the committed path.
        if (this.isMoving) {
            const node = this.graphics.getIntersectedNode(event.clientX, event.clientY);
            // Only update distance label if hovering over the target we are walking to
            if (node && this.currentNode && node.id === this.currentNode.id && this.graphics.playerMesh) {
                const startPos = this.graphics.playerMesh.position.clone();
                const endPos = this.targetMovePos.clone();
                const distanceMeters = startPos.distanceTo(endPos);
                const distanceKm = (distanceMeters / 1000).toFixed(2);
                this.graphics.setHoverDistanceLabel({
                    startPos,
                    endPos,
                    distanceKm
                });
            } else {
                this.graphics.setHoverDistanceLabel(null);
            }
            // Do NOT update active path or calculate new paths while moving
            return;
        }

        // If we don't have a current node yet, nothing to compare
        if (!this.currentNode) {
            this.graphics.setHoverDistanceLabel(null);
            this.graphics.setActivePath(null);
            return;
        }

        const node = this.graphics.getIntersectedNode(event.clientX, event.clientY);
        if (!node) {
            this.graphics.setHoverDistanceLabel(null);
            this.graphics.setActivePath(null);
            return;
        }

        if (node.id === this.currentNode.id) {
            this.graphics.setHoverDistanceLabel(null);
            this.graphics.setActivePath(null);
            return;
        }

        // Compute shortest path from current node to hovered node
        const path = computeShortestPath(this.chunks, this.currentNode.id, node.id);
        if (!path) {
            this.graphics.setHoverDistanceLabel(null);
            this.graphics.setActivePath(null);
            return;
        }

        // Draw glow along the whole path
        this.graphics.setActivePath(path);

        // Total distance along the path
        let totalMeters = 0;
        for (let i = 0; i < path.length - 1; i++) {
            const a = path[i];
            const b = path[i + 1];
            const va = new THREE.Vector3(a.x, a.y, a.z);
            const vb = new THREE.Vector3(b.x, b.y, b.z);
            totalMeters += va.distanceTo(vb);
        }

        const distanceKm = (totalMeters / 1000).toFixed(2);
        const startPos = new THREE.Vector3(this.currentNode.x, this.currentNode.y, this.currentNode.z);
        const endPos = new THREE.Vector3(node.x, node.y, node.z);

        this.graphics.setHoverDistanceLabel({
            startPos,
            endPos,
            distanceKm
        });
    }

    attemptMove(targetNode) {
        const path = computeShortestPath(this.chunks, this.currentNode.id, targetNode.id);
        if (!path || path.length < 2) return;

        // Queue all steps except the current node
        this.pathQueue = path.slice(1);

        // Show full chosen path glow
        this.graphics.setActivePath(path);

        // Start with first step
        const nextNode = this.pathQueue.shift();
        if (nextNode) {
            this.startMove(nextNode);
        }
    }

    startMove(targetNode) {
        this.isMoving = true;
        this.moveProgress = 0;
        this.moveElapsed = 0;
        this.startMovePos.set(this.currentNode.x, this.currentNode.y, this.currentNode.z);
        this.targetMovePos.set(targetNode.x, targetNode.y, targetNode.z);
        
        // Calculate realistic travel time (Naismith's Rule)
        // 5km/h base speed on flat ground (~1.4 m/s)
        // +1 hour for every 600m of ascent (+6s per meter)
        
        const horizontalDist = Math.hypot(
            this.targetMovePos.x - this.startMovePos.x,
            this.targetMovePos.z - this.startMovePos.z
        );
        const heightDiff = this.targetMovePos.y - this.startMovePos.y;
        
        const baseTime = horizontalDist / 1.4;
        const ascentTime = Math.max(0, heightDiff) * 6.0;
        
        // Real time walking duration
        this.moveDuration = Math.max(0.5, baseTime + ascentTime); 
        
        this.currentNode = targetNode;
        this.score++;
        this.updateScoreUI();
        
        Storage.savePlayerState({
            score: this.score,
            currentNodeId: this.currentNode.id,
            distanceWalkedMeters: this.distanceWalkedMeters,
            distanceSwamMeters: this.distanceSwamMeters
        });
        
        this.checkChunkLoad();
    }
    
    checkChunkLoad() {
        const currentChunkIdx = this.getChunkIndexFromNodeId(this.currentNode.id);
        // Load chunks ahead to support further view distance
        for (let i = 1; i <= 4; i++) {
            this.ensureChunk(currentChunkIdx + i);
        }

        // Ensure back chunks for seams
        this.ensureChunk(currentChunkIdx - 1);
        this.ensureChunk(currentChunkIdx - 2);

        // Prune distant chunks
        // Keep 2 behind, 4 ahead
        this.graphics.pruneChunks(currentChunkIdx - 2, currentChunkIdx + 4);
    }

    updateScoreUI() {
        this.scoreEl.innerText = `Places: ${this.score}`;
        const walkedKm = (this.distanceWalkedMeters / 1000).toFixed(2);
        const swamKm = (this.distanceSwamMeters / 1000).toFixed(2);
        if (this.stepsEl) {
            this.stepsEl.innerText = `Steps: ${walkedKm} km`;
        }
        if (this.swamEl) {
            this.swamEl.innerText = `Swam: ${swamKm} km`;
        }
    }

    animate() {
        requestAnimationFrame(this.animate);

        const delta = this.clock.getDelta();
        
        let logicalPos = new THREE.Vector3();
        const prevPos = this.lastLogicalPos.clone();

        if (this.isMoving) {
            // Time-based movement for consistent walking speed
            this.moveElapsed += delta;
            const t = Math.min(1, this.moveElapsed / this.moveDuration);
            
            if (t >= 1) {
                this.isMoving = false;
                // Snap to exact target coordinates to ensure state matches visuals
                logicalPos.copy(this.targetMovePos);
                
                // Final prune to ensure any remaining dots at this step are cleared
                this.graphics.pruneTrail(this.graphics.playerMesh.position);

                // If more steps are queued, continue automatically
                if (this.pathQueue && this.pathQueue.length > 0) {
                    const nextNode = this.pathQueue.shift();
                    if (nextNode) {
                        this.startMove(nextNode);
                    }
                } else {
                    // No more steps, clear active path glow
                    this.graphics.setActivePath(null);
                }
            } else {
                // Linear interpolation allows visual position to match logical progress 1:1
                logicalPos.lerpVectors(this.startMovePos, this.targetMovePos, t);
                this.graphics.pruneTrail(logicalPos);
            }
        } else {
            // Not moving, stay at current node
             if (this.currentNode) {
                 logicalPos.set(this.currentNode.x, this.currentNode.y, this.currentNode.z);
             } else {
                 logicalPos.copy(this.graphics.playerMesh.position);
             }
        }
        
        // Per-frame distance accumulation for real-time steps display
        const frameDist = logicalPos.distanceTo(prevPos);
        // Update player visuals and get whether we are swimming this frame
        const isSwimming = this.graphics.updatePlayerPosition(logicalPos);
        
        if (frameDist > 0) {
            if (isSwimming) {
                this.distanceSwamMeters += frameDist;
            } else {
                this.distanceWalkedMeters += frameDist;
            }
            this.updateScoreUI();
        }
        this.lastLogicalPos.copy(logicalPos);
        
        const camTarget = this.graphics.playerMesh.position;
        this.graphics.updateCamera(camTarget);
        this.graphics.render();
    }

    reset() {
        if(confirm("Reset progress?")) {
            Storage.clearAll();
            location.reload();
        }
    }
}