import * as THREE from 'three';

export class WaterRippleSystem {
    constructor(size = 128, areaSize = 60.0) {
        this.size = size;
        this.areaSize = areaSize;
        this.damping = 0.96;
        
        // Double buffering for wave propagation
        this.bufferCurrent = new Float32Array(size * size);
        this.bufferPrevious = new Float32Array(size * size);
        
        // Texture for the shader
        this.texture = new THREE.DataTexture(
            new Float32Array(size * size * 4),
            size,
            size,
            THREE.RGBAFormat,
            THREE.FloatType
        );
        this.texture.wrapS = THREE.RepeatWrapping;
        this.texture.wrapT = THREE.RepeatWrapping;
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.magFilter = THREE.LinearFilter;
        this.texture.needsUpdate = true;
    }

    update() {
        const size = this.size;
        // Swap buffers logic: 
        // We calculate new values into 'bufferCurrent' based on 'bufferPrevious'
        // But conceptually in the algorithm: new_height = (neighbors - current_height) * damping
        // where 'neighbors' come from the previous frame, and 'current_height' is from 2 frames ago.
        
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const idx = y * size + x;
                
                // Wrapping coordinates
                const xm = (x - 1 + size) % size;
                const xp = (x + 1) % size;
                const ym = (y - 1 + size) % size;
                const yp = (y + 1) % size;

                const n1 = this.bufferPrevious[y * size + xm];
                const n2 = this.bufferPrevious[y * size + xp];
                const n3 = this.bufferPrevious[ym * size + x];
                const n4 = this.bufferPrevious[yp * size + x];

                // Wave equation
                let val = (n1 + n2 + n3 + n4) / 2.0 - this.bufferCurrent[idx];
                val *= this.damping;
                
                // Clamp to prevent overflow instabilities
                if (val > 5.0) val = 5.0;
                if (val < -5.0) val = -5.0;
                
                this.bufferCurrent[idx] = val;
            }
        }

        // Swap buffers
        const temp = this.bufferPrevious;
        this.bufferPrevious = this.bufferCurrent;
        this.bufferCurrent = temp;

        // Update texture from the latest state (now in bufferPrevious)
        const data = this.texture.image.data;
        for (let i = 0; i < size * size; i++) {
            const h = this.bufferPrevious[i];
            data[i * 4] = h;       // R: Height
            data[i * 4 + 1] = 0;
            data[i * 4 + 2] = 0;
            data[i * 4 + 3] = 1.0;
        }
        
        this.texture.needsUpdate = true;
    }

    addDisturbance(worldX, worldZ, strength) {
        // Map world coords to grid coords (wrapping)
        const u = worldX / this.areaSize;
        const v = worldZ / this.areaSize;
        
        const uFrac = u - Math.floor(u);
        const vFrac = v - Math.floor(v);
        
        const cx = Math.floor(uFrac * this.size);
        const cy = Math.floor(vFrac * this.size);
        
        const radius = 3;
        const radiusSq = radius * radius;
        
        for(let dy = -radius; dy <= radius; dy++) {
            for(let dx = -radius; dx <= radius; dx++) {
                if (dx*dx + dy*dy <= radiusSq) {
                    const x = (cx + dx + this.size) % this.size;
                    const y = (cy + dy + this.size) % this.size;
                    
                    // Add to bufferPrevious so it propagates next update
                    this.bufferPrevious[y * this.size + x] += strength;
                }
            }
        }
    }
}