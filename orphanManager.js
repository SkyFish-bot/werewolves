// Orphan Manager Module
// Manages orphan-father relationships in the game

class OrphanManager {
  constructor() {
    // Map structure: { gameId: { orphanPlayerId: fatherPlayerId } }
    this.orphanFatherMap = {};
  }

  // Initialize a new game's orphan-father mapping
  initializeGame(gameId) {
    if (!this.orphanFatherMap[gameId]) {
      this.orphanFatherMap[gameId] = {};
    }
  }

  // Set father for an orphan
  setFather(gameId, orphanPlayerId, fatherPlayerId) {
    if (!this.orphanFatherMap[gameId]) {
      this.initializeGame(gameId);
    }
    this.orphanFatherMap[gameId][orphanPlayerId] = fatherPlayerId;
  }

  // Get father for an orphan
  getFather(gameId, orphanPlayerId) {
    return this.orphanFatherMap[gameId]?.[orphanPlayerId] || null;
  }

  // Get all orphans for a game
  getOrphans(gameId) {
    if (!this.orphanFatherMap[gameId]) {
      return [];
    }
    return Object.keys(this.orphanFatherMap[gameId]);
  }

  // Get all orphan-father pairs for a game
  getAllPairs(gameId) {
    return this.orphanFatherMap[gameId] || {};
  }

  // Check if an orphan has chosen a father
  hasChosenFather(gameId, orphanPlayerId) {
    return !!this.orphanFatherMap[gameId]?.[orphanPlayerId];
  }

  // Check if all orphans in a game have chosen fathers
  allOrphansChosen(gameId, orphanPlayerIds) {
    if (!orphanPlayerIds || orphanPlayerIds.length === 0) {
      return true; // No orphans, so all are "chosen"
    }

    return orphanPlayerIds.every(orphanId => this.hasChosenFather(gameId, orphanId));
  }

  // Clear orphan-father mappings for a game
  clearGame(gameId) {
    delete this.orphanFatherMap[gameId];
  }

  // Remove a specific orphan's father choice
  removeOrphan(gameId, orphanPlayerId) {
    if (this.orphanFatherMap[gameId]) {
      delete this.orphanFatherMap[gameId][orphanPlayerId];
    }
  }

  // Build orphan chains and detect loops
  buildOrphanChains(gameId, mapData) {
    const chains = [];
    const visited = new Set();

    // For each orphan, build a chain
    for (const orphanId in mapData) {
      if (visited.has(orphanId)) continue;

      const chain = {
        nodes: [],
        hasLoop: false,
        text: ''
      };

      const pathSet = new Set();
      let currentId = orphanId;

      // Follow the chain
      while (currentId && mapData[currentId]) {
        const data = mapData[currentId];

        // Check if we've seen this node in the current path (loop detection)
        if (pathSet.has(currentId)) {
          chain.hasLoop = true;
          break;
        }

        pathSet.add(currentId);
        visited.add(currentId);

        chain.nodes.push({
          id: currentId,
          name: data.orphanName,
          seat: data.orphanSeat
        });

        // Move to father
        currentId = data.fatherId;
      }

      // Add the final person (father who isn't an orphan)
      if (currentId && !mapData[currentId] && chain.nodes.length > 0) {
        const lastNode = chain.nodes[chain.nodes.length - 1];
        const fatherData = mapData[lastNode.id];
        if (fatherData) {
          chain.nodes.push({
            id: fatherData.fatherId,
            name: fatherData.fatherName,
            seat: fatherData.fatherSeat
          });
        }
      }

      // Build text representation
      chain.text = chain.nodes.map(node => `${node.name} (Seat ${node.seat})`).join(' → ');

      // If there's a loop, append loop indicator
      if (chain.hasLoop) {
        chain.text += ' → [LOOP]';
      }

      if (chain.nodes.length > 0) {
        chains.push(chain);
      }
    }

    return chains;
  }
}

// Export singleton instance
module.exports = new OrphanManager();
