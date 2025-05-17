/**
 * o1-Unifies-TrapSystem-Clean.js
 * 
 * A cleaned-up version of the unified Trap & Interaction system for the Roll20 API.
 * 
 * This script manages trap detection, trigger systems, and an interaction menu. It supports:
 * - Precise grid-based movement and positioning.
 * - Overlap detection for triggering traps.
 * - Armed/disarmed states with visual indicators.
 * - A robust interaction menu system, allowing for success/failure macros.
 * - Support for advantage/disadvantage skill checks and further expansions.
 *
 * Note: The structure & many method signatures remain intact (to preserve Roll20 compatibility),
 * but extraneous logs and truly unused code have been removed or consolidated.
 */

// ---------------------------------------------------
// A) Helper: Determine if player is GM
// ---------------------------------------------------
const playerIsGM = function(playerId) {
    const player = getObj("player", playerId);
    if (!player) return false;
    return player.get("_online") && player.get("_type") === "player" && player.get("_isGM");
};

// ---------------------------------------------------
// B) Main TrapSystem
// ---------------------------------------------------
const TrapSystem = {

    //----------------------------------------------------------------------
    // 1) CONFIG & STATE
    //----------------------------------------------------------------------
    config: {
        DEBUG: true,
        TEST_TRAP: {
            notes: "{!traptrigger uses: 1/1 macro: #TEST_MACRO effects: []}",
            uses: 1,
            maxUses: 1,
            macroName: "TEST_MACRO"
        },
        DEFAULT_GRID_SIZE: 70,
        DEFAULT_SCALE: 5,
        MIN_MOVEMENT_FACTOR: 0.2,
        AURA_SIZE: 2,
        AURA_COLORS: {
            ARMED: "#00ff00",    // Green
            DISARMED: "#ff0000", // Red
            PAUSED: "#ffa500"    // Orange
        },
        // Skill icons
        SKILL_TYPES: {
            "Flat Roll": "🎲",
            "Acrobatics": "🤸",
            "Animal Handling": "🐎",
            "Arcana": "✨",
            "Athletics": "💪",
            "Deception": "🎭",
            "History": "📚",
            "Insight": "👁️",
            "Intimidation": "😠",
            "Investigation": "🔍",
            "Medicine": "⚕️",
            "Nature": "🌿",
            "Perception": "👀",
            "Performance": "🎪",
            "Persuasion": "💬",
            "Religion": "⛪",
            "Sleight of Hand": "🎯",
            "Stealth": "👥",
            "Survival": "🏕️"
        }
    },

    state: {
        lockedTokens: {},         // Movement-locked tokens
        testTrapTokens: new Set(),// If using test traps
        safeMoveTokens: new Set(),// Tokens that get a free move after unlocking
        triggersEnabled: true,    // Global on/off
        originalMacros: {},       // If you had any macro backups

        // From InteractionMenu:
        activeInteractions: {},   // Not used heavily, but included
        pendingChecks: {},        // For advantage/disadv checks
        pendingChecksByChar: {},   // New: Lookup by character ID
        displayDCForCheck: {}, // key: playerid, value: true/false
    },

    //----------------------------------------------------------------------
    // 2) UTILS
    //----------------------------------------------------------------------
    utils: {
        // Unified log helper
        log(message, type='info') {
            if (!TrapSystem.config.DEBUG && type === 'debug') return;
            const prefix = {
                info: '📜',
                error: '❌',
                success: '✅',
                warning: '⚠️',
                debug: '🔍'
            }[type] || '📜';
            log(`${prefix} TrapSystem: ${message}`);
        },

        // GM whisper
        chat(message) {
            if (typeof message !== 'string') {
                this.log('Error: Invalid message type', 'error');
                return;
            }
            sendChat('TrapSystem', `/w gm ${message}`);
        },

        // Execute a macro by name
        executeMacro(macroName) {
            try {
                const macro = findObjs({ _type:"macro", name: macroName })[0];
                if (!macro) {
                    this.log(`Macro not found: ${macroName}`, 'error');
                    return false;
                }
                const action = macro.get("action");
                if (!action) {
                    this.log(`Macro has no action: ${macroName}`, 'error');
                    return false;
                }
                const lines = action.split('\n').filter(l => l.trim());
                lines.forEach(cmd => sendChat("TrapSystem", cmd.trim()));
                return true;
            } catch(err) {
                this.log(`Error executing macro: ${err}`, 'error');
                return false;
            }
        },

        // Check if token is a trap
        isTrap(token) {
            if (!token) return false;
            if (TrapSystem.state.testTrapTokens.has(token.id)) return true; // Quick test for test tokens
            const notes = token.get("gmnotes");
            if (!notes) return false;
            let decoded;
            try { 
                decoded = decodeURIComponent(notes); 
            } catch(e) { 
                decoded = notes; 
            }
            return decoded.includes("!traptrigger");
        },

        // Get page settings with fallback
        getPageSettings(pageId) {
            const page = getObj("page", pageId);
            if (!page) {
                this.log("Page not found, using defaults", 'warning');
                return {
                    gridSize: TrapSystem.config.DEFAULT_GRID_SIZE,
                    scale: TrapSystem.config.DEFAULT_SCALE,
                    gridType: "square",
                    valid: false
                };
            }
            let gridSize = page.get("snapping_increment");
            if(!gridSize || gridSize < 2) {
                gridSize = TrapSystem.config.DEFAULT_GRID_SIZE;
                this.log(`Invalid grid size; using default ${gridSize}`, 'warning');
            }
            return {
                gridSize,
                scale: page.get("scale_number") || TrapSystem.config.DEFAULT_SCALE,
                gridType: page.get("grid_type"),
                valid: true
            };
        },

        // Return bounding and grid info
        getTokenGridCoords(token) {
            if(!token) return null;
            const ps = this.getPageSettings(token.get("_pageid"));
            const g = ps.gridSize;
            const left = token.get("left");
            const top  = token.get("top");
            const w    = token.get("width");
            const h    = token.get("height");
            const gridX = Math.round((left - w/2) / g);
            const gridY = Math.round((top - h/2) / g);
            return {
                x: gridX,
                y: gridY,
                width: Math.ceil(w/g),
                height: Math.ceil(h/g),
                gridSize: g,
                scale: ps.scale,
                gridType: ps.gridType,
                pixelX: left,
                pixelY: top,
                tokenWidth: w,
                tokenHeight: h
            };
        },

        // Overlap check
        checkGridOverlap(t1, t2) {
            const c1 = this.getTokenGridCoords(t1);
            const c2 = this.getTokenGridCoords(t2);
            if(!c1 || !c2) return false;

            const b1 = {
                left: c1.pixelX - c1.tokenWidth/2,
                right: c1.pixelX + c1.tokenWidth/2,
                top: c1.pixelY - c1.tokenHeight/2,
                bottom: c1.pixelY + c1.tokenHeight/2,
                w: c1.tokenWidth,
                h: c1.tokenHeight
            };
            const b2 = {
                left: c2.pixelX - c2.tokenWidth/2,
                right: c2.pixelX + c2.tokenWidth/2,
                top: c2.pixelY - c2.tokenHeight/2,
                bottom: c2.pixelY + c2.tokenHeight/2,
                w: c2.tokenWidth,
                h: c2.tokenHeight
            };
            const xO = Math.max(0, Math.min(b1.right, b2.right) - Math.max(b1.left, b2.left));
            const yO = Math.max(0, Math.min(b1.bottom, b2.bottom) - Math.max(b1.top, b2.top));
            const overlapArea = xO * yO;
            const area1 = b1.w * b1.h;
            const overlapPct = (overlapArea / area1) * 100;
            this.log(`Overlap: ${overlapPct.toFixed(2)}%`, 'debug');
            return overlapPct >= 5;
        },

        // Check if movement path crosses trap
        checkLineIntersection(startX, startY, endX, endY, trapToken) {
            const coords = this.getTokenGridCoords(trapToken);
            if(!coords) return false;
            const bounds = {
                left: coords.pixelX - coords.tokenWidth/2,
                right: coords.pixelX + coords.tokenWidth/2,
                top: coords.pixelY - coords.tokenHeight/2,
                bottom: coords.pixelY + coords.tokenHeight/2
            };
            const dx = endX - startX;
            const dy = endY - startY;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if(dist < coords.gridSize * TrapSystem.config.MIN_MOVEMENT_FACTOR) return false;

            const margin = Math.min(coords.tokenWidth, coords.tokenHeight) * 0.05;
            const isInside = (x,y) => 
                x >= bounds.left - margin && x <= bounds.right + margin &&
                y >= bounds.top  - margin && y <= bounds.bottom + margin;

            // If start or end is inside
            if(isInside(startX,startY)) return {x: startX, y: startY};
            if(isInside(endX,endY))     return {x: endX, y: endY};

            // Check trap edges
            const lines = [
                { x1: bounds.left - margin,  y1: bounds.top - margin,     x2: bounds.right + margin, y2: bounds.top - margin },
                { x1: bounds.right + margin, y1: bounds.top - margin,     x2: bounds.right + margin, y2: bounds.bottom + margin },
                { x1: bounds.right + margin, y1: bounds.bottom + margin,  x2: bounds.left - margin,  y2: bounds.bottom + margin },
                { x1: bounds.left - margin,  y1: bounds.bottom + margin,  x2: bounds.left - margin,  y2: bounds.top - margin }
            ];
            let intersections = [];
            for(let ln of lines) {
                let i = this.lineIntersection(
                    startX, startY, endX, endY,
                    ln.x1, ln.y1, ln.x2, ln.y2
                );
                if(i) intersections.push(i);
            }
            if(!intersections.length) return false;
            // Return intersection closest to start
            return intersections.reduce((closest,cur) => {
                const dc = Math.sqrt((closest.x - startX)**2 + (closest.y - startY)**2);
                const di = Math.sqrt((cur.x - startX)**2 + (cur.y - startY)**2);
                return di < dc ? cur : closest;
            }, intersections[0]);
        },
        lineIntersection(x1,y1,x2,y2,x3,y3,x4,y4) {
            const denom = (x1 - x2)*(y3 - y4) - (y1 - y2)*(x3 - x4);
            if(!denom) return null;
            const t = ((x1 - x3)*(y3 - y4) - (y1 - y3)*(x3 - x4)) / denom;
            const u = -((x1 - x2)*(y1 - y3) - (y1 - y2)*(x1 - x3)) / denom;
            if(t >= 0 && t <= 1 && u >= 0 && u <= 1) {
                return { x: x1 + t*(x2 - x1), y: y1 + t*(y2 - y1) };
            }
            return null;
        },

        // Center of a token
        getTokenCenter(token) {
            return { x: token.get("left"), y: token.get("top") };
        },

        // Read trap info from GM notes
        parseTrapNotes(notes, token=null) {
            if(!notes) {
                this.log('GM notes empty','warning');
                return null;
            }
            let decoded = notes;
            try{ 
                decoded = decodeURIComponent(notes); 
            } catch(e){ /* ignore */ }

            decoded = decoded
                .replace(/&amp;/g,'&')
                .replace(/&lt;/g,'<')
                .replace(/&gt;/g,'>')
                .replace(/&quot;/g,'"')
                .replace(/&#39;/g,"'");

            if(!decoded.includes("!traptrigger")) {
                this.log('No "!traptrigger" found in notes','debug');
                return null;
            }

            // Extract usage
            let currentUses = 0, maxUses = 0, isArmed = true;
            let usesM = decoded.match(/uses:\s*(\d+)\/(\d+)/);
            if(usesM) {
                currentUses = parseInt(usesM[1],10);
                maxUses = parseInt(usesM[2],10);
            }
            let armedM = decoded.match(/armed:\s*(on|off)/i);
            if(armedM) isArmed = armedM[1].toLowerCase() === 'on';

            // Primary macro
            let pName = "Primary", pMacro = "";
            let pMatch = decoded.match(/primary:\s*Name:\s*"([^"]+)"\s*Macro:\s*([^\s\]]+)/);
            if(pMatch) { 
                pName  = pMatch[1];
                pMacro = pMatch[2];
            }

            // Options
            let options = [];
            let optMatch = decoded.match(/options:\s*\[([^\]]+)\]/);
            if(optMatch) {
                let list = optMatch[1].match(/Name:\s*"([^"]+)"\s*Macro:\s*([^\s]+)/g);
                if(list) {
                    list.forEach(line => {
                        let m=line.match(/Name:\s*"([^"]+)"\s*Macro:\s*([^\s]+)/);
                        if(m) options.push({ name:m[1], macro:m[2] });
                    });
                }
            }

            // Position
            let position = null;
            let posM = decoded.match(/position:\s*(?:center|\(\s*(\d+)\s*,\s*(\d+)\s*\))/i);
            if(posM) {
                if(posM[0].includes('center')) position = "center";
                else if(posM[1] && posM[2]) {
                    position = { x: parseInt(posM[1],10), y: parseInt(posM[2],10) };
                }
            }

            // Type
            let trapType = "standard";
            let typeM = decoded.match(/type:\s*(\w+)/i);
            if(typeM) trapType = typeM[1].toLowerCase();

            // Checks array
            let checks = [];
            let checksM = decoded.match(/checks:\s*"([^"]+)"/);
            if(checksM) {
                let str = checksM[1].trim();
                str.split(',').forEach(ch => {
                    let [skill,dc] = ch.split(':').map(s => s.trim());
                    if(skill && dc) {
                        checks.push({ type: skill, dc: parseInt(dc,10) });
                    }
                });
            }

            // success/failure macros
            let successMacro = null, failureMacro = null;
            let succM = decoded.match(/success:\s*(\w+)/);
            if(succM) successMacro = succM[1];
            let failM = decoded.match(/failure:\s*(\w+)/);
            if(failM) failureMacro = failM[1];

            // New: Check for noMovementTrigger tag
            let movementTriggerEnabled = !decoded.includes("{noMovementTrigger}");

            // Sync aura color if we have a token
            if(token) {
                let auraCol = TrapSystem.config.AURA_COLORS.DISARMED;
                if(isArmed && currentUses > 0) {
                    auraCol = TrapSystem.state.triggersEnabled
                        ? TrapSystem.config.AURA_COLORS.ARMED
                        : TrapSystem.config.AURA_COLORS.PAUSED;
                }
                token.set({
                    aura1_color: auraCol,
                    aura1_radius: TrapSystem.config.AURA_SIZE,
                    showplayers_aura1: false
                });
            }

            return {
                currentUses, maxUses, isArmed,
                primary: { name: pName, macro: pMacro },
                options, position,
                type: trapType,
                checks, success: successMacro, failure: failureMacro,
                movementTriggerEnabled // New field
            };
        },

        // Update GM notes for trap uses + armed state
        updateTrapUses(token, current, max, newArmed=null) {
            try {
                const notes = token.get("gmnotes");
                if (!notes) {
                    this.log('Cannot update uses: GM notes are empty', 'error');
                    return;
                }

                let decodedNotes = notes;
                try {
                    decodedNotes = decodeURIComponent(notes);
                } catch (e) {
                    this.log(`URI decode failed in updateTrapUses: ${e.message}`, 'warning');
                }

                let updated = decodedNotes.replace(
                    /uses:\s*\d+\/\d+/,
                    `uses: ${current}/${max}`
                );

                // Update armed state if provided
                if (newArmed !== null) {
                    const armedState = newArmed ? 'on' : 'off';
                    if (updated.includes('armed:')) {
                        updated = updated.replace(/armed:\s*(on|off)/i, `armed: ${armedState}`);
                    } else {
                        // Add armed state before the closing brace
                        updated = updated.replace(/\}$/, ` armed: ${armedState}}`);
                    }
                }

                // Update GM notes
                token.set("gmnotes", updated);

                // Update bar1 to reflect uses
                token.set({
                    bar1_value: current,
                    bar1_max: max,
                    showplayers_bar1: false
                });

                // Update aura color
                const isArmed = newArmed !== null ? newArmed : updated.includes('armed: on');
                token.set({
                    aura1_color: isArmed && current > 0 
                        ? (TrapSystem.state.triggersEnabled 
                            ? TrapSystem.config.AURA_COLORS.ARMED 
                            : TrapSystem.config.AURA_COLORS.PAUSED) 
                        : TrapSystem.config.AURA_COLORS.DISARMED,
                    aura1_radius: TrapSystem.config.AURA_SIZE,
                    showplayers_aura1: false
                });

                this.log(`Updated trap state - Uses: ${current}/${max}, Armed: ${isArmed ? 'on' : 'off'}`, 'info');
            } catch (err) {
                this.log(`Error updating trap uses: ${err.message}`, 'error');
            }
        },

        // Checking if token is ignoring traps
        isTrapImmune(token) {
            if(!token) return false;
            const hasMarker = token.get("statusmarkers")?.includes("blue") || false;
            const n = token.get("gmnotes") || "";
            const hasTag = n.includes("{ignoretraps}");
            return (hasMarker && hasTag);
        },

        // Toggle ignore traps
        toggleIgnoreTraps(token) {
            if(!token) {
                this.log('No token selected for toggling ignore traps');
                return;
            }
            let notes = token.get("gmnotes") || "";
            let dec = notes;
            try { dec = decodeURIComponent(notes);} catch(e) {}
            let updated;
            if(dec.includes("{ignoretraps}")) {
                updated = dec.replace(/\{ignoretraps\}/, '');
                this.chat(`Removed ignore traps tag from ${token.get("name") || "token"}`);
            } else {
                updated = dec + " {ignoretraps}";
                this.chat(`Added ignore traps tag to ${token.get("name") || "token"}`);
            }
            token.set("gmnotes", updated);

            const curMarkers = token.get("statusmarkers") || "";
            const hasM = curMarkers.includes("blue");
            if(hasM) {
                token.set("statusmarkers", curMarkers.replace("blue",""));
            } else {
                token.set("statusmarkers", curMarkers + "blue");
            }
        },

        // Parsing locked token notes
        parseTokenNotes(notes) {
            if(!notes) return null;
            let dec = notes;
            try { dec = decodeURIComponent(notes); } catch(e) {}
            const m = dec.match(/\{!traplocked\s*trap:\s*([^\s}]+)/);
            if(!m) return null;
            return { trapId: m[1], isLocked: true };
        },
        updateTokenLockState(token, trapId, locked) {
            if(!token) return;
            let notes = token.get("gmnotes") || "";
            let dec = notes;
            try { dec = decodeURIComponent(notes); } catch(e) {}
            let upd;
            if(locked) {
                if(dec.includes('!traplocked')) {
                    upd = dec.replace(/\{!traplocked[^}]*\}/, `{!traplocked trap: ${trapId}}`);
                } else {
                    upd = dec + `{!traplocked trap: ${trapId}}`;
                }
            } else {
                upd = dec.replace(/\{!traplocked[^}]*\}/, '');
            }
            token.set("gmnotes", upd);
            this.log(`Token lock updated => trap:${trapId}, locked:${locked}`, 'info');
        },

        // For "intersection" style movement
        calculateTrapPosition(movedToken, trapToken, intersection) {
            const trapCoords = this.getTokenGridCoords(trapToken);
            if (!trapCoords) {
                this.log("calculateTrapPosition: Trap coordinates not found.", "warning");
                return { initial: intersection, final: intersection }; 
            }
            const currentGridSize = trapCoords.gridSize;
            const initialPos = { x: intersection.x, y: intersection.y };
            let finalPos = { ...initialPos }; 

            const trapData = this.parseTrapNotes(trapToken.get("gmnotes"), trapToken);

            const getOccupiedPixelPositions = () => {
                return Object.entries(TrapSystem.state.lockedTokens)
                    .filter(([id, v]) => v.trapToken === trapToken.id && id !== movedToken.id)
                    .map(([id, _]) => {
                        const t = getObj("graphic", id);
                        return t ? { x: t.get("left"), y: t.get("top") } : null;
                    })
                    .filter(Boolean);
            };
            
            const isPixelPosOccupied = (candidatePixelX, candidatePixelY, occupiedList) => {
                return occupiedList.some(o => {
                    const dx = o.x - candidatePixelX;
                    const dy = o.y - candidatePixelY;
                    return Math.sqrt(dx * dx + dy * dy) < (currentGridSize * 0.5); 
                });
            };

            // Helper for intersection-based placement with simple adjacent check for overlap
            const handleIntersectionFallbackPlacement = (baseIntersection, tc, occupiedList) => {
                // Determine the target relative cell from the intersection point, relative to the trap's top-left grid cell
                const relXFromIntersection = Math.floor((baseIntersection.x - (tc.x * currentGridSize)) / currentGridSize);
                const relYFromIntersection = Math.floor((baseIntersection.y - (tc.y * currentGridSize)) / currentGridSize);
                
                let targetRelCellX = Math.min(Math.max(0, relXFromIntersection), tc.width - 1);
                let targetRelCellY = Math.min(Math.max(0, relYFromIntersection), tc.height - 1);

                let primaryTargetPixelX = (tc.x + targetRelCellX) * currentGridSize + currentGridSize / 2;
                let primaryTargetPixelY = (tc.y + targetRelCellY) * currentGridSize + currentGridSize / 2;
                let newFinalPos = { x: primaryTargetPixelX, y: primaryTargetPixelY };

                if (isPixelPosOccupied(primaryTargetPixelX, primaryTargetPixelY, occupiedList)) {
                    const adjacentOffsets = [
                        { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, 
                        { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
                        { dx: 1, dy: 1 }, { dx: -1, dy: -1 },
                        { dx: 1, dy: -1 }, { dx: -1, dy: 1 }
                    ];

                    for (const offset of adjacentOffsets) {
                        const checkRelCellX = targetRelCellX + offset.dx;
                        const checkRelCellY = targetRelCellY + offset.dy;

                        if (checkRelCellX >= 0 && checkRelCellX < tc.width &&
                            checkRelCellY >= 0 && checkRelCellY < tc.height) {
                            
                            const candidatePixelX = (tc.x + checkRelCellX) * currentGridSize + currentGridSize / 2;
                            const candidatePixelY = (tc.y + checkRelCellY) * currentGridSize + currentGridSize / 2;

                            if (!isPixelPosOccupied(candidatePixelX, candidatePixelY, occupiedList)) {
                                newFinalPos = { x: candidatePixelX, y: candidatePixelY };
                                break; 
                            }
                        }
                    }
                }
                return newFinalPos;
            };

            if (trapData && trapData.position) {
                const occupiedPixelPosList = getOccupiedPixelPositions();

                if (trapData.position === 'center') {
                    const trapTokenCenterX = trapToken.get("left");
                    const trapTokenCenterY = trapToken.get("top");
                    const trapCenterCellCol = Math.round(trapTokenCenterX / currentGridSize - 0.5);
                    const trapCenterCellRow = Math.round(trapTokenCenterY / currentGridSize - 0.5);
                    
                    let foundUnoccupiedCell = false;
                    let targetPixelX = trapCenterCellCol * currentGridSize + currentGridSize / 2;
                    let targetPixelY = trapCenterCellRow * currentGridSize + currentGridSize / 2;

                    if (!isPixelPosOccupied(targetPixelX, targetPixelY, occupiedPixelPosList)) {
                        finalPos = { x: targetPixelX, y: targetPixelY };
                        foundUnoccupiedCell = true;
                    } else {
                        const MAX_SEARCH_RINGS_GLOBAL = 5; 
                        for (let ringNum = 1; ringNum <= MAX_SEARCH_RINGS_GLOBAL && !foundUnoccupiedCell; ringNum++) {
                            for (let dCol = -ringNum; dCol <= ringNum && !foundUnoccupiedCell; dCol++) {
                                for (let dRow = -ringNum; dRow <= ringNum && !foundUnoccupiedCell; dRow++) {
                                    if (Math.abs(dCol) !== ringNum && Math.abs(dRow) !== ringNum) continue;
                                    const checkCellCol = trapCenterCellCol + dCol;
                                    const checkCellRow = trapCenterCellRow + dRow;
                                    targetPixelX = checkCellCol * currentGridSize + currentGridSize / 2;
                                    targetPixelY = checkCellRow * currentGridSize + currentGridSize / 2;
                                    if (!isPixelPosOccupied(targetPixelX, targetPixelY, occupiedPixelPosList)) {
                                        finalPos = { x: targetPixelX, y: targetPixelY };
                                        foundUnoccupiedCell = true;
                                    }
                                }
                            }
                        }
                        if (!foundUnoccupiedCell) { 
                           finalPos = { x: trapCenterCellCol * currentGridSize + currentGridSize / 2, y: trapCenterCellRow * currentGridSize + currentGridSize / 2 };
                        }
                    }
                } else if (typeof trapData.position === 'object' && 
                           trapData.position.x !== undefined && 
                           trapData.position.y !== undefined) {
                    const targetRelCellX = Math.min(Math.max(0, trapData.position.x), trapCoords.width - 1);
                    const targetRelCellY = Math.min(Math.max(0, trapData.position.y), trapCoords.height - 1);
                    let initialTargetPixelX = (trapCoords.x + targetRelCellX) * currentGridSize + currentGridSize / 2;
                    let initialTargetPixelY = (trapCoords.y + targetRelCellY) * currentGridSize + currentGridSize / 2;
                    finalPos = { x: initialTargetPixelX, y: initialTargetPixelY };
                    let foundUnoccupiedCellInTrap = false;
                    if (!isPixelPosOccupied(initialTargetPixelX, initialTargetPixelY, occupiedPixelPosList)) {
                        foundUnoccupiedCellInTrap = true;
                    } else {
                        const maxSearchDepth = Math.max(trapCoords.width, trapCoords.height);
                        for (let depth = 1; depth <= maxSearchDepth && !foundUnoccupiedCellInTrap; depth++) {
                            for (let dx = -depth; dx <= depth && !foundUnoccupiedCellInTrap; dx++) {
                                for (let dy = -depth; dy <= depth && !foundUnoccupiedCellInTrap; dy++) {
                                    if (Math.abs(dx) !== depth && Math.abs(dy) !== depth) continue; 
                                    const checkRelCellX = targetRelCellX + dx;
                                    const checkRelCellY = targetRelCellY + dy;
                                    if (checkRelCellX >= 0 && checkRelCellX < trapCoords.width &&
                                        checkRelCellY >= 0 && checkRelCellY < trapCoords.height) {
                                        let candidatePixelX = (trapCoords.x + checkRelCellX) * currentGridSize + currentGridSize / 2;
                                        let candidatePixelY = (trapCoords.y + checkRelCellY) * currentGridSize + currentGridSize / 2;
                                        if (!isPixelPosOccupied(candidatePixelX, candidatePixelY, occupiedPixelPosList)) {
                                            finalPos = { x: candidatePixelX, y: candidatePixelY };
                                            foundUnoccupiedCellInTrap = true;
                                        }
                                    }
                                }
                            }
                        }
                         if (!foundUnoccupiedCellInTrap) { 
                            finalPos = { x: initialTargetPixelX, y: initialTargetPixelY };
                        }
                    }
                } else {
                    // Fallback for unrecognized trapData.position format
                    finalPos = handleIntersectionFallbackPlacement(intersection, trapCoords, occupiedPixelPosList);
                }
            } else {
                // Fallback if NO trapData.position defined
                const occupiedPixelPosList = getOccupiedPixelPositions(); 
                finalPos = handleIntersectionFallbackPlacement(intersection, trapCoords, occupiedPixelPosList);
            }

            this.log(`calculateTrapPosition: initial=(${initialPos.x.toFixed(2)},${initialPos.y.toFixed(2)}), final=(${finalPos.x.toFixed(2)},${finalPos.y.toFixed(2)})`, 'debug');
            return { initial: initialPos, final: finalPos };
        },

        whisper(playerId, message) {
            if (!playerId || !message) return;
            sendChat('TrapSystem', `/w ${playerId} ${message}`);
        },
        whisperTo(token, message) {
            if (!token) return;
            sendChat("TrapSystem", `/w ${token.id} ${message}`);
        },
        whisperGM(message) {
            sendChat("TrapSystem", `/w GM ${message}`);
        },
        // [TAG: HELP_MENU_UTIL]
        showHelpMenu: function(target = 'API') {
            const helpMenu = [
                '&{template:default}',
                '{{name=🎯 Trap System Help}}',
                '{{About=The Trap System allows you to create and manage traps, skill checks, and interactions. Traps can be triggered by movement or manually.}}',
                '{{Setup Traps=',
                '[🎯 Setup Standard Trap](!trapsystem setup ?{Uses|1} ?{Main Macro} ?{Optional Macro 2|None} ?{Optional Macro 3|None} ?{Movement|Intersection|Center|Grid})',
                '[🔍 Setup Interaction Trap](!trapsystem setupinteraction ?{Uses|1} ?{Success Macro} ?{Failure Macro} ?{First Check Type|Flat Roll|Acrobatics|Animal Handling|Arcana|Athletics|Deception|History|Insight|Intimidation|Investigation|Medicine|Nature|Perception|Performance|Persuasion|Religion|Sleight of Hand|Stealth|Survival} ?{First Check DC|10} ?{Second Check Type|None|Flat Roll|Acrobatics|Animal Handling|Arcana|Athletics|Deception|History|Insight|Intimidation|Investigation|Medicine|Nature|Perception|Performance|Persuasion|Religion|Sleight of Hand|Stealth|Survival} ?{Second Check DC|10} ?{Movement Trigger Enabled|true|false})}}',
                '{{Trap Control=',
                '[🔄 Toggle](!trapsystem toggle) - Toggle selected trap on/off\n',
                '[⚡ Trigger](!trapsystem trigger) - Manually trigger selected trap\n',
                '[🎯 Show Menu](!trapsystem showmenu) - Show the interaction menu\n',
                '[🚶‍♂️ Allow Movement](!trapsystem allowmovement selected) - Allow single token movement\n',
                '[📊 Status](!trapsystem status) - Show trap status}}',
                '{{System Control=',
                '[✅ Enable](!trapsystem enable) - Enable triggers (does not unlock tokens)\n',
                '[❌ Disable](!trapsystem disable) - Disable triggers (does not unlock tokens)\n',
                '[👥 Allow All](!trapsystem allowall) - Allow movement for all locked tokens\n',
                '[🛡️ Toggle Immunity](!trapsystem ignoretraps) - Toggle token to ignore traps}}',
                '{{Tips=',
                '• Select a token before using most commands\n',
                '• Use the interaction menu for detailed trap control\n',
                '• Movement triggers can be disabled for interaction traps\n',
                '• Skill checks support advantage/disadvantage\n',
                '• Traps can have multiple uses before disarming}}'
            ].join(' ');
            sendChat(target, `/w GM ${helpMenu}`);
        }
    },

    //----------------------------------------------------------------------
    // 3) DETECTION: movement-based triggers
    //----------------------------------------------------------------------
    detector: {
        checkTrapTrigger(movedToken, prevX, prevY) {
            if(!movedToken) return;
            if(!TrapSystem.state.triggersEnabled) {
                TrapSystem.utils.log('Triggers disabled','debug');
                return;
            }
            // Ignore if the moved token itself is a trap
            if(TrapSystem.utils.isTrap(movedToken)) {
                TrapSystem.utils.log('Ignoring movement of trap token','debug');
                return;
            }
            // Must be in objects layer
            if(movedToken.get("layer") !== "objects") {
                TrapSystem.utils.log('Not in token layer','debug');
                return;
            }
            // If token is trap-immune
            if(TrapSystem.utils.isTrapImmune(movedToken)) {
                TrapSystem.utils.log('Token is immune to traps','debug');
                return;
            }
            // If safe move token, skip
            if(TrapSystem.state.safeMoveTokens.has(movedToken.id)) {
                TrapSystem.state.safeMoveTokens.delete(movedToken.id);
                return;
            }
            // Check movement distance
            const ps = TrapSystem.utils.getPageSettings(movedToken.get("_pageid"));
            const dx = movedToken.get("left") - prevX;
            const dy = movedToken.get("top")  - prevY;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if(dist < ps.gridSize*TrapSystem.config.MIN_MOVEMENT_FACTOR) {
                TrapSystem.utils.log(`Movement too small (${dist}px)`, 'debug');
                return;
            }

            // Find traps on page
            const pageTokens = findObjs({ _type:"graphic", _pageid:movedToken.get("_pageid") });
            const trapTokens = pageTokens.filter(t => TrapSystem.utils.isTrap(t));

            // For each trap, see if line or overlap triggers
            for(let trapToken of trapTokens) {
                const data = TrapSystem.utils.parseTrapNotes(trapToken.get("gmnotes"), trapToken);
                if(!data || data.currentUses <= 0 
                   || trapToken.get("aura1_color") !== TrapSystem.config.AURA_COLORS.ARMED) {
                    continue;
                }

                // New: Check if movement trigger is disabled for this interaction trap
                if (data.type === "interaction" && data.movementTriggerEnabled === false) {
                    TrapSystem.utils.log(`Movement trigger disabled for interaction trap: ${trapToken.id}`, 'debug');
                    continue; // Skip movement checks for this trap
                }

                // Check path intersection
                if(prevX !== undefined && prevY !== undefined) {
                    const i = TrapSystem.utils.checkLineIntersection(
                        prevX, prevY,
                        movedToken.get("left"), movedToken.get("top"),
                        trapToken
                    );
                    if(i) {
                        const pos = TrapSystem.utils.calculateTrapPosition(movedToken, trapToken, i);
                        movedToken.set({ left:pos.initial.x, top:pos.initial.y });
                        setTimeout(() => {
                            movedToken.set({ left:pos.final.x, top:pos.final.y });
                        }, 500);
                        TrapSystem.triggers.handleTrapTrigger(movedToken, trapToken);
                        return;
                    }
                }
                // Direct overlap
                if(TrapSystem.utils.checkGridOverlap(movedToken, trapToken)) {
                    const pos = TrapSystem.utils.calculateTrapPosition(
                        movedToken, trapToken,
                        TrapSystem.utils.getTokenCenter(movedToken)
                    );
                    movedToken.set({ left:pos.initial.x, top:pos.initial.y });
                    setTimeout(() => {
                        movedToken.set({ left:pos.final.x, top:pos.final.y });
                    }, 500);
                    TrapSystem.triggers.handleTrapTrigger(movedToken, trapToken);
                    return;
                }
            }
        }
    },

    //----------------------------------------------------------------------
    // 4) TRIGGERS & TRAP CONTROL
    //----------------------------------------------------------------------
    triggers: {
        // Enable
        enableTriggers() {
            TrapSystem.state.triggersEnabled = true;
            TrapSystem.utils.chat('✅ Trap triggers enabled');
            // Update any armed traps
            const tokens = findObjs({ _type:"graphic", _pageid:Campaign().get("playerpageid") });
            tokens.forEach(t => {
                if(TrapSystem.utils.isTrap(t)) {
                    const d = TrapSystem.utils.parseTrapNotes(t.get("gmnotes"), t);
                    if(d && d.isArmed && d.currentUses > 0) {
                        t.set({
                            aura1_color: TrapSystem.config.AURA_COLORS.ARMED,
                            aura1_radius: TrapSystem.config.AURA_SIZE,
                            showplayers_aura1:false
                        });
                    }
                }
            });
        },
        // Disable
        disableTriggers() {
            TrapSystem.state.triggersEnabled = false;
            TrapSystem.utils.chat('❌ Trap triggers disabled');
            // Show paused color
            const tokens = findObjs({ _type:"graphic", _pageid:Campaign().get("playerpageid") });
            tokens.forEach(t => {
                if(TrapSystem.utils.isTrap(t)) {
                    const d = TrapSystem.utils.parseTrapNotes(t.get("gmnotes"), t);
                    if(d && d.isArmed && d.currentUses > 0) {
                        t.set({
                            aura1_color: TrapSystem.config.AURA_COLORS.PAUSED,
                            aura1_radius: TrapSystem.config.AURA_SIZE,
                            showplayers_aura1:false
                        });
                    }
                }
            });
        },
        // Toggle entire system
        toggleTriggers() {
            if(TrapSystem.state.triggersEnabled) this.disableTriggers();
            else this.enableTriggers();
        },

        // The core function for when a trap triggers
        handleTrapTrigger(triggeredToken, trapToken) {
            const data = TrapSystem.utils.parseTrapNotes(trapToken.get("gmnotes"), trapToken);
            if(!data || !data.isArmed || data.currentUses <= 0) {
                TrapSystem.utils.chat('❌ Trap cannot be triggered (disarmed or out of uses)');
                return;
            }
            TrapSystem.state.lockedTokens[triggeredToken.id] = {
                locked: true,
                trapToken: trapToken.id,
                macroTriggered: false,
                trapData: data
            };
            TrapSystem.utils.updateTokenLockState(triggeredToken, trapToken.id, true);

            // Make control panel
            const img = triggeredToken.get("imgsrc")
                .replace(/\/[^\/]*$/, "/med.png")
                .replace(/\(/g, '%28').replace(/\)/g, '%29')
                .replace(/'/g, '%27').replace(/"/g, '%22');
            const name = triggeredToken.get("name") || "Unknown Token";

            const panel = [
                '&{template:default} {{name=Trap Control Panel}}',
                `{{Trapped Token=<img src="${img}" width="40" height="40"> **${name}**}}`,
                `{{State=🎯 ${data.isArmed ? "ARMED" : "DISARMED"} Uses: ${data.currentUses}/${data.maxUses}}}`,
                `{{Reminder=⚠️ Ensure the correct trap token is selected for macros that require a selected token!}}`,
                `{{After Trigger=${data.currentUses > 1 ? "🎯 ARMED" : "🔴 AUTO-DISARMED"} Uses: ${data.currentUses - 1}/${data.maxUses}}}`,
                `{{Actions=[⏭️ Allow Move](!trapsystem allowmovement ${triggeredToken.id}) [📊 Status](!trapsystem status ${trapToken.id}) [👯 Allow All](!trapsystem allowall) [🔄 Toggle](!trapsystem toggle ${trapToken.id})}}`,
                `{{Trigger Options=[🎯 ${data.primary.name}](!trapsystem marktriggered ${triggeredToken.id} ${trapToken.id} ${data.primary.macro})`
            ];
            if(data.options && data.options.length) {
                data.options.forEach(o => {
                    panel.push(`[🎯 ${o.name}](!trapsystem marktriggered ${triggeredToken.id} ${trapToken.id} ${o.macro})`);
                });
            }
            panel.push('}}');
            sendChat("API", `/w GM ${panel.join(' ')}`);
        },

        // Allow movement
        allowMovement(tokenId) {
            const lockData = TrapSystem.state.lockedTokens[tokenId];
            if(!lockData) return;
            const trapId = lockData.trapToken;
            const trapToken = getObj("graphic", trapId);
            const token = getObj("graphic", tokenId);
            if(token && trapToken) {
                TrapSystem.utils.updateTokenLockState(token, trapId, false);
                if(lockData.macroTriggered) {
                    const newUses = lockData.trapData.currentUses - 1;
                    TrapSystem.utils.updateTrapUses(trapToken, newUses, lockData.trapData.maxUses);
                    if(newUses <= 0) {
                        TrapSystem.utils.updateTrapUses(trapToken, 0, lockData.trapData.maxUses, false);
                        trapToken.set({
                            aura1_color: TrapSystem.config.AURA_COLORS.DISARMED,
                            aura1_radius: TrapSystem.config.AURA_SIZE,
                            showplayers_aura1: false
                        });
                        TrapSystem.utils.chat('🔴 Trap depleted and auto-disarmed!');
                    }
                }
            }
            delete TrapSystem.state.lockedTokens[tokenId];
            TrapSystem.state.safeMoveTokens.add(tokenId);
            TrapSystem.utils.chat('✅ Movement allowed. Next move is free.');
        },

        // Allow movement for all locked tokens
        allowAllMovement() {
            const lockedTokens = Object.keys(TrapSystem.state.lockedTokens);
            if (lockedTokens.length === 0) {
                TrapSystem.utils.chat('ℹ️ No tokens are currently locked');
                return;
            }
            lockedTokens.forEach(tokenId => {
                this.allowMovement(tokenId);
            });
            TrapSystem.utils.chat(`✅ Movement allowed for ${lockedTokens.length} token(s)`);
        },

        markTriggered(tokenId, trapId) {
            if(TrapSystem.state.lockedTokens[tokenId]) {
                TrapSystem.state.lockedTokens[tokenId].macroTriggered = true;
                TrapSystem.utils.log(`Macro triggered for token ${tokenId}`, 'info');
            }
        },

        // Show trap status
        getTrapStatus(token) {
            if(!token) return;
            const data = TrapSystem.utils.parseTrapNotes(token.get("gmnotes"), token);
            if(!data) {
                TrapSystem.utils.chat('❌ Invalid trap config');
                return;
            }
            const lockedList = Object.entries(TrapSystem.state.lockedTokens)
                .filter(([_,val]) => val.trapToken === token.id)
                .map(([k,_val]) => getObj("graphic", k))
                .filter(x => x);

            let msg = [
                '&{template:default} {{name=Trap Status}}',
                `{{State=${data.isArmed ? "🎯 ARMED" : "🔴 DISARMED"}}}`,
                `{{Uses=${data.currentUses}/${data.maxUses}}}`,
                `{{Failure Macro=${data.primary.name}}}`
            ];
            if (data.type === "interaction") {
                // Show success and failure macros for interaction traps
                if (data.success) {
                    msg.push(`{{Success Macro=${data.success}}}`);
                }
            } else if (Array.isArray(data.options) && data.options.length) {
                // Show options for standard traps
                const optionsList = data.options.map(o => `${o.name}`).join('<br>');
                msg.push(`{{Options=${optionsList}}}`);
            }
            if(data.currentUses>0) {
                msg.push(`{{If Triggered=${data.currentUses>1?"Remains ARMED":"AUTO-DISARM"} -> ${data.currentUses-1}/${data.maxUses}}}`);
            }
            if(lockedList.length) {
                let lockStr = lockedList.map(tk => {
                    let i = tk.get("imgsrc")
                        .replace(/\/[^\/]*$/, "/med.png")
                        .replace(/\(/g, '%28').replace(/\)/g, '%29')
                        .replace(/'/g, '%27').replace(/"/g, '%22');
                    return `<img src="${i}" width="40" height="40"> ${tk.get("name")||"???"}`;
                }).join('\\n');
                msg.push(`{{Currently Holding=${lockStr}}}`);
            }
            sendChat("TrapSystem", `/w GM ${msg.join(' ')}`);
        },

        // Toggle trap armed state
        toggleTrap(token) {
            if (!token) {
                TrapSystem.utils.chat('❌ Error: No token provided for toggle!');
                return;
            }
            const trapData = TrapSystem.utils.parseTrapNotes(token.get("gmnotes"), token);
            if (!trapData) {
                TrapSystem.utils.chat('❌ Error: Invalid trap configuration!');
                return;
            }

            // Toggle the armed state
            const newArmedState = !trapData.isArmed;
            
            // If arming & no uses, restore 1
            let newUses = trapData.currentUses;
            if (newArmedState && trapData.currentUses <= 0) {
                newUses = 1;
                TrapSystem.utils.chat('✨ Restored 1 use to trap');
            }
            
            // Update
            TrapSystem.utils.updateTrapUses(token, newUses, trapData.maxUses, newArmedState);
            
            // Update aura
            token.set({
                aura1_color: newArmedState && newUses > 0 
                    ? (TrapSystem.state.triggersEnabled 
                        ? TrapSystem.config.AURA_COLORS.ARMED 
                        : TrapSystem.config.AURA_COLORS.PAUSED) 
                    : TrapSystem.config.AURA_COLORS.DISARMED,
                aura1_radius: TrapSystem.config.AURA_SIZE,
                showplayers_aura1: false
            });

            // Status
            TrapSystem.utils.chat(`${newArmedState ? '🎯' : '🔴'} Trap ${newArmedState ? 'ARMED' : 'DISARMED'}`);
            if (trapData.type === 'interaction') {
                TrapSystem.menu.showInteractionMenu(token);
            } else {
                this.getTrapStatus(token);
            }
        },

        // Show manual trigger panel
        manualTrigger(trapToken) {
            if (!trapToken) {
                TrapSystem.utils.chat('❌ Error: No trap token selected!');
                return;
            }
            const trapData = TrapSystem.utils.parseTrapNotes(trapToken.get("gmnotes"), trapToken);
            if (!trapData) {
                TrapSystem.utils.chat('❌ Error: Invalid trap configuration!');
                return;
            }
            if (!trapData.isArmed) {
                TrapSystem.utils.chat('⚠️ Trap is not armed!');
                return;
            }
            if (trapData.currentUses <= 0) {
                TrapSystem.utils.chat('⚠️ Trap has no uses remaining!');
                return;
            }
            // If "interaction" type, show interaction
            if (trapData.type === 'interaction') {
                TrapSystem.menu.showInteractionMenu(trapToken);
                return;
            }
            // Otherwise show a control panel
            const controlPanel = [
                '&{template:default} {{name=Trap Control Panel}}',
                `{{State=🎯 ${trapData.isArmed ? "ARMED" : "DISARMED"} Uses: ${trapData.currentUses}/${trapData.maxUses}}}`,
                `{{Reminder=⚠️ Ensure the correct trap token is selected for macros that require a selected token!}}`,
                `{{After Trigger=${trapData.currentUses > 1 ? "🎯 ARMED" : "🔴 AUTO-DISARMED"} Uses: ${trapData.currentUses - 1}/${trapData.maxUses}}}`,
                `{{Actions=[🔄 Toggle](!trapsystem toggle ${trapToken.id}) [📊 Status](!trapsystem status ${trapToken.id})}}`,
                `{{Trigger Options=[🎯 ${trapData.primary.name}](!trapsystem manualtrigger ${trapToken.id} ${trapData.primary.macro})`
            ];
            if (trapData.options && trapData.options.length > 0) {
                trapData.options.forEach(option => {
                    controlPanel.push(`[🎯 ${option.name}](!trapsystem manualtrigger ${trapToken.id} ${option.macro})`);
                });
            }
            controlPanel.push('}}');
            sendChat("API", `/w GM ${controlPanel.join(' ')}`);
        },

        // Setup standard trap
        setupTrap(token, uses, mainMacro, optionalMacro2, optionalMacro3, movement) {
            if (!token) {
                TrapSystem.utils.chat('❌ Error: No token selected!');
                return;
            }
            const maxUses = parseInt(uses);
            if (isNaN(maxUses) || maxUses < 1) {
                TrapSystem.utils.chat('❌ Error: Uses must be a positive number!');
                return;
            }
            const macro = findObjs({ _type: "macro", name: mainMacro })[0];
            if (!macro) {
                TrapSystem.utils.chat(`❌ Error: Main Macro "${mainMacro}" not found!`);
                return;
            }

            if (optionalMacro2 && optionalMacro2 !== "None") {
                const macro2 = findObjs({ _type: "macro", name: optionalMacro2 })[0];
                if (!macro2) {
                    TrapSystem.utils.chat(`❌ Error: Optional Macro 2 "${optionalMacro2}" not found!`);
                    return;
                }
            }
            if (optionalMacro3 && optionalMacro3 !== "None") {
                const macro3 = findObjs({ _type: "macro", name: optionalMacro3 })[0];
                if (!macro3) {
                    TrapSystem.utils.chat(`❌ Error: Optional Macro 3 "${optionalMacro3}" not found!`);
                    return;
                }
            }

            // Build config
            let trapConfig = `{!traptrigger uses: ${maxUses}/${maxUses} armed: on`;
            trapConfig += ` primary: Name: "${mainMacro}" Macro: ${mainMacro}`;

            if ((optionalMacro2 && optionalMacro2 !== "None") || (optionalMacro3 && optionalMacro3 !== "None")) {
                trapConfig += ` options: [`;
                if (optionalMacro2 && optionalMacro2 !== "None") {
                    trapConfig += `Name: "${optionalMacro2}" Macro: ${optionalMacro2}`;
                }
                if (optionalMacro3 && optionalMacro3 !== "None") {
                    if (optionalMacro2 && optionalMacro2 !== "None") trapConfig += ` `;
                    trapConfig += `Name: "${optionalMacro3}" Macro: ${optionalMacro3}`;
                }
                trapConfig += `]`;
            }

            if (movement && movement !== "None") {
                if (movement === "Center") {
                    trapConfig += ` position: center`;
                } else if (movement === "Grid") {
                    trapConfig += ` position: (0,0)`;
                }
            }
            trapConfig += `}`;

            // Set token props
            token.set({
                gmnotes: trapConfig,
                bar1_value: maxUses,
                bar1_max: maxUses,
                aura1_radius: TrapSystem.config.AURA_SIZE,
                aura1_color: TrapSystem.config.AURA_COLORS.ARMED,
                showplayers_aura1: false
            });
            TrapSystem.utils.chat(`✅ Trap created with ${maxUses} uses, using macro "${mainMacro}"`);
            this.getTrapStatus(token);
        },

        // Setup an "interaction" trap
        setupInteractionTrap(token, uses, successMacro, failureMacro, check1Type, check1DC, check2Type, check2DC, movementTriggerEnabled = true) {
            TrapSystem.utils.log(`Setting up interaction trap with params:
                Uses: ${uses}
                Success: ${successMacro}
                Failure: ${failureMacro}
                Check1: ${check1Type} DC:${check1DC}
                Check2: ${check2Type} DC:${check2DC}
                MovementTrigger: ${movementTriggerEnabled}`, 'debug');

            if (!token) {
                TrapSystem.utils.chat('❌ Error: No token selected!');
                return;
            }
            const maxUses = parseInt(uses);
            if (isNaN(maxUses) || maxUses < 1) {
                TrapSystem.utils.chat('❌ Error: Uses must be a positive number!');
                return;
            }
            const checkMacro = (m) => !m || findObjs({_type:"macro", name:m})[0];
            if (!checkMacro(successMacro)) {
                TrapSystem.utils.chat(`❌ Error: Success Macro "${successMacro}" not found!`);
                return;
            }
            if (!checkMacro(failureMacro)) {
                TrapSystem.utils.chat(`❌ Error: Failure Macro "${failureMacro}" not found!`);
                return;
            }

            // Build checks
            let checksConfig = [];
            if (check1Type && check1Type !== "None") {
                const check1DC_num = parseInt(check1DC);
                if (isNaN(check1DC_num)) {
                    TrapSystem.utils.chat('❌ Error: First Check DC must be a number!');
                    return;
                }
                checksConfig.push(`${check1Type}:${check1DC_num}`);
            }
            if (check2Type && check2Type !== "None") {
                const check2DC_num = parseInt(check2DC);
                if (isNaN(check2DC_num)) {
                    TrapSystem.utils.chat('❌ Error: Second Check DC must be a number!');
                    return;
                }
                checksConfig.push(`${check2Type}:${check2DC_num}`);
            }

            let trapConfig = `{!traptrigger uses: ${maxUses}/${maxUses} armed: on type: interaction`;
            trapConfig += ` primary: Name:"${failureMacro}" Macro: ${failureMacro}`;
            trapConfig += ` success: ${successMacro}`;
            trapConfig += ` failure: ${failureMacro}`;
            if (checksConfig.length > 0) {
                trapConfig += ` checks: "${checksConfig.join(',')}"`;
            }
            if (!movementTriggerEnabled) {
                trapConfig += ` {noMovementTrigger}`;
            }
            trapConfig += `}`;

            TrapSystem.utils.log(`Final trap configuration: ${trapConfig}`, 'debug');

            token.set({
                gmnotes: trapConfig,
                aura1_radius: TrapSystem.config.AURA_SIZE,
                aura1_color: TrapSystem.config.AURA_COLORS.ARMED,
                showplayers_aura1: false,
                bar1_value: maxUses,
                bar1_max: maxUses,
                showplayers_bar1: false
            });

            TrapSystem.utils.chat(`✅ Interaction trap created with ${maxUses} uses`);
            TrapSystem.triggers.getTrapStatus(token);
        },

        // Execute trap trigger
        executeTrapTrigger(tokenId, trapId) {
            const token = getObj("graphic", tokenId);
            const trapToken = getObj("graphic", trapId);
            if (!token || !trapToken) {
                TrapSystem.utils.log("Token or trap not found", 'error');
                return;
            }
            const trapData = TrapSystem.utils.parseTrapNotes(trapToken.get("gmnotes"), trapToken);
            if (!trapData || !trapData.isArmed || trapData.currentUses <= 0) {
                TrapSystem.utils.chat('❌ Error: Trap cannot be triggered (disarmed or no uses)');
                return;
            }

            if (trapData.type === 'interaction') {
                if (trapData.failure) TrapSystem.utils.executeMacro(trapData.failure);
            } else {
                if (trapData.primary && trapData.primary.macro) {
                    TrapSystem.utils.executeMacro(trapData.primary.macro);
                }
            }

            const newUses = Math.max(0, trapData.currentUses - 1);
            if (newUses <= 0) {
                TrapSystem.utils.updateTrapUses(trapToken, 0, trapData.maxUses, false);
                TrapSystem.utils.chat('🔴 Trap depleted and auto-disarmed!');
            } else {
                TrapSystem.utils.updateTrapUses(trapToken, newUses, trapData.maxUses, true);
            }

            trapToken.set({
                aura1_color: newUses > 0 
                    ? (TrapSystem.state.triggersEnabled 
                        ? TrapSystem.config.AURA_COLORS.ARMED 
                        : TrapSystem.config.AURA_COLORS.PAUSED) 
                    : TrapSystem.config.AURA_COLORS.DISARMED,
                aura1_radius: TrapSystem.config.AURA_SIZE,
                showplayers_aura1: false
            });

            if (TrapSystem.state.lockedTokens[tokenId]) {
                TrapSystem.state.lockedTokens[tokenId].macroTriggered = true;
            }
        },

        manualMacroTrigger(trapId, macroName) {
            const trapToken = getObj("graphic", trapId);
            if (!trapToken) {
                TrapSystem.utils.chat('❌ Error: Trap token not found!');
                return;
            }
            const trapData = TrapSystem.utils.parseTrapNotes(trapToken.get("gmnotes"), trapToken);
            if (!trapData || !trapData.isArmed || trapData.currentUses <= 0) {
                TrapSystem.utils.chat('❌ Error: Trap cannot be triggered (disarmed or no uses)');
                return;
            }
            // Run the macro
            const macroExecuted = TrapSystem.utils.executeMacro(macroName);
            if (macroExecuted) {
                // Lower the use
                const newUses = trapData.currentUses - 1;
                TrapSystem.utils.updateTrapUses(trapToken, newUses, trapData.maxUses);
                if (newUses <= 0) {
                    TrapSystem.utils.chat('🔴 Trap depleted and auto-disarmed!');
                    trapToken.set({
                        aura1_color: TrapSystem.config.AURA_COLORS.DISARMED,
                        aura1_radius: TrapSystem.config.AURA_SIZE,
                        showplayers_aura1: false
                    });
                }
            } else {
                TrapSystem.utils.chat('❌ Failed to execute the macro.');
            }
        }
    },

    //----------------------------------------------------------------------
    // 5) ADVANCED INTERACTION MENU
    //----------------------------------------------------------------------
    menu: {
        showInteractionMenu(trapToken) {
            if (!trapToken) return;
            try {
                let tokenImage = trapToken.get("imgsrc");
                tokenImage = tokenImage.replace(/\/[^\/]*$/, "/med.png")
                                       .replace(/\(/g, '%28').replace(/\)/g, '%29')
                                       .replace(/'/g, '%27').replace(/"/g, '%22');
                const tokenName = trapToken.get("name") || "Unknown Object";
                const trapData = TrapSystem.utils.parseTrapNotes(trapToken.get("gmnotes"));

                if (!trapData) {
                    TrapSystem.utils.log('Invalid trap configuration', 'error');
                    return;
                }

                const menu = [
                    '&{template:default}',
                    `{{name=${tokenName}}}`,
                    `{{Description=<img src="${tokenImage}" width="100" height="100" style="display: block; margin: 5px auto;">}}`,
                    `{{State=🎯 ${trapData.isArmed ? (TrapSystem.state.triggersEnabled ? "ARMED" : "⚠️ PAUSED") : "DISARMED"} (${trapData.currentUses}/${trapData.maxUses} uses)}}`
                ];

                // Show action buttons if armed/enabled
                if (trapData.isArmed && TrapSystem.state.triggersEnabled) {
                    menu.push(`{{Actions=`,
                    `[🎯 Trigger Action](!trapsystem interact ${trapToken.id} trigger)`,
                    `[💭 Explain Action](!trapsystem interact ${trapToken.id} explain)`,
                    `}}`);
                } else if (!TrapSystem.state.triggersEnabled) {
                    menu.push(`{{Status=⚠️ Trap system is currently PAUSED}}`);
                }

                // Show trap info if it exists
                if (trapData.checks && trapData.checks.length > 0) {
                    const checkInfo = trapData.checks.map(check => 
                        `${TrapSystem.config.SKILL_TYPES[check.type] || "🎲"} ${check.type} (DC ${check.dc})`
                    ).join('<br>');
                    menu.push(`{{Trap Info=Skill Check:<br>${checkInfo}}}`);
                }

                menu.push(`{{Management=[📊 Status](!trapsystem status ${trapToken.id}) | [🔄 Toggle](!trapsystem toggle ${trapToken.id})}}`);
                sendChat("TrapSystem", `/w gm ${menu.join(' ')}`);
            } catch (err) {
                TrapSystem.utils.log(`Error showing interaction menu: ${err.message}`, 'error');
            }
        },

        handleInteraction(token, action, playerid) {
            TrapSystem.utils.log(`handleInteraction called with tokenId:${token.id}, action:${action}, playerid:${playerid}`, 'debug');
            const config = TrapSystem.utils.parseTrapNotes(token.get("gmnotes"), token);
            TrapSystem.utils.log(`Parsed trap config for handleInteraction`, 'debug');

            if (!config || config.type !== "interaction") {
                TrapSystem.utils.log("Invalid config or not 'interaction' type", 'debug');
                return;
            }

            // If trigger or fail => execute failure macro
            if (action === "trigger" || action === "fail") {
                TrapSystem.utils.log(`Executing failure macro:${config.failure}`, 'debug');
                if (config.failure) TrapSystem.utils.executeMacro(config.failure);

                // Decrement uses
                const newUses = Math.max(0, config.currentUses - 1);
                if (newUses <= 0) {
                    TrapSystem.utils.updateTrapUses(token, 0, config.maxUses, false);
                    TrapSystem.utils.chat('🔴 Trap depleted and auto-disarmed!');
                } else {
                    TrapSystem.utils.updateTrapUses(token, newUses, config.maxUses, true);
                }
                TrapSystem.triggers.getTrapStatus(token);
                return;
            }

            // The "explain" action => show GM menu
            if (action === "explain") {
                // Show character selection menu and return
                TrapSystem.menu.showCharacterSelectionMenu(token, playerid);
                return;
            }
        },

        handleAllowAction(token, playerid) {
            const trapData = TrapSystem.utils.parseTrapNotes(token.get("gmnotes"), token);
            if (!trapData) return;
            // Show success
            const tokenName = token.get("name") || "Unknown Token";
            const tokenIcon = `<img src="${token.get('imgsrc').replace(/\/[^\/]*$/, '/med.png')}" width="20" height="20">`;
            let menu = `&{template:default} {{name=Action Allowed}}`;
            menu += `{{Token=${tokenIcon} **${tokenName}**}}`;
            menu += `{{Result=✅ Action allowed}}`;
            sendChat("TrapSystem", menu);

            // Execute success
            if (trapData.success) TrapSystem.utils.executeMacro(trapData.success);
            // Decrement uses
            const newUses = Math.max(0, trapData.currentUses - 1);
            if (newUses <= 0) {
                TrapSystem.utils.updateTrapUses(token, 0, trapData.maxUses, false);
                TrapSystem.utils.chat('🔴 Trap depleted and auto-disarmed!');
            } else {
                TrapSystem.utils.updateTrapUses(token, newUses, trapData.maxUses, true);
            }
            token.set({
                aura1_color: newUses > 0 
                    ? (TrapSystem.state.triggersEnabled 
                        ? TrapSystem.config.AURA_COLORS.ARMED 
                        : TrapSystem.config.AURA_COLORS.PAUSED) 
                    : TrapSystem.config.AURA_COLORS.DISARMED,
                aura1_radius: TrapSystem.config.AURA_SIZE,
                showplayers_aura1: false
            });
        },

        handleFailAction(token, playerid) {
            const trapData = TrapSystem.utils.parseTrapNotes(token.get("gmnotes"), token);
            if (!trapData) return;
            if (!trapData.isArmed || trapData.currentUses <= 0) {
                TrapSystem.utils.chat('⚠️ Trap cannot be triggered (disarmed or no uses)');
                return;
            }
            // Show failure
            const tokenName = token.get("name") || "Unknown Token";
            const tokenIcon = `<img src="${token.get('imgsrc').replace(/\/[^\/]*$/, '/med.png')}" width="20" height="20">`;
            let menu = `&{template:default} {{name=Action Failed}}`;
            menu += `{{Token=${tokenIcon} **${tokenName}**}}`;
            menu += `{{Result=❌ Action failed}}`;
            sendChat("TrapSystem", menu);

            // Failure macro
            if (trapData.failure) TrapSystem.utils.executeMacro(trapData.failure);
            const newUses = Math.max(0, trapData.currentUses - 1);
            token.set("bar1_value", newUses);
            token.set("bar1_max", trapData.maxUses);
            if (newUses <= 0) {
                TrapSystem.utils.updateTrapUses(token, 0, trapData.maxUses, false);
                TrapSystem.utils.chat('🔴 Trap depleted and auto-disarmed!');
            } else {
                TrapSystem.utils.updateTrapUses(token, newUses, trapData.maxUses, true);
            }
            token.set({
                aura1_color: newUses > 0 
                    ? (TrapSystem.state.triggersEnabled 
                        ? TrapSystem.config.AURA_COLORS.ARMED 
                        : TrapSystem.config.AURA_COLORS.PAUSED) 
                    : TrapSystem.config.AURA_COLORS.DISARMED,
                aura1_radius: TrapSystem.config.AURA_SIZE,
                showplayers_aura1: false
            });
            TrapSystem.triggers.getTrapStatus(token);
        },

        showCharacterSelectionMenu(token, playerid) {
            const characters = findObjs({ _type: "character" });
            const tokenName = token.get("name") || "Unknown Token";
            const tokenIcon = `<img src="${token.get('imgsrc').replace(/\/[^\/]*$/, '/med.png')}" width="20" height="20">`;
        
            let menu = `&{template:default} {{name=Select Character for Skill Check}}`;
            menu += `{{Token=${tokenIcon} **${tokenName}**}}`;
            menu += `{{Characters=`;
        
            // Only include characters controlled by at least one non-GM player
            const filtered = characters.filter(char => {
                const controlledBy = (char.get("controlledby") || "").split(",");
                // Exclude if no controllers, or only controlled by GM(s)
                return controlledBy.some(pid => pid && !playerIsGM(pid));
            });
        
            filtered.forEach(char => {
                const charName = char.get("name");
                const charId = char.id;
                menu += `[${charName}](!trapsystem selectcharacter ${token.id} ${charId} ${playerid}) `;
            });
        
            menu += `}}`;
            TrapSystem.utils.whisperGM(menu);
        },

        handleSkillCheck(token, checkIndex, playerid, hideDisplayDCButton = false, hideSetDCButton = false, whisperTo = 'gm') {
            TrapSystem.utils.log(`handleSkillCheck tokenId:${token.id}, checkIndex:${checkIndex}, playerid:${playerid}, hideDisplayDCButton:${hideDisplayDCButton}, hideSetDCButton:${hideSetDCButton}, whisperTo:${whisperTo}`,'debug');
            const config = TrapSystem.utils.parseTrapNotes(token.get("gmnotes"), token);
            if (!config || !config.checks || (checkIndex !== 'custom' && checkIndex >= config.checks.length)) {
                 TrapSystem.utils.log('Exiting handleSkillCheck: Invalid config or checkIndex.', 'debug');
                 return;
            }

            const check = (checkIndex === 'custom' && TrapSystem.state.pendingChecks[playerid]?.config?.checks[0]) 
                ? TrapSystem.state.pendingChecks[playerid].config.checks[0]
                : config.checks[checkIndex];

            if (!check) {
                TrapSystem.utils.log('Exiting handleSkillCheck: Check object not found.', 'debug');
                return;
            }
            
            const tokenName = token.get("name") || "Unknown Token";
            const tokenIcon = `<img src="${token.get('imgsrc').replace(/\/[^\/]*$/, '/med.png')}" width="20" height="20">`;
            const emoji = TrapSystem.config.SKILL_TYPES[check.type] || "🎲";
            const skillType = check.type.replace(/_/g, ' ');

            const existingCheck = TrapSystem.state.pendingChecks[playerid] || {};
            const pendingCheck = {
                token: token,
                checkIndex: checkIndex,
                config: {
                    ...config,
                    checks: [check] 
                },
                advantage: null,
                firstRoll: null,
                playerid: playerid,
                characterId: existingCheck.characterId,
                characterName: existingCheck.characterName
            };
            TrapSystem.state.pendingChecks[playerid] = pendingCheck;
            if (pendingCheck.characterId) {
                TrapSystem.state.pendingChecksByChar[pendingCheck.characterId] = pendingCheck;
            }

            let menu = `&{template:default} {{name=${emoji} ${skillType} Check (DC ${check.dc})}}`;
            menu += `{{Token=${tokenIcon} **${tokenName}**}}`;
            menu += `{{Roll=`;
            menu += `[Advantage](!trapsystem rollcheck ${token.id} ${checkIndex} advantage ${playerid}) | `;
            menu += `[Normal](!trapsystem rollcheck ${token.id} ${checkIndex} normal ${playerid}) | `;
            menu += `[Disadvantage](!trapsystem rollcheck ${token.id} ${checkIndex} disadvantage ${playerid})`;

            if (!hideSetDCButton && checkIndex !== 'custom') { // Only show Set DC if not explicitly hiding AND if checkIndex isn't already 'custom'
                menu += ` | [Set DC](!trapsystem setdc ${token.id} ?{New DC|${check.dc}} ${playerid} ${check.type.replace(/ /g, '_')})`;
            }
            if (!hideDisplayDCButton && !TrapSystem.state.displayDCForCheck[playerid]) {
                menu += ` | [Display DC](!trapsystem displaydc ${token.id} ${checkIndex} ${playerid})`;
            }
            menu += `}}`;
            if (whisperTo === 'gm') {
                TrapSystem.utils.whisperGM(menu);
            } else {
                // Send as a public message from TrapSystem, visible to the player
                sendChat("TrapSystem", menu);
            }
        },

        handleCustomCheck(token, playerid) {
            TrapSystem.utils.log(`handleCustomCheck tokenId:${token.id}, playerid:${playerid}`, 'debug');
            const config = TrapSystem.utils.parseTrapNotes(token.get("gmnotes"), token);
            if (!config) return;
            const tokenName = token.get("name") || "Unknown Token";
            const tokenIcon = `<img src="${token.get('imgsrc').replace(/\/[^\/]*$/, '/med.png')}" width="20" height="20">`;

            let menu = `&{template:default} {{name=Custom Skill Check}}`;
            menu += `{{Token=${tokenIcon} **${tokenName}**}}`;
            let skillButtons = Object.entries(TrapSystem.config.SKILL_TYPES).map(([type, emoji]) => {
                const safeType = type.replace(/ /g, '_').replace(/[^a-zA-Z0-9_]/g, '');
                return `[${emoji} ${type}](!trapsystem setcheck ${token.id} ${safeType} ${playerid})`;
            }).join(" | ");
            menu += `{{Skills=${skillButtons}}}`;
            TrapSystem.utils.whisperGM(menu);
        },

        handleSetCheck(token, checkType, playerid) {
            TrapSystem.utils.log(`handleSetCheck tokenId:${token.id}, checkType:${checkType}, playerid:${playerid}`, 'debug');
            const skillType = Object.keys(TrapSystem.config.SKILL_TYPES).find(type => 
                type.replace(/ /g, '_').replace(/[^a-zA-Z0-9_]/g, '') === checkType
            ) || checkType;
            const config = TrapSystem.utils.parseTrapNotes(token.get("gmnotes"), token);
            if (!config) return;

            const tokenName = token.get("name") || "Unknown Token";
            const tokenIcon = `<img src="${token.get('imgsrc').replace(/\/[^\/]*$/, '/med.png')}" width="20" height="20">`;
            const emoji = TrapSystem.config.SKILL_TYPES[skillType] || "🎲";

            const prevPending = TrapSystem.state.pendingChecks[playerid] || {};
            TrapSystem.state.pendingChecks[playerid] = {
                token: token,
                checkIndex: 'custom',
                config: {
                    ...config,
                    checks: [{
                        type: skillType,
                        dc: null
                    }]
                },
                characterId: prevPending.characterId || null,
                characterName: prevPending.characterName || null
            };
            let menu = `&{template:default} {{name=${emoji} Set DC for ${skillType}}}`;
            menu += `{{Token=${tokenIcon} **${tokenName}**}}`;
            menu += `{{DC=[Set DC](!trapsystem setdc ${token.id} ?{DC|10} ${playerid} ${skillType.replace(/ /g, '_')})}}`;
            TrapSystem.utils.whisperGM(menu);
        },

        handleSetDC(token, dc, playerid, checkType) {
            TrapSystem.utils.log(`handleSetDC tokenId:${token.id}, dc:${dc}, playerid:${playerid}, checkType:${checkType}`, 'debug');
            const config = TrapSystem.utils.parseTrapNotes(token.get("gmnotes"), token);
            if (!config) return;

            const newDc = parseInt(dc, 10);
            if (isNaN(newDc)) {
                TrapSystem.utils.chat("❌ Error: DC must be a number.");
                return;
            }

            const prevPending = TrapSystem.state.pendingChecks[playerid] || {};
            TrapSystem.state.pendingChecks[playerid] = {
                token: token,
                checkIndex: 'custom', // Mark as custom since DC was set
                config: {
                    ...config, // Carry over other config parts
                    checks: [{ // Override checks with the new custom one
                        type: checkType, // skillType
                        dc: newDc
                    }]
                },
                advantage: null, // Reset advantage state
                firstRoll: null, // Reset firstRoll state
                playerid: playerid,
                characterId: prevPending.characterId || null,
                characterName: prevPending.characterName || null
            };
            // Also update pendingChecksByChar if characterId exists
            if (prevPending.characterId) {
                 TrapSystem.state.pendingChecksByChar[prevPending.characterId] = TrapSystem.state.pendingChecks[playerid];
            }


            const tokenName = token.get("name") || "Unknown Token";
            const tokenIcon = `<img src="${token.get('imgsrc').replace(/\/[^\/]*$/, '/med.png')}" width="20" height="20">`;
            const emoji = TrapSystem.config.SKILL_TYPES[checkType] || "🎲";

            let menu = `&{template:default} {{name=${emoji} ${checkType} Check (DC ${newDc})}}`;
            menu += `{{Token=${tokenIcon} **${tokenName}**}}`;
            menu += `{{Roll=`;
            menu += `[Advantage](!trapsystem rollcheck ${token.id} custom advantage ${playerid}) | `;
            menu += `[Normal](!trapsystem rollcheck ${token.id} custom normal ${playerid}) | `;
            menu += `[Disadvantage](!trapsystem rollcheck ${token.id} custom disadvantage ${playerid})`;
            
            if (!TrapSystem.state.displayDCForCheck[playerid]) {
                 menu += ` | [Display DC](!trapsystem displaydc ${token.id} custom ${playerid})`;
            }
            menu += `}}`;
            // This menu is for the GM to choose roll type after setting a custom DC
            TrapSystem.utils.whisperGM(menu);
        },

        handleRollCheck(token, checkIndex, advantage, playerid, modifier = 0) {
            TrapSystem.utils.log(`handleRollCheck tokenId:${token.id}, checkIndex:${checkIndex}, advantage:${advantage}, playerid:${playerid}, modifier:${modifier}`, 'debug');
            const config = TrapSystem.utils.parseTrapNotes(token.get("gmnotes"), token);
            if (!config) return;

            const check = checkIndex === "custom"
                ? TrapSystem.state.pendingChecks[playerid]?.config.checks[0]
                : config.checks[checkIndex];
            if(!check) return;

            const tokenName = token.get("name") || "Unknown Token";
            const tokenIcon = `<img src="${token.get('imgsrc').replace(/\/[^\/]*$/, '/med.png')}" width="20" height="20">`;
            const emoji = TrapSystem.config.SKILL_TYPES[check.type] || "🎲";
            const skillType = check.type.replace(/_/g, ' ');

            // Get the existing pending check or create a new one
            const existingCheck = TrapSystem.state.pendingChecks[playerid] || {};

            // Update the pending check
            const pendingCheck = {
                token: token,
                checkIndex: checkIndex,
                config: {
                    ...config,
                    checks: [check]
                },
                advantage: advantage,
                firstRoll: null,
                playerid: playerid,
                characterId: existingCheck.characterId,
                characterName: existingCheck.characterName
            };

            // Store in both maps
            TrapSystem.state.pendingChecks[playerid] = pendingCheck;
            if (pendingCheck.characterId) {
                TrapSystem.state.pendingChecksByChar[pendingCheck.characterId] = pendingCheck;
                TrapSystem.utils.log(`Updated pending check for player:${playerid} and character:${pendingCheck.characterId}`, 'debug');
            } else {
                TrapSystem.utils.log(`Warning: No character ID available for pending check`, 'warning');
            }

            let rollInstructions = "";
            let rollNote = "";
            if (advantage === "advantage") {
                rollInstructions = "Roll with advantage";
                rollNote = "Using the higher of two rolls";
            } else if (advantage === "disadvantage") {
                rollInstructions = "Roll with disadvantage";
                rollNote = "Using the lower of two rolls";
            } else {
                rollInstructions = "Roll normally";
            }

            const showDC = TrapSystem.state.displayDCForCheck[playerid] === true;
            let menu = `&{template:default} {{name=${emoji} Skill Check Required}}`;
            menu += `{{Token=${tokenIcon} **${tokenName}**}}`;
            menu += `{{Skill=${skillType}}}`;
            if (showDC) menu += `{{DC=${check.dc}}}`; // Only show if GM pressed the button
            menu += `{{Roll Type=${advantage.charAt(0).toUpperCase() + advantage.slice(1)}}}`;
            if (advantage !== 'normal') {
                menu += `{{Instructions=${rollInstructions}}}`;
                menu += `{{Note=${rollNote}}}`;
            } else {
                menu += `{{Instructions=Roll 1d20 using your character sheet or /roll 1d20}}`;
            }
            sendChat("TrapSystem", menu);
        },

        showGMResponseMenu(token, playerid) {
            const config = TrapSystem.utils.parseTrapNotes(token.get("gmnotes"), token);
            const tokenName = token.get("name") || "Unknown Token";
            const tokenIcon = `<img src="${token.get('imgsrc').replace(/\/[^\/]*$/, '/med.png')}" width="20" height="20">`;
            let menu = `&{template:default} {{name=GM Response}}`;
            menu += `{{Token=${tokenIcon} **${tokenName}**}}`;
            menu += `{{Action=💭 Explained Action}}`;
            menu += `{{Quick Actions=`;
            menu += `[✅ Allow Action](!trapsystem allow ${token.id} ${playerid}) | `;
            menu += `[❌ Fail Action](!trapsystem interact ${token.id} trigger ${playerid})}}`;
            if (config.checks && config.checks.length > 0) {
                let checkOptions = config.checks.map((check, index) => {
                    const emoji = TrapSystem.config.SKILL_TYPES[check.type] || "🎲";
                    const skillType = check.type.replace(/_/g, ' ');
                    return `[${emoji} ${skillType} (DC ${check.dc})](!trapsystem check ${token.id} ${index} ${playerid})`;
                }).join(" | ");
                menu += `{{Skill Checks=${checkOptions}}}`;
            }
            menu += `{{Custom Check=[🎲 Set Custom Check](!trapsystem customcheck ${token.id} ${playerid})}}`;
            TrapSystem.utils.whisperGM(menu);
        },

        handleDisplayDC(token, checkIndex, playerid) {
            // args: token.id, checkIndex, playerid
            TrapSystem.state.displayDCForCheck[playerid] = true;
            // Re-show the GM menu, but without the Display DC button
            TrapSystem.menu.handleSkillCheck(getObj("graphic", token.id), checkIndex, playerid, true);
        }
    },

    //----------------------------------------------------------------------
    // 6) INTERACTION: handleRollResult (Final step for advantage/disadv)
    //----------------------------------------------------------------------
    interaction: {
        handleRollResult(roll, playerid_of_roller) { // Renamed playerid to playerid_of_roller for clarity
            try {
                TrapSystem.utils.log(`Processing roll result from player:${playerid_of_roller} (who rolled) => total:${roll.total}, roll.characterid:${roll.characterid}`, 'debug');
                
                let pendingCheck = null;

                // Strategy 1: Roll has an explicit character ID (from sheet or previously auto-associated flat roll for single-char player)
                if (roll.characterid) {
                    pendingCheck = TrapSystem.state.pendingChecksByChar[roll.characterid];
                    if (pendingCheck) {
                        TrapSystem.utils.log(`Found pending check by roll.characterid: ${roll.characterid}. Associated char: ${pendingCheck.characterName}`, 'debug');
                        // Basic authorization: GM or player controlling the character can make the roll for them.
                        const character = getObj("character", roll.characterid);
                        let authorized = false;
                        if (character) {
                            const controlledBy = (character.get("controlledby") || "").split(",");
                            if (playerIsGM(playerid_of_roller) || controlledBy.includes(playerid_of_roller) || playerid_of_roller === pendingCheck.playerid) {
                                authorized = true;
                            }
                        }
                        if (!authorized) {
                            TrapSystem.utils.log(`Roller ${playerid_of_roller} is not authorized for character ${roll.characterid} tied to this pending check.`, 'warning');
                            pendingCheck = null; // Invalidate if roller isn't authorized for this character's check
                        }
                    } else {
                        TrapSystem.utils.log(`No pending check found in pendingChecksByChar for roll.characterid: ${roll.characterid}`, 'debug');
                    }
                }

                // Strategy 2: Roll is flat (no roll.characterid yet) - try to find a unique pending check via characters controlled by the roller.
                if (!pendingCheck && !roll.characterid) { // Only if roll didn't come with a characterID
                    const allChars = findObjs({ _type: "character" });
                    const charsControlledByRoller = allChars.filter(char => {
                        const controlledByArray = (char.get("controlledby") || "").split(",");
                        // Roller must control the char, and char must be player-controllable (not GM only)
                        return controlledByArray.includes(playerid_of_roller) && controlledByArray.some(pId => pId && pId.trim() !== "" && !playerIsGM(pId));
                    });

                    let potentialChecks = [];
                    for (const char of charsControlledByRoller) {
                        if (TrapSystem.state.pendingChecksByChar[char.id]) {
                            // Ensure this pending check is actually for this character
                            if (TrapSystem.state.pendingChecksByChar[char.id].characterId === char.id) {
                                potentialChecks.push(TrapSystem.state.pendingChecksByChar[char.id]);
                            }
                        }
                    }

                    if (potentialChecks.length === 1) {
                        pendingCheck = potentialChecks[0];
                        roll.characterid = pendingCheck.characterId; // IMP: Update roll object with characterId for consistency
                        TrapSystem.utils.log(`Flat roll by ${playerid_of_roller}. Matched to single pending check for character ${pendingCheck.characterName} (ID: ${roll.characterid}) via roller's controlled characters.`, 'debug');
                    } else if (potentialChecks.length > 1) {
                        TrapSystem.utils.log(`Flat roll by ${playerid_of_roller} who controls multiple characters, each with a distinct pending check. Ambiguous.`, 'warning');
                    } else {
                        TrapSystem.utils.log(`Flat roll by ${playerid_of_roller}. No unique pending check found via their controlled characters.`, 'debug');
                    }
                }

                // Strategy 3: Fallback to playerid_of_roller if they initiated a generic check (less common for GM-driven UI)
                // This might happen if a player uses a command that directly creates a pending check for themselves without char selection.
                if (!pendingCheck) {
                    pendingCheck = TrapSystem.state.pendingChecks[playerid_of_roller];
                    if (pendingCheck) {
                        TrapSystem.utils.log(`Found pending check by playerid_of_roller: ${playerid_of_roller}. This implies roller initiated a generic check.`, 'debug');
                        if (pendingCheck.characterId && !roll.characterid) {
                           roll.characterid = pendingCheck.characterId; // Ensure roll.characterid is set if pendingCheck had one
                        } 
                        // If pendingCheck.characterId is null here, it's a truly generic check for this player.
                    } else {
                        // This is where your log originally said "No pending check found..."
                         TrapSystem.utils.log(`No pending check found for player ${playerid_of_roller} in pendingChecks map either.`, 'debug');
                    }
                }

                if (!pendingCheck) {
                    TrapSystem.utils.log(`FINAL: No pending check ultimately found for player:${playerid_of_roller} or character:${roll.characterid} after all lookup strategies. Roll will not be processed for trap interaction.`, 'warning');
                    return;
                }

                // Always extract these before any mismatch logic so token is defined
                const { token, config, advantage } = pendingCheck;
                const check = pendingCheck.config.checks[0];
                const tokenName = token.get("name") || "Unknown Token";
                const tokenIcon = `<img src="${token.get('imgsrc').replace(/\/[^\/]*$/, '/med.png')}" width="20" height="20">`;
                const characterNameToDisplay = pendingCheck.characterName || "Player";
                const emoji = TrapSystem.config.SKILL_TYPES[check.type] || "🎲";
                const skillType = check.type.replace(/_/g, ' ');

                // --- Skill/Ability/Save Matching Logic ---
                // Normalize function: lowercases and strips ' check'/' save' suffixes
                function normalizeType(str) {
                    return (str||'').toLowerCase().replace(/\s*(check|save)$/i, '').trim();
                }
                const expectedTypeRaw = pendingCheck.config.checks[0].type;
                const rolledTypeRaw = roll.rolledSkillName || '';
                const expectedType = normalizeType(expectedTypeRaw);
                const rolledType = normalizeType(rolledTypeRaw);
                TrapSystem.utils.log(`[SkillMatch] Expected: '${expectedTypeRaw}' (normalized: '${expectedType}'), Rolled: '${rolledTypeRaw}' (normalized: '${rolledType}')`, 'debug');
                let mismatch = false;
                let mismatchReason = '';

                // Helper: is this a flat d20 roll? (no skill/ability/save attached)
                const isFlatRoll = !roll.rolledSkillName;
                const expectsFlatRoll = expectedType === 'flat roll';

                if (expectsFlatRoll && isFlatRoll) {
                    // Flat roll expected, flat roll received: accept
                } else if (expectsFlatRoll && !isFlatRoll) {
                    // Flat roll expected, but skill/ability/save rolled: mismatch
                    mismatch = true;
                    mismatchReason = 'Expected a flat d20 roll, but a skill/ability/save was rolled.';
                } else if (!expectsFlatRoll && isFlatRoll) {
                    // Skill/ability/save expected, but flat roll received: mismatch
                    mismatch = true;
                    mismatchReason = 'Expected a skill/ability/save, but a flat d20 roll was rolled.';
                } else if (!expectsFlatRoll && !isFlatRoll) {
                    // Both expected and rolled are skills/abilities/saves
                    if (expectedType !== rolledType) {
                        mismatch = true;
                        mismatchReason = `Expected '${expectedTypeRaw}', but got '${rolledTypeRaw}'.`;
                    }
                }

                if (mismatch) {
                    // Show GM menu for mismatch
                    const trapImg = token.get('imgsrc') ? `<img src='${token.get('imgsrc').replace(/\/[^\/]*$/, '/med.png')}' width='20' height='20'>` : '';
                    const trapName = token.get('name') && token.get('name') !== 'Unknown Token' ? token.get('name') : 'Unknown Token';
                    const gmMenu = `&{template:default} {{name=⚠️ Roll Skill Mismatch!}} {{Character=${pendingCheck.characterName || 'Unknown'}}} {{Trap=${trapImg} ${trapName}}} {{Expected=${expectedTypeRaw}}} {{Rolled=${rolledTypeRaw || 'Flat Roll'}}} {{Reason=${mismatchReason}}} {{Actions=[✅ Accept Roll](!trapsystem resolvemismatch ${pendingCheck.characterId || pendingCheck.playerid} ${token.id} accept ${roll.total} ${roll.rollType||'normal'} ${roll.isAdvantageRoll?'1':'0'}) [❌ Reject & Reroll](!trapsystem resolvemismatch ${pendingCheck.characterId || pendingCheck.playerid} ${token.id} reject) [ℹ️ Show Trap Status](!trapsystem status ${token.id})}}`;
                    TrapSystem.utils.whisperGM(gmMenu);
                    TrapSystem.utils.log(`Skill/ability/save mismatch detected: ${mismatchReason}`, 'warning');
                    return; // Do not process further until GM resolves
                }

                // Enhanced character verification (already partially handled by auth check in Strategy 1)
                const expectedCharId = pendingCheck.characterId; // This should now be reliable if a character was associated
                const actualCharId = roll.characterid; // This is what the roll is claiming to be for, or what we inferred

                if (expectedCharId && actualCharId && expectedCharId !== actualCharId) {
                    // This case should be rare now due to earlier checks, but good for safety.
                    TrapSystem.utils.whisperGM(`⚠️ Roll from character ${actualCharId} but pending check was for ${expectedCharId} (${pendingCheck.characterName}). Critical Mismatch. Ignoring.`);
                    return;
                }
                // If expectedCharId exists but actualCharId is somehow still null (e.g. generic check resolved to a char-specific one by fluke)
                // This path needs careful thought - for now, if expectedCharId is set, we assume the check IS for that char.

                if (roll.isAdvantageRoll) {
                    let menu = `&{template:default} {{name=${emoji} ${characterNameToDisplay} - ${skillType} Result}}`; // Added char name
                    menu += `{{Token=${tokenIcon} **${tokenName}**}}`;
                    menu += `{{First Roll=${roll.firstRoll}}}`;
                    menu += `{{Second Roll=${roll.secondRoll}}}`;
                    menu += `{{Final Roll=${roll.total}}}`;
                    if (TrapSystem.state.displayDCForCheck[playerid_of_roller] === true) {
                        menu += `{{DC=${check.dc}}}`;
                    }
                    const success = roll.total >= check.dc;
                    menu += success ? `{{Result=✅ Success!}}` : `{{Result=❌ Failure!}}`;
                    if (roll.rollType) {
                        menu += `{{Roll Type=${roll.rollType.charAt(0).toUpperCase() + roll.rollType.slice(1)}}}`;
                    }
                    sendChat("TrapSystem", menu);
                    if (success && config.success) TrapSystem.utils.executeMacro(config.success);
                    if (!success && config.failure) TrapSystem.utils.executeMacro(config.failure);

                    const newUses = Math.max(0, config.currentUses - 1);
                    if (newUses <= 0) {
                        TrapSystem.utils.updateTrapUses(token, 0, config.maxUses, false);
                        token.set("aura1_color", TrapSystem.config.AURA_COLORS.DISARMED);
                        TrapSystem.utils.chat('🔴 Trap depleted and auto-disarmed!');
                    } else {
                        TrapSystem.utils.updateTrapUses(token, newUses, config.maxUses, true);
                    }
                    // Cleanup the specific character's check from pendingChecksByChar
                    if (pendingCheck.characterId) delete TrapSystem.state.pendingChecksByChar[pendingCheck.characterId];
                    // Also cleanup the original initiator's pendingCheck from pendingChecks map
                    if (TrapSystem.state.pendingChecks[pendingCheck.playerid] === pendingCheck) {
                         delete TrapSystem.state.pendingChecks[pendingCheck.playerid];
                    }
                    TrapSystem.state.displayDCForCheck[playerid_of_roller] = false;
                    return;
                }

                // Manual rolls (firstRoll / secondRoll logic)
                if (pendingCheck.firstRoll === null && (advantage === 'advantage' || advantage === 'disadvantage')) {
                    pendingCheck.firstRoll = roll.total;
                    // Store the updated pendingCheck back if it was retrieved by characterId
                    if(pendingCheck.characterId) TrapSystem.state.pendingChecksByChar[pendingCheck.characterId] = pendingCheck;
                    // Also update the one keyed by the original playerid
                    TrapSystem.state.pendingChecks[pendingCheck.playerid] = pendingCheck; 

                    let menu = `&{template:default} {{name=🎲 ${characterNameToDisplay} - Waiting For Second Roll}}`;
                    menu += `{{First Roll=${roll.total}}}`;
                    menu += `{{Note=Please roll again for ${advantage}}}`;
                    sendChat("TrapSystem", menu);
                    return;
                }
                
                const finalTotal = advantage !== 'normal'
                    ? (advantage === 'advantage'
                        ? Math.max(pendingCheck.firstRoll, roll.total)
                        : Math.min(pendingCheck.firstRoll, roll.total))
                    : roll.total;

                let menu = `&{template:default} {{name=${emoji} ${characterNameToDisplay} - ${skillType} Result}}`;
                menu += `{{Token=${tokenIcon} **${tokenName}**}}`;
                if (advantage !== 'normal') {
                    menu += `{{First Roll=${pendingCheck.firstRoll}}}`;
                    menu += `{{Second Roll=${roll.total}}}`;
                    menu += `{{Roll Type=${advantage.charAt(0).toUpperCase() + advantage.slice(1)}}}`;
                }
                menu += `{{Final Roll=${finalTotal}}}`;
                if (TrapSystem.state.displayDCForCheck[playerid_of_roller] === true) {
                    menu += `{{DC=${check.dc}}}`;
                }
                const success = finalTotal >= check.dc;
                menu += success ? `{{Result=✅ Success!}}` : `{{Result=❌ Failure!}}`;
                sendChat("TrapSystem", menu);

                if (success && config.success) TrapSystem.utils.executeMacro(config.success);
                if (!success && config.failure) TrapSystem.utils.executeMacro(config.failure);

                const newUses = Math.max(0, config.currentUses - 1);
                if (newUses <= 0) {
                    TrapSystem.utils.updateTrapUses(token, 0, config.maxUses, false);
                    token.set("aura1_color", TrapSystem.config.AURA_COLORS.DISARMED);
                    TrapSystem.utils.chat('🔴 Trap depleted and auto-disarmed!');
                } else {
                    TrapSystem.utils.updateTrapUses(token, newUses, config.maxUses, true);
                }
                // Cleanup
                if (pendingCheck.characterId) delete TrapSystem.state.pendingChecksByChar[pendingCheck.characterId];
                if (TrapSystem.state.pendingChecks[pendingCheck.playerid] === pendingCheck) {
                     delete TrapSystem.state.pendingChecks[pendingCheck.playerid];
                }
                TrapSystem.state.displayDCForCheck[playerid_of_roller] = false;

            } catch (err) {
                TrapSystem.utils.log("Error in handleRollResult: " + err.message + " Stack: " + err.stack, 'error'); // Added stack
            }
        }
    }
};

// ---------------------------------------------------
// 7) ON READY
// ---------------------------------------------------
on("ready", () => {
    TrapSystem.utils.log("Trap System + Interaction Menu Ready!", 'success');
    sendChat("TrapSystem","/w GM 🎯 All features loaded! Use !trapsystem help or see your menu.");
});

// ---------------------------------------------------
// 8) TOKEN MOVEMENT HOOKS
// ---------------------------------------------------
on("change:graphic",(obj,prev) => {
    if(TrapSystem.state.lockedTokens[obj.id]) {
        obj.set({left:prev.left, top:prev.top});
        return;
    }
    if(prev.left!==obj.get("left")|| prev.top!==obj.get("top")) {
        TrapSystem.detector.checkTrapTrigger(obj, prev.left, prev.top);
    }
});

// If "blue" marker removed => remove {ignoretraps}
on("change:graphic",(obj,prev) => {
    if(prev.statusmarkers === obj.get("statusmarkers")) return;
    const cur = obj.get("statusmarkers") || "";
    const old = prev.statusmarkers || "";
    if(old.includes("blue") && !cur.includes("blue")) {
        let n = obj.get("gmnotes") || "";
        if(n.includes("{ignoretraps}")) {
            n = n.replace(/\{ignoretraps\}/, '');
            obj.set("gmnotes", n);
            TrapSystem.utils.chat(`Removed ignoretraps tag from ${obj.get("name")||"token"} (blue marker removed)`);
        }
    }
});

// ---------------------------------------------------
// 9) CHAT COMMANDS
// ---------------------------------------------------
on("chat:message",(msg) => {
    // Rolls from character sheets
    if(msg.type==="advancedroll") {
        try {
            TrapSystem.utils.log(`Received advancedroll message: ${JSON.stringify(msg)}`, 'debug');
            let rollType = null;
            if(msg.content.includes("dnd-2024__header--Advantage")) rollType="advantage";
            if(msg.content.includes("dnd-2024__header--Disadvantage")) rollType="disadvantage";
            if(msg.content.includes("dnd-2024__header--Normal")) rollType="normal";

            const re = /die__total[^>]*(?:data-result="(\d+)")?[^>]*>\s*(\d+)\s*</g;
            let dieMatches = msg.content.match(re);
            let dieResults = [];
            if(dieMatches) {
                dieMatches.forEach(m => {
                    let dr = m.match(/data-result="(\d+)"/);
                    let tr = m.match(/>\s*(\d+)\s*</);
                    if(dr) dieResults.push(parseInt(dr[1],10));
                    else if(tr) dieResults.push(parseInt(tr[1],10));
                });
            }
            if(dieResults.length>0) {
                // Try to find pending check by character ID first
                let pending = null;
                if (msg.characterId) { // Corrected: was msg.characterId in original FX version
                    pending = TrapSystem.state.pendingChecksByChar[msg.characterId];
                    if (pending) {
                        TrapSystem.utils.log(`Found pending check by character ID: ${msg.characterId}`, 'debug');
                    }
                }
                
                // If not found by character ID, try player ID
                if (!pending) {
                    pending = TrapSystem.state.pendingChecks[msg.playerid];
                    if (pending) {
                        TrapSystem.utils.log(`Found pending check by player ID: ${msg.playerid}`, 'debug');
                    }
                }

                if (!pending) {
                    TrapSystem.utils.log(`No pending check found for player:${msg.playerid} or character:${msg.characterId} from advancedroll`, 'debug');
                    return;
                }

                let total;
                const pref= msg.content.match(/die__total--preferred[^>]*data-result="(\d+)"/);
                if(pref) {
                    total = parseInt(pref[1],10);
                } else if(dieResults.length >= 2 && rollType) {
                    if(rollType==="advantage") total = Math.max(...dieResults);
                    else if(rollType==="disadvantage") total = Math.min(...dieResults);
                    else total = dieResults[0];
                } else {
                    total = dieResults[0];
                }

                // Extract rolled skill/ability/save from header
                let rolledSkillName = null;
                const titleMatch = msg.content.match(/<div class=\"header__title\">([^<]+)(?: Check| Save)?<\/div>/);
                if (titleMatch && titleMatch[1]) {
                    rolledSkillName = titleMatch[1].trim();
                    TrapSystem.utils.log(`Extracted rolled skill/ability from advancedroll: ${rolledSkillName}`, 'debug');
                }

                const rollData = {
                    total,
                    firstRoll: dieResults[0],
                    secondRoll: dieResults[1],
                    isAdvantageRoll: (dieResults.length >= 2),
                    rollType,
                    characterid: msg.characterId, // Ensure this is passed
                    playerid: msg.playerid,
                    rolledSkillName // <-- new field
                };
                TrapSystem.utils.log(`Processed advancedroll data: ${JSON.stringify(rollData)}`, 'debug');
                TrapSystem.interaction.handleRollResult(rollData, msg.playerid);
            }
        } catch(e) {
            TrapSystem.utils.log(`Error in advancedroll parse: ${e.message}`, 'error'); // Added .message
        }
        return;
    }
    if(msg.type==="rollresult") {
        try {
            TrapSystem.utils.log(`Received rollresult message: ${JSON.stringify(msg)}`, 'debug');
            const r = JSON.parse(msg.content);
            let rollTotal = null;

            if (r && typeof r.total !== 'undefined') {
                rollTotal = r.total;
            } else if (r && r.rolls && r.rolls.length > 0 && r.rolls[0].results && r.rolls[0].results.length > 0 && typeof r.rolls[0].results[0].v !== 'undefined') {
                rollTotal = r.rolls[0].results[0].v;
            }

            if (rollTotal !== null) {
                const rollData = {
                    total: rollTotal,
                    playerid: msg.playerid // This is playerid_of_roller
                    // characterid will be determined next
                };

                let charIdFromRoll = r.characterid || (r.rolls && r.rolls[0] && r.rolls[0].characterid);

                if (!charIdFromRoll && !playerIsGM(msg.playerid)) { 
                    const allCharacters = findObjs({ _type: "character" });
                    const controlledPlayerCharacters = allCharacters.filter(char => {
                        const controlledByArray = (char.get("controlledby") || "").split(",");
                        return controlledByArray.includes(msg.playerid) && controlledByArray.some(pId => pId && pId.trim() !== "" && !playerIsGM(pId));
                    });

                    if (controlledPlayerCharacters.length === 1) {
                        const uniqueChar = controlledPlayerCharacters[0];
                        rollData.characterid = uniqueChar.id; // Add characterid if uniquely determined
                        TrapSystem.utils.log(`Flat roll by player ${msg.playerid} auto-associated with single controlled character ${uniqueChar.get('name')} (ID: ${uniqueChar.id}) for rollData.`, 'debug');
                        // DO NOT modify pendingChecks here; handleRollResult will do the matching.
                    } else if (controlledPlayerCharacters.length > 1) {
                        TrapSystem.utils.log(`Flat roll by player ${msg.playerid} who controls multiple characters. rollData will not have characterid.`, 'debug');
                    } else {
                         TrapSystem.utils.log(`Flat roll by player ${msg.playerid} who controls no uniquely assignable characters for this roll. rollData will not have characterid.`, 'debug');
                    }
                } else if (charIdFromRoll) {
                    rollData.characterid = charIdFromRoll;
                }

                TrapSystem.utils.log(`Processed rollresult. Sending to handleRollResult: ${JSON.stringify(rollData)}`, 'debug');
                TrapSystem.interaction.handleRollResult(rollData, msg.playerid); // msg.playerid is playerid_of_roller
            } else {
                TrapSystem.utils.log(`Could not parse total from rollresult: ${msg.content}`, 'warning');
            }
        } catch(e) {
            TrapSystem.utils.log(`Error in rollresult parse: ${e.message}`, 'error'); // Added .message
        }
        return;
    }
    // If not an API command, ignore
    if(msg.type!=="api") return;

    const args = msg.content.match(/[^\s"]+|"([^"]*)"/g) || [];
    const command = args[0];
    if(command === "!trapsystem") {
        if(!args[1]) {
            TrapSystem.utils.showHelpMenu("API");
            return;
        }

        const action = args[1];
        
        // Most commands require a selected token
        if (!msg.selected || msg.selected.length === 0) {
            if (![
                "enable", "disable", "toggle", 
                "status", "help", "trigger", 
                "ignoretraps", "fail", "allowall"
            ].includes(action)) {
                TrapSystem.utils.chat('❌ Error: No token selected!');
                return;
            }
        }

        const selectedToken = msg.selected ? getObj("graphic", msg.selected[0]._id) : null;
        switch (action) {
            case "setup":
                TrapSystem.triggers.setupTrap(
                    selectedToken,
                    args[2], // uses
                    args[3], // mainMacro
                    args[4], // optional2
                    args[5], // optional3
                    args[6]  // movement
                );
                break;
            case "setupinteraction":
                if (args.length < 7) { // Minimum args for basic setup
                    TrapSystem.utils.chat('❌ Error: Missing parameters for setup interaction trap!');
                    return;
                }
                const uses = args[2];
                const successMacro = args[3];
                const failureMacro = args[4];
                let dc1Index = -1;
                let dc2Index = -1;
                // Find indices of DCs to correctly parse skill check names that might contain spaces
                let movementTriggerArgIndex = -1;
                for (let i = 5; i < args.length; i++) {
                    if (args[i].toLowerCase() === 'true' || args[i].toLowerCase() === 'false' || args[i].toLowerCase() === 'yes' || args[i].toLowerCase() === 'no') {
                        // Potential movement trigger argument
                        // To be more robust, check if the *next* arg is not a DC or another skill type
                        if (i + 1 >= args.length || isNaN(args[i+1])) { // If it's the last arg or next is not a DC
                           movementTriggerArgIndex = i;
                           break; // Found our movement trigger arg, stop looking for DCs past this
                        }
                    }
                    if (!isNaN(args[i])) {
                        if (dc1Index === -1) dc1Index = i;
                        else if (dc2Index === -1) { // Only set dc2Index if dc1Index is already set
                            dc2Index = i;
                            // Don't break here, movement trigger could still be after this
                        }
                    }
                }
                
                // Determine end of check2Type based on movementTriggerArgIndex or end of args
                let endOfCheck2TypeIndex = movementTriggerArgIndex !== -1 ? movementTriggerArgIndex : args.length;
                if (dc2Index !== -1) {
                     endOfCheck2TypeIndex = movementTriggerArgIndex !== -1 && movementTriggerArgIndex < dc2Index ? movementTriggerArgIndex : dc2Index;
                } else if (dc1Index !== -1) {
                    endOfCheck2TypeIndex = movementTriggerArgIndex !== -1 && movementTriggerArgIndex < dc1Index +1 ? movementTriggerArgIndex : dc1Index +1;
                }

                const check1Type = dc1Index !== -1 ? args.slice(5, dc1Index).join(' ') : 'None';
                const check1DC = dc1Index !== -1 ? args[dc1Index] : '10';
                
                let check2Type = 'None';
                let check2DC = '10';

                if (dc2Index !== -1) { // If a second DC was found
                    check2Type = args.slice(dc1Index + 1, dc2Index).join(' ');
                    check2DC = args[dc2Index];
                } else if (dc1Index !== -1 && movementTriggerArgIndex === -1 && args.length > dc1Index + 1 && isNaN(args[dc1Index+1])) {
                    // Case: One DC found, no explicit movement trigger, and there's more text that isn't a DC
                    // This assumes the remaining text is check2Type, and check2DC defaults
                    check2Type = args.slice(dc1Index + 1).join(' ');
                } else if (dc1Index !== -1 && movementTriggerArgIndex !== -1 && movementTriggerArgIndex > dc1Index +1 && isNaN(args[dc1Index+1])) {
                     // Case: One DC found, movement trigger later, stuff in between is check2Type
                    check2Type = args.slice(dc1Index + 1, movementTriggerArgIndex).join(' ');
                }

                let movementTriggerEnabled = true;
                if (movementTriggerArgIndex !== -1) {
                    const argVal = args[movementTriggerArgIndex].toLowerCase();
                    if (argVal === 'false' || argVal === 'no') {
                        movementTriggerEnabled = false;
                    }
                } else if (args.length > (dc2Index !==-1 ? dc2Index+1 : dc1Index+1) ){
                    // If there are args after the last DC and no explicit movement trigger was found,
                    // check if the very last argument is a boolean-like string for movement trigger
                    const lastArg = args[args.length -1].toLowerCase();
                    if (lastArg === 'false' || lastArg === 'no') {
                        movementTriggerEnabled = false;
                    }
                }

                TrapSystem.triggers.setupInteractionTrap(
                    selectedToken,
                    uses,
                    successMacro,
                    failureMacro,
                    check1Type || "None", // Ensure "None" if empty
                    check1DC,
                    check2Type || "None", // Ensure "None" if empty
                    check2DC,
                    movementTriggerEnabled
                );
                break;
            case "toggle": {
                const tid = args[2] || (selectedToken && selectedToken.id);
                if(!tid) {
                    TrapSystem.utils.chat('❌ No token selected or provided to toggle');
                    return;
                }
                const tk = getObj("graphic", tid);
                TrapSystem.triggers.toggleTrap(tk);
            } break;
            case "status": {
                const tid = args[2] || (selectedToken && selectedToken.id);
                if(!tid) {
                    TrapSystem.utils.chat('❌ No token selected or provided for status');
                    return;
                }
                const tk = getObj("graphic", tid);
                TrapSystem.triggers.getTrapStatus(tk);
            } break;
            case "allowmovement":
                const movementTokenId = args[2];
                if (movementTokenId === 'selected') {
                    if (!msg.selected || !msg.selected[0]) {
                        TrapSystem.utils.chat("❌ Error: No token selected!");
                        return;
                    }
                    TrapSystem.triggers.allowMovement(msg.selected[0]._id);
                } else if (movementTokenId) {
                    TrapSystem.triggers.allowMovement(movementTokenId);
                } else {
                    TrapSystem.utils.chat("❌ Error: No token specified!");
                }
                break;
            case "marktriggered":
                if(args[2] && args[3]) {
                    TrapSystem.triggers.markTriggered(args[2], args[3]);
                }
                break;
            case "enable":
                TrapSystem.triggers.enableTriggers();
                break;
            case "disable":
                TrapSystem.triggers.disableTriggers();
                break;
            case "trigger":
                if(!selectedToken) {
                    TrapSystem.utils.chat('❌ No token selected for trigger');
                    return;
                }
                TrapSystem.triggers.manualTrigger(selectedToken);
                break;
            case "ignoretraps":
                if(!selectedToken) {
                    TrapSystem.utils.chat('❌ No token selected for ignoretraps');
                    return;
                }
                TrapSystem.utils.toggleIgnoreTraps(selectedToken);
                break;
            case "showmenu":
                if(!selectedToken) {
                    TrapSystem.utils.chat('❌ No token selected for showmenu');
                    return;
                }
                TrapSystem.menu.showInteractionMenu(selectedToken);
                break;
            case "interact":
                if(args.length < 4) {
                    TrapSystem.utils.chat("❌ Missing parameters for interact");
                    return;
                }
                {
                    const intToken = getObj("graphic", args[2]);
                    if(!intToken) {
                        TrapSystem.utils.chat("❌ Invalid trap token ID!");
                        return;
                    }
                    TrapSystem.menu.handleInteraction(intToken, args[3], msg.playerid);
                }
                break;
            case "allow":
                if(args.length < 4) {
                    TrapSystem.utils.chat("❌ Missing parameters for allow command!");
                    return;
                }
                {
                    const allowToken = getObj("graphic", args[2]);
                    if(!allowToken) {
                        TrapSystem.utils.chat("❌ Invalid trap token ID!");
                        return;
                    }
                    TrapSystem.menu.handleAllowAction(allowToken, args[3]);
                }
                break;
            case "selectcharacter":
                if(args.length < 5) {
                    TrapSystem.utils.chat("❌ Missing parameters for selectcharacter!");
                    return;
                }
                {
                    const trapToken = getObj("graphic", args[2]);
                    const character = getObj("character", args[3]);
                    const playerid = args[4];
                    if(!trapToken || !character) {
                        TrapSystem.utils.chat("❌ Invalid token or character ID!");
                        return;
                    }
                    // Store character info in pendingChecks
                    if(!TrapSystem.state.pendingChecks[playerid]) {
                        TrapSystem.state.pendingChecks[playerid] = {};
                    }
                    TrapSystem.state.pendingChecks[playerid].characterId = character.id;
                    TrapSystem.state.pendingChecks[playerid].characterName = character.get("name");
                    
                    // Also store in the character-based map
                    TrapSystem.state.pendingChecksByChar[character.id] = {
                        ...TrapSystem.state.pendingChecks[playerid],
                        token: trapToken
                    };

                    TrapSystem.utils.log(`Stored character info - ID:${character.id}, Name:${character.get("name")}`, 'debug');

                    // Now show the skill check options
                    TrapSystem.menu.showGMResponseMenu(trapToken, playerid);
                }
                break;
            case "check":
                if(args.length < 5) {
                    TrapSystem.utils.chat("❌ Missing parameters for check command!");
                    return;
                }
                {
                    const cToken = getObj("graphic", args[2]);
                    if(!cToken) {
                        TrapSystem.utils.chat("❌ Invalid trap token ID!");
                        return;
                    }
                    TrapSystem.menu.handleSkillCheck(cToken, parseInt(args[3],10), args[4]);
                }
                break;
            case "customcheck":
                if(args.length<3) {
                    TrapSystem.utils.chat("❌ Missing parameters for customcheck command!");
                    return;
                }
                {
                    const cToken = getObj("graphic", args[2]);
                    if(!cToken) {
                        TrapSystem.utils.chat("❌ Invalid trap token ID!");
                        return;
                    }
                    TrapSystem.menu.handleCustomCheck(cToken, args[3]);
                }
                break;
            case "setcheck":
                if(args.length<5) {
                    TrapSystem.utils.chat("❌ Missing parameters for setcheck!");
                    return;
                }
                {
                    const sToken = getObj("graphic", args[2]);
                    if(!sToken) {
                        TrapSystem.utils.chat("❌ Invalid trap token ID!");
                        return;
                    }
                    TrapSystem.menu.handleSetCheck(sToken, args[3], args[4]);
                }
                break;
            case "rollcheck":
                if(args.length<6) {
                    TrapSystem.utils.chat("❌ Missing parameters for rollcheck!");
                    return;
                }
                {
                    const rToken = getObj("graphic", args[2]);
                    if(!rToken) {
                        TrapSystem.utils.chat("❌ Invalid trap token ID!");
                        return;
                    }
                    const mod = (args[6]) ? args[6] : 0;
                    TrapSystem.menu.handleRollCheck(rToken, args[3], args[4], args[5], mod);
                }
                break;
            case "setdc":
                if(args.length<5) {
                    TrapSystem.utils.chat("❌ Missing parameters for setdc command!");
                    return;
                }
                {
                    const dToken = getObj("graphic", args[2]);
                    if(!dToken) {
                        TrapSystem.utils.chat("❌ Invalid trap token ID!");
                        return;
                    }
                    TrapSystem.menu.handleSetDC(dToken, args[3], args[4], args[5]);
                }
                break;
            case "help": {
                TrapSystem.utils.showHelpMenu("TrapSystem");
            } break;
            case "fail":
                if (args.length < 4) {
                    TrapSystem.utils.chat("❌ Error: Missing parameters for fail command!");
                    return;
                }
                {
                    const failToken = getObj("graphic", args[2]);
                    if (!failToken) {
                        TrapSystem.utils.chat("❌ Error: Invalid trap token ID!");
                        return;
                    }
                    TrapSystem.triggers.handleFailAction(failToken, args[3]);
                    TrapSystem.triggers.getTrapStatus(failToken);
                }
                break;
            case "manualtrigger":
                if(args.length < 4) {
                    TrapSystem.utils.chat("❌ Missing parameters for manualtrigger!");
                    return;
                }
                TrapSystem.triggers.manualMacroTrigger(args[2], args[3]);
                break;
            case "displaydc":
                // args: !trapsystem displaydc trapToken.id checkIndex playerid
                if (args.length < 5) {
                    TrapSystem.utils.chat("❌ Missing parameters for displaydc!");
                    return;
                }
                {
                    const dToken = getObj("graphic", args[2]);
                    if(!dToken) {
                        TrapSystem.utils.chat("❌ Invalid trap token ID for displaydc!");
                        return;
                    }
                    // Call the dedicated handler
                    TrapSystem.menu.handleDisplayDC(dToken, args[3], args[4]);
                }
                break;
            case "allowall":
                TrapSystem.triggers.allowAllMovement();
                break;
            case "resolvemismatch": {
                // Usage: !trapsystem resolvemismatch [entityId] [trapTokenId] [accept|reject] [rollValueIfAccepted] [rollType] [isAdvantageRoll]
                const entityId = args[2]; // characterId or playerid
                const trapTokenId = args[3];
                const action = args[4];
                const rollValue = args[5] ? parseInt(args[5], 10) : null;
                const rollType = args[6] || 'normal';
                const isAdvantageRoll = args[7] === '1';
                let pendingCheck = TrapSystem.state.pendingChecksByChar[entityId] || TrapSystem.state.pendingChecks[entityId];
                const trapToken = getObj("graphic", trapTokenId);
                if (!pendingCheck || !trapToken) {
                    TrapSystem.utils.chat('❌ Could not resolve mismatch: missing pending check or trap token.');
                    return;
                }
                if (action === 'accept') {
                    // Process the roll as normal, using the provided roll value and rollType/advantage
                    const rollData = {
                        total: rollValue,
                        firstRoll: rollValue,
                        secondRoll: null,
                        isAdvantageRoll: isAdvantageRoll,
                        rollType: rollType,
                        characterid: pendingCheck.characterId,
                        playerid: pendingCheck.playerid,
                        rolledSkillName: pendingCheck.config.checks[0].type // treat as expected type
                    };
                    TrapSystem.utils.chat('✅ GM accepted the roll. Processing result...');
                    TrapSystem.interaction.handleRollResult(rollData, pendingCheck.playerid);
                } else if (action === 'reject') {
                    // Redisplay the "Skill Check Required" menu for the player
                    let playerid = pendingCheck.playerid;
                    let checkIndex = pendingCheck.checkIndex || 0;
                    let advantageType = pendingCheck.advantage || 'normal'; // Get original advantage type

                    // Call handleRollCheck to show the player the simpler prompt
                    TrapSystem.menu.handleRollCheck(trapToken, checkIndex, advantageType, playerid);
                }
                return;
            }
            default:
                TrapSystem.utils.chat(`❌ Unknown command: ${action}\nUse !trapsystem help for command list`);
        }
    }
});

// Cleanup trap visuals if GM notes no longer contain !traptrigger
on("change:graphic:gmnotes", (obj, prev) => {
    if (!obj || !prev) return;
    try {
        const currentNotes = obj.get("gmnotes");
        const decodedCurrentNotes = decodeURIComponent(currentNotes);
        TrapSystem.utils.log(`GM Notes Change - Current (decoded): ${decodedCurrentNotes}`, 'debug');
        TrapSystem.utils.log(`GM Notes Change - Previous: ${prev.gmnotes}`, 'debug');

        if (!currentNotes || !decodedCurrentNotes.includes("!traptrigger")) {
            if (prev.gmnotes && prev.gmnotes.includes("!traptrigger")) {
                obj.set({
                    bar1_value: null,
                    bar1_max: null,
                    showplayers_bar1: null,
                    aura1_color: null,
                    aura1_radius: null,
                    showplayers_aura1: null
                });
                TrapSystem.utils.log(`Removed trap visuals - GM notes removed`, 'info');
            }
            return;
        }
        if (!TrapSystem.utils.isTrap(obj)) return;
        
        const oldData = TrapSystem.utils.parseTrapNotes(prev.gmnotes);
        const newData = TrapSystem.utils.parseTrapNotes(decodedCurrentNotes);
        
        TrapSystem.utils.log(`Parsed old data: ${JSON.stringify(oldData)}`, 'debug');
        TrapSystem.utils.log(`Parsed new data: ${JSON.stringify(newData)}`, 'debug');

        if (!oldData || !newData) {
            TrapSystem.utils.log(`parseTrapNotes failed. oldData: ${!!oldData}, newData: ${!!newData}`, 'warning');
            return;
        }

        if (
            typeof newData.currentUses === "undefined" ||
            typeof newData.maxUses === "undefined" ||
            typeof newData.isArmed === "undefined"
        ) {
            TrapSystem.utils.log(`Parsed trap data missing fields: ${JSON.stringify(newData)}`, 'error');
            return;
        }

        if (oldData.currentUses !== newData.currentUses ||
            oldData.maxUses !== newData.maxUses ||
            oldData.isArmed !== newData.isArmed) {
            
            obj.set({
                bar1_value: newData.currentUses,
                bar1_max: newData.maxUses,
                showplayers_bar1: false,
                aura1_color: newData.isArmed && newData.currentUses > 0
                    ? (TrapSystem.state.triggersEnabled
                        ? TrapSystem.config.AURA_COLORS.ARMED
                        : TrapSystem.config.AURA_COLORS.PAUSED)
                    : TrapSystem.config.AURA_COLORS.DISARMED,
                aura1_radius: TrapSystem.config.AURA_SIZE,
                showplayers_aura1: false
            });
            TrapSystem.utils.log(`Updated trap visuals from GM notes change - Uses: ${newData.currentUses}/${newData.maxUses}, Armed: ${newData.isArmed}`, 'info');
        }
    } catch (err) {
        TrapSystem.utils.log(`Error handling GM notes change: ${err.message}`, 'error');
    }
});
