const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const orphanManager = require('./orphanManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const games = {}; // { roomId: { hostId, config, seats, players, roles, phase, nightActions, dayResults, rolePool, playerStates } }
const hostConfigs = {}; // Temporary storage for host configurations

// Game messages in multiple languages
const messages = {
  en: {
    nightStart: 'Everyone, close your eyes',
    orphanPhase: 'Everyone open eyes, if you are orphan choose your father',
    orphanClose: 'Everyone close your eyes',
    cupidPhase: 'Cupid, open your eyes. Choose two players to be lovers.',
    cupidClose: 'Cupid, close your eyes',
    loversReveal: 'Everyone, open your eyes, check if you are selected as lovers',
    loversClose: 'Everyone, close your eyes',
    guardPhase: 'Guard, open your eyes. Choose a player to protect.',
    guardClose: 'Guard, close your eyes',
    werewolfPhase: 'Werewolves, open your eyes. Choose a player to kill.',
    werewolfClose: 'Werewolves, close your eyes',
    witchPhase: 'Witch, open your eyes',
    witchClose: 'Witch, close your eyes',
    seerPhase: 'Seer, open your eyes. Choose a player to check.',
    seerClose: 'Seer, close your eyes',
    hunterPhase: 'Hunter, open your eyes',
    hunterClose: 'Hunter, close your eyes',
    detectorElection: 'Everyone, open your eyes, raise your hand for detector election',
    dayStart: 'Everyone, open your eyes',
    peacefulNight: 'Last night was a peaceful night',
    deathAnnouncement: 'Players who died last night'
  },
  zh: {
    nightStart: '天黑了，请大家闭眼',
    orphanPhase: '所有人请睁眼，如果是孤儿请请选择你的父亲',
    orphanClose: '所有人请闭眼',
    cupidPhase: '丘比特请睁眼，请选择两个玩家成为恋人',
    cupidClose: '丘比特请闭眼',
    loversReveal: '请大家睁眼，看看自己是否被选为恋人',
    loversClose: '请大家闭眼',
    guardPhase: '守卫请睁眼，请选择一个玩家保护',
    guardClose: '守卫请闭眼',
    werewolfPhase: '狼人请睁眼，请选择一个玩家杀死',
    werewolfClose: '狼人请闭眼',
    witchPhase: '女巫请睁眼',
    witchClose: '女巫请闭眼',
    seerPhase: '预言家请睁眼，请选择一个玩家查验',
    seerClose: '预言家请闭眼',
    hunterPhase: '猎人请睁眼',
    hunterClose: '猎人请闭眼',
    detectorElection: '请大家睁眼，举手进行探测器选举',
    dayStart: '天亮了，请大家睁眼',
    peacefulNight: '昨夜是平安夜',
    deathAnnouncement: '昨夜死亡的玩家'
  }
};

function getMessage(gameId, messageKey) {
  const game = games[gameId];
  const language = game?.config?.language || 'en';
  return messages[language]?.[messageKey] || messages.en[messageKey];
}

function generateRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function createSeats(totalPlayers) {
  return Array.from({length: totalPlayers}, (_, i) => ({
    id: i + 1,
    player: null
  }));
}

function createRolePool(config) {
  const allRoles = [];

  // Add werewolves
  for (let i = 0; i < config.numWerewolves; i++) {
    allRoles.push('werewolf');
  }

  // Add orphans
  const numOrphans = config.numOrphans || 0;
  for (let i = 0; i < numOrphans; i++) {
    allRoles.push('orphan');
  }

  // Add special roles (these replace villagers)
  if (config.specialRoles && config.specialRoles.length > 0) {
    config.specialRoles.forEach(role => allRoles.push(role));
  }

  // Add remaining villagers
  for (let i = 0; i < config.numVillagers; i++) {
    allRoles.push('villager');
  }

  console.log(`[Role Pool Created] Total roles: ${allRoles.length}, Werewolves: ${config.numWerewolves}, Orphans: ${numOrphans}, Special: ${config.specialRoles?.length || 0}, Villagers: ${config.numVillagers}`);
  console.log(`[Role Pool Content]`, allRoles);

  // Shuffle roles
  const shuffledRoles = allRoles.sort(() => Math.random() - 0.5);
  console.log(`[Role Pool Shuffled]`, shuffledRoles);
  return shuffledRoles;
}

function assignRoleToPlayer(game, playerId) {
  // Initialize role pool if it doesn't exist
  if (!game.rolePool) {
    game.rolePool = createRolePool(game.config);
  }

  // Assign next role from pool
  if (game.rolePool.length > 0) {
    const role = game.rolePool.shift(); // Take first role from shuffled pool
    game.players[playerId].role = role;
    game.roles[playerId] = role;
    return role;
  }

  // Fallback to villager if pool is empty (shouldn't happen)
  game.players[playerId].role = 'villager';
  game.roles[playerId] = 'villager';
  return 'villager';
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Host configures game
  socket.on('configureGame', (config, cb) => {
    console.log('Game configured:', JSON.stringify(config, null, 2));
    console.log('Number of Orphans:', config.numOrphans);
    hostConfigs[socket.id] = config;
    cb({ success: true, message: 'Configuration saved!' });
  });

  // Host creates room after configuring
  socket.on('createGame', (cb) => {
    const config = hostConfigs[socket.id];
    if (!config) {
      return cb({ success: false, message: 'Please configure the game first' });
    }

    const roomId = generateRoomId();
    games[roomId] = {
      hostId: socket.id,
      config,
      seats: createSeats(config.totalPlayers),
      players: {},
      roles: {},
      phase: 'lobby',
    };

    socket.join(roomId);
    delete hostConfigs[socket.id]; // Clean up temp config

    cb({ success: true, roomId });
  });

  // Player sets name and joins room
  socket.on('joinGame', ({ roomId, name, sessionId }, cb) => {
    const game = games[roomId];
    if (!game) {
      return cb({ success: false, message: 'Room not found' });
    }

    let playerId = socket.id;
    let isReconnecting = false;

    // Check if this is a reconnection using sessionId
    if (sessionId) {
      // Look for existing player with this sessionId
      const existingPlayer = Object.entries(game.players).find(([id, player]) => player.sessionId === sessionId);
      if (existingPlayer) {
        const [oldSocketId, playerData] = existingPlayer;
        console.log(`[${roomId}] Player ${name} reconnecting with session ${sessionId}, old socket: ${oldSocketId}, new socket: ${socket.id}`);

        // Transfer player data to new socket ID
        delete game.players[oldSocketId];
        game.players[socket.id] = {
          ...playerData,
          isConnected: true,
          socketId: socket.id
        };

        // Transfer role data
        if (game.roles[oldSocketId]) {
          game.roles[socket.id] = game.roles[oldSocketId];
          delete game.roles[oldSocketId];
        }

        // Update seat player reference
        const seat = game.seats.find(s => s.player && s.player.id === oldSocketId);
        if (seat) {
          seat.player.id = socket.id;
          seat.player.isConnected = true;
        }

        isReconnecting = true;
        playerId = socket.id;
      }
    }

    // If not reconnecting, create new player
    if (!isReconnecting) {
      if (Object.keys(game.players).length >= game.config.totalPlayers) {
        return cb({ success: false, message: 'Room is full' });
      }

      const newSessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
      game.players[socket.id] = {
        name,
        seat: null,
        role: null,
        isHost: socket.id === game.hostId,
        sessionId: newSessionId,
        isConnected: true,
        socketId: socket.id
      };
    }

    socket.join(roomId);

    const message = isReconnecting ? 'Reconnected successfully!' : 'Joined successfully!';
    cb({
      success: true,
      message,
      isHost: game.players[socket.id].isHost,
      sessionId: game.players[socket.id].sessionId,
      isReconnecting
    });

    // Send current game state to the player
    socket.emit('gameConfig', game.config);
    socket.emit('updateSeats', game.seats);
    socket.emit('updatePlayers', Object.values(game.players));

    // If roles are already assigned, send role to this player
    if (game.roles[socket.id]) {
      socket.emit('roleAssigned', game.roles[socket.id]);
    }

    // Notify other players about the reconnection
    if (isReconnecting) {
      io.to(roomId).emit('updateSeats', game.seats);
      console.log(`[${roomId}] Player ${name} successfully reconnected`);
    }
  });

  // Player chooses a seat
  socket.on('chooseSeat', ({ roomId, seatId }, cb) => {
    const game = games[roomId];
    if (!game || !game.players[socket.id]) {
      return cb({ success: false, message: 'Invalid game or player' });
    }

    const seat = game.seats.find(s => s.id === seatId);
    if (!seat) {
      return cb({ success: false, message: 'Invalid seat' });
    }

    if (seat.player) {
      return cb({ success: false, message: 'Seat is already taken' });
    }

    // Check if player is already seated - prevent seat changes
    const prevSeat = game.seats.find(s => s.player && s.player.id === socket.id);
    if (prevSeat) {
      return cb({ success: false, message: 'You are already seated. Cannot change seats once seated.' });
    }

    // Assign to new seat (only if player wasn't already seated)
    seat.player = {
      id: socket.id,
      name: game.players[socket.id].name,
      isConnected: true // Mark as connected when initially seated
    };
    game.players[socket.id].seat = seatId;
    game.players[socket.id].isConnected = true; // Mark player as connected

    // Notify all players in the room
    io.to(roomId).emit('updateSeats', game.seats);

    // NEW: Assign role immediately when player is seated
    const assignedRole = assignRoleToPlayer(game, socket.id);

    // Notify the player of their role immediately
    socket.emit('roleAssigned', assignedRole);

    // Check if all seats are filled
    const filledSeats = game.seats.filter(s => s.player).length;
    const allSeatsFilled = filledSeats === game.config.totalPlayers;

    // If all seats are filled, notify everyone roles are complete
    if (allSeatsFilled) {
      io.to(roomId).emit('rolesAssigned', { message: 'All players are seated and roles assigned!' });
    }

    io.to(roomId).emit('seatsStatus', {
      filled: filledSeats,
      total: game.config.totalPlayers,
      allFilled: allSeatsFilled,
      rolesAssigned: Object.keys(game.roles).length > 0
    });

    cb({ success: true, message: 'Seated successfully!' });
  });

  // Host starts game (now just changes phase, doesn't assign roles)
  socket.on('startGame', (roomId, cb) => {
    const game = games[roomId];
    if (!game) {
      return cb({ success: false, message: 'Game not found' });
    }

    if (socket.id !== game.hostId) {
      return cb({ success: false, message: 'Only host can start the game' });
    }

    const filledSeats = game.seats.filter(s => s.player).length;
    // TESTING: Allow starting with at least 1 player instead of requiring all seats
    if (filledSeats < 1) {
      return cb({ success: false, message: 'At least 1 player is required to start' });
    }

    // Add fake players to fill empty seats for testing
    fillEmptySeatsWithFakePlayers(game);

    // NEW: Check if roles are assigned (only check if there are any players)
    if (filledSeats > 0 && Object.keys(game.roles).length === 0) {
      return cb({ success: false, message: 'Roles not assigned yet' });
    }

    game.phase = 'night';
    game.nightActions = {
      werewolfKill: null,
      witchSave: false,
      witchPoison: null,
      seerCheck: null,
      seerResult: null
    };
    game.dayResults = {
      deaths: [],
      survived: []
    };
    game.playerStates = {}; // Track special player states (poisoned, etc.)

    io.to(roomId).emit('gameStarted', { phase: 'night' });

    // Update seats to show fake players
    io.to(roomId).emit('updateSeats', game.seats);

    // Start with beforeNightStart phase (for orphan father selection)
    startBeforeNightStartPhase(roomId);

    cb({ success: true, message: 'Game started!' });
  });

  // Helper function to add fake players for testing
  function fillEmptySeatsWithFakePlayers(game) {
    const fakePlayerNames = [
      'Bot Alice', 'Bot Bob', 'Bot Charlie', 'Bot Diana', 'Bot Eve',
      'Bot Frank', 'Bot Grace', 'Bot Henry', 'Bot Iris', 'Bot Jack',
      'Bot Kate', 'Bot Leo', 'Bot Mia', 'Bot Noah', 'Bot Olivia'
    ];

    let fakePlayerIndex = 0;

    game.seats.forEach((seat, index) => {
      if (!seat.player && fakePlayerIndex < fakePlayerNames.length) {
        const fakePlayerId = `fake_${Date.now()}_${index}`;
        const fakeName = fakePlayerNames[fakePlayerIndex++];

        // Create fake player
        const fakePlayer = {
          id: fakePlayerId,
          name: fakeName,
          seat: seat.id,
          isFake: true
        };

        // Assign to seat
        seat.player = fakePlayer;

        // Add to players and assign role
        game.players[fakePlayerId] = fakePlayer;
        assignRoleToPlayer(game, fakePlayerId);
      }
    });
  }

  // Player wants to see their role
  socket.on('getMyRole', (roomId, cb) => {
    const game = games[roomId];
    if (game && game.players[socket.id]) {
      cb({
        success: true,
        role: game.players[socket.id].role
      });
    } else {
      cb({ success: false, message: 'Role not assigned yet' });
    }
  });

  // Orphan action - choosing father
  socket.on('orphanSelectFather', ({ roomId, fatherId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'orphan') {
      return cb({ success: false, message: 'Invalid action' });
    }

    if (!fatherId || fatherId === socket.id) {
      return cb({ success: false, message: 'Invalid father selection' });
    }

    // Store the orphan-father relationship
    orphanManager.setFather(roomId, socket.id, fatherId);

    cb({ success: true, message: 'Father selected' });

    // Check if all orphans have chosen fathers
    const allOrphans = Object.entries(game.players)
      .filter(([id, player]) => player.role === 'orphan' && !player.isFake)
      .map(([id]) => id);

    if (orphanManager.allOrphansChosen(roomId, allOrphans)) {
      // All orphans have chosen, proceed to night phase
      console.log(`[${roomId}] All orphans have chosen fathers, proceeding to night phase`);

      // Notify that orphans close their eyes
      io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'orphanClose') });

      // Wait a moment, then start night phase
      setTimeout(() => startNightPhase(roomId), 2000);
    }
  });

  // Get orphan-father map
  socket.on('getOrphanMap', ({ roomId }, cb) => {
    const game = games[roomId];
    if (!game) {
      return cb({ success: false, message: 'Game not found' });
    }

    // Get all orphan-father pairs
    const orphanFatherPairs = orphanManager.getAllPairs(roomId);

    // Convert IDs to player names and seat numbers
    const mapData = {};
    Object.entries(orphanFatherPairs).forEach(([orphanId, fatherId]) => {
      const orphan = game.players[orphanId];
      const father = game.players[fatherId];

      if (orphan && father) {
        mapData[orphanId] = {
          orphanName: orphan.name,
          orphanSeat: orphan.seat,
          fatherId: fatherId,
          fatherName: father.name,
          fatherSeat: father.seat
        };
      }
    });

    // Build chains using orphanManager
    const chains = orphanManager.buildOrphanChains(roomId, mapData);

    cb({ success: true, mapData, chains });
  });

  // Cupid action
  socket.on('cupidSelect', ({ roomId, targetIds }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'cupid') {
      return cb({ success: false, message: 'Invalid action' });
    }

    if (!targetIds || targetIds.length !== 2) {
      return cb({ success: false, message: 'Must select exactly 2 players' });
    }

    if (targetIds[0] === targetIds[1]) {
      return cb({ success: false, message: 'Cannot select the same player twice' });
    }

    // Set the lovers
    game.lovers = targetIds;

    // Mark cupid action as complete
    game.nightPhaseActions.cupid = true;

    cb({ success: true, message: 'Lovers selected' });

    // Notify that cupid is closing eyes
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'cupidClose') });

    // Wait a moment, then reveal lovers
    setTimeout(() => {
      // Tell everyone to open eyes and check if they're lovers
      io.to(roomId).emit('loversRevealPhase', { message: getMessage(roomId, 'loversReveal') });

      // Send lover information to the selected players
      targetIds.forEach(playerId => {
        const otherLover = targetIds.find(id => id !== playerId);
        const otherLoverName = game.players[otherLover]?.name || 'Unknown';
        io.to(playerId).emit('loverAssigned', {
          isLover: true,
          partnerName: otherLoverName,
          partnerId: otherLover
        });
      });

      // Wait 10 seconds, then tell everyone to close eyes and continue to next phase
      setTimeout(() => {
        io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'loversClose') });
        setTimeout(() => {
          // Check if guard exists, if so start guard phase, otherwise go to werewolf
          const hasGuard = Object.values(game.players).some(p => p.role === 'guard');
          if (hasGuard) {
            startGuardPhase(roomId);
          } else {
            game.nightPhaseActions.guard = true; // Mark as complete if no guard
            startWerewolfPhase(roomId);
          }
        }, 2000);
      }, 10000);
    }, 2000);
  });

  // Guard action
  socket.on('guardProtect', ({ roomId, targetId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'guard') {
      return cb({ success: false, message: 'Invalid action' });
    }

    game.nightActions.guardProtect = targetId;

    // Mark guard action as complete
    game.nightPhaseActions.guard = true;

    cb({ success: true, message: 'Player protected' });

    // Notify that guard is closing eyes
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'guardClose') });

    setTimeout(() => checkNightPhaseComplete(roomId), 2000);
  });

  // Werewolf action
  socket.on('werewolfKill', ({ roomId, targetId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'werewolf') {
      return cb({ success: false, message: 'Invalid action' });
    }

    game.nightActions.werewolfKill = targetId;

    // Mark werewolf action as complete
    game.nightPhaseActions.werewolf = true;

    cb({ success: true, message: 'Target selected' });

    // Hide UI for ALL werewolves
    const werewolves = Object.entries(game.players).filter(([id, player]) => player.role === 'werewolf');
    werewolves.forEach(([id]) => {
      io.to(id).emit('hideWerewolfUI');
    });

    // Notify everyone that werewolves close eyes and check for next phase
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'werewolfClose') });

    setTimeout(() => checkNightPhaseComplete(roomId), 2000);
  });

  // Witch actions - Enhanced: Cannot save themselves
  socket.on('witchSave', ({ roomId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'witch') {
      return cb({ success: false, message: 'Invalid action' });
    }

    // Check if witch is trying to save themselves
    if (game.nightActions.werewolfKill === socket.id) {
      return cb({ success: false, message: 'You cannot save yourself!' });
    }

    game.nightActions.witchSave = true;
    cb({ success: true, message: 'Player saved' });

    // Automatically end witch turn after saving someone
    setTimeout(() => {
      // Mark witch action as complete
      game.nightPhaseActions.witch = true;
      io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'witchClose') });
      setTimeout(() => startSeerPhase(roomId), 2000);
    }, 1000);
  });

  socket.on('witchPoison', ({ roomId, targetId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'witch') {
      return cb({ success: false, message: 'Invalid action' });
    }

    game.nightActions.witchPoison = targetId;
    cb({ success: true, message: 'Player poisoned' });

    // Automatically complete witch turn after using poison
    setTimeout(() => {
      // Mark witch action as complete
      game.nightPhaseActions.witch = true;

      // Notify everyone that witch closes eyes and check for next phase
      io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'witchClose') });
      setTimeout(() => checkNightPhaseComplete(roomId), 2000);
    }, 1000);
  });

  socket.on('witchComplete', ({ roomId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'witch') {
      return cb({ success: false, message: 'Invalid action' });
    }

    // Mark witch action as complete
    game.nightPhaseActions.witch = true;

    // Notify everyone that witch closes eyes and check for next phase
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'witchClose') });

    setTimeout(() => checkNightPhaseComplete(roomId), 2000);
    cb({ success: true });
  });

  // Seer action
  socket.on('seerCheck', ({ roomId, targetId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'seer') {
      return cb({ success: false, message: 'Invalid action' });
    }

    const targetPlayer = game.players[targetId];
    const isWerewolf = targetPlayer.role === 'werewolf';

    game.nightActions.seerCheck = targetId;
    game.nightActions.seerResult = isWerewolf ? 'werewolf' : 'good man';

    // Show result to seer
    io.to(socket.id).emit('seerResult', {
      targetName: targetPlayer.name,
      result: game.nightActions.seerResult
    });

    cb({ success: true, message: 'Check complete' });

    // Don't auto-proceed - wait for seer to confirm they've seen the result
  });

  // Seer confirms they've seen the result and want to proceed
  socket.on('seerComplete', ({ roomId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'seer') {
      if (cb) return cb({ success: false, message: 'Invalid action' });
      return;
    }

    // Mark seer action as complete
    game.nightPhaseActions.seer = true;

    // Notify everyone that seer closes eyes and check for next phase
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'seerClose') });
    setTimeout(() => checkNightPhaseComplete(roomId), 2000);

    if (cb) cb({ success: true });
  });

  // Hunter confirms their status and wants to proceed
  socket.on('hunterComplete', ({ roomId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'hunter') {
      if (cb) return cb({ success: false, message: 'Invalid action' });
      return;
    }

    // Mark hunter action as complete
    game.nightPhaseActions.hunter = true;

    // Notify everyone that hunter closes eyes and check for next phase
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'hunterClose') || 'Hunter, close your eyes' });
    setTimeout(() => checkNightPhaseComplete(roomId), 2000);

    if (cb) cb({ success: true });
  });

  // Host checks last night status
  socket.on('checkLastNight', ({ roomId }, cb) => {
    const game = games[roomId];
    if (!game || socket.id !== game.hostId) {
      return cb({ success: false, message: 'Only host can check status' });
    }

    const deaths = game.dayResults.deaths;
    let message;

    if (deaths.length === 0) {
      message = getMessage(roomId, 'peacefulNight');
    } else {
      const deadPlayers = deaths.map(id => game.players[id].name);
      const prefix = getMessage(roomId, 'deathAnnouncement');
      message = `${prefix}: ${deadPlayers.join(', ')}`;
    }

    cb({ success: true, message });
  });

  // Host shuffles roles (resets game and redistributes roles)
  socket.on('shuffleRoles', ({ roomId }, cb) => {
    const game = games[roomId];
    if (!game || socket.id !== game.hostId) {
      return cb({ success: false, message: 'Only host can shuffle roles' });
    }

    // Reset game state to lobby phase
    game.phase = 'lobby';
    game.nightActions = {};
    game.dayResults = {};
    game.playerStates = {};

    // Clear existing roles
    game.roles = {};
    game.rolePool = null; // This will force role pool recreation

    // Reassign roles to all seated players
    Object.keys(game.players).forEach(playerId => {
      const player = game.players[playerId];
      if (player.seat) { // Only reassign roles to seated players
        const newRole = assignRoleToPlayer(game, playerId);
        // Notify the player of their new role
        io.to(playerId).emit('roleAssigned', newRole);
      }
    });

    // Notify all players that roles have been shuffled
    io.to(roomId).emit('rolesShuffled', {
      message: 'Roles have been shuffled! Check your new role.'
    });

    // Update seats status
    const filledSeats = game.seats.filter(s => s.player).length;
    io.to(roomId).emit('seatsStatus', {
      filled: filledSeats,
      total: game.config.totalPlayers,
      allFilled: filledSeats === game.config.totalPlayers,
      rolesAssigned: Object.keys(game.roles).length > 0
    });

    cb({ success: true, message: 'Roles shuffled successfully!' });
  });

  // New clearer witch workflow handlers
  socket.on('witchSkip', ({ roomId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'witch') {
      return cb({ success: false, message: 'Invalid action' });
    }

    // Mark witch action as complete and end turn
    game.nightPhaseActions.witch = true;
    cb({ success: true, message: 'Witch skipped their turn' });

    // End witch turn
    setTimeout(() => {
      io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'witchClose') });
      setTimeout(() => checkNightPhaseComplete(roomId), 2000);
    }, 1000);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    // Mark player as disconnected but keep them in seat
    for (const roomId in games) {
      const game = games[roomId];
      if (game.players[socket.id]) {
        // Mark player as disconnected but keep them in their seat
        const seat = game.seats.find(s => s.player && s.player.id === socket.id);
        if (seat) {
          // Keep player in seat but mark as disconnected
          game.players[socket.id].isConnected = false;
          seat.player.isConnected = false;
        }

        // Keep player in players list but mark as disconnected
        game.players[socket.id].isConnected = false;
        // Keep roles assigned (don't delete game.roles[socket.id])

        console.log(`[${roomId}] Player ${game.players[socket.id].name} disconnected but kept in seat ${game.players[socket.id].seat}`);

        // Notify other players about the disconnection (but player stays in seat)
        io.to(roomId).emit('updateSeats', game.seats);
        io.to(roomId).emit('updatePlayers', Object.values(game.players));

        // Update seats status (seats remain filled, just mark as disconnected)
        const filledSeats = game.seats.filter(s => s.player).length;
        io.to(roomId).emit('seatsStatus', {
          filled: filledSeats,
          total: game.config.totalPlayers,
          allFilled: filledSeats === game.config.totalPlayers,
          rolesAssigned: Object.keys(game.roles).length > 0
        });

        // If host disconnects, end the game
        if (socket.id === game.hostId) {
          io.to(roomId).emit('hostDisconnected');
          delete games[roomId];
        }

        break;
      }
    }

    // Clean up temp configs
    delete hostConfigs[socket.id];
  });
});

// Before Night Start Phase - Orphan Father Selection
function startBeforeNightStartPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  // Get all orphans in the game
  const orphans = Object.entries(game.players).filter(([id, player]) => player.role === 'orphan');
  const orphanIds = orphans.map(([id]) => id);
  const realOrphans = orphans.filter(([id, player]) => !player.isFake);

  if (orphans.length === 0) {
    // No orphans, skip to night phase
    console.log(`[${roomId}] No orphans present, skipping beforeNightStart phase`);
    startNightPhase(roomId);
    return;
  }

  // Initialize orphan manager for this game
  orphanManager.initializeGame(roomId);

  // Announce orphan father selection phase to ALL players
  const orphanMessage = getMessage(roomId, 'orphanPhase') || 'Orphans, open your eyes and choose your father.';
  io.to(roomId).emit('orphanPhaseAudio', { message: orphanMessage });

  if (realOrphans.length > 0) {
    // Send UI only to real orphans
    realOrphans.forEach(([id]) => {
      io.to(id).emit('orphanPhaseUI', {
        players: Object.values(game.players)
          .filter(p => {
            const playerId = Object.keys(game.players).find(key => game.players[key] === p);
            return playerId !== id; // Can't choose themselves
          })
          .map(p => ({
            id: Object.keys(game.players).find(key => game.players[key] === p),
            name: p.name,
            seat: p.seat
          }))
      });
    });
  } else {
    // Only fake orphans, automatically complete orphan phase
    console.log(`[${roomId}] Only fake orphans present, auto-completing orphan phase`);
    setTimeout(() => {
      io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'orphanClose') || 'Orphans, close your eyes' });
      setTimeout(() => startNightPhase(roomId), 2000);
    }, 3000);
  }
}

// Night Phase Functions
function startNightPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  // Initialize night phase tracking
  game.nightPhaseActions = {
    cupid: false,
    guard: false,
    werewolf: false,
    witch: false,
    seer: false,
    hunter: false
  };

  // Initialize lovers tracking
  if (!game.lovers) {
    game.lovers = [];
  }

  // Announce night begins
  io.to(roomId).emit('nightPhaseStarted', { message: getMessage(roomId, 'nightStart') });

  // Check if cupid exists and start cupid phase first, otherwise go to werewolf
  setTimeout(() => {
    const hasCupid = Object.values(game.players).some(p => p.role === 'cupid');
    if (hasCupid) {
      startCupidPhase(roomId);
    } else {
      game.nightPhaseActions.cupid = true; // Mark as complete if no cupid
      startWerewolfPhase(roomId);
    }
  }, 3000);
}

// Function to check if all special characters have completed their actions
function checkNightPhaseComplete(roomId) {
  const game = games[roomId];
  if (!game) return;

  console.log(`[${roomId}] Night phase status:`, game.nightPhaseActions);

  // Always check werewolf completion first
  if (!game.nightPhaseActions.werewolf) {
    console.log(`[${roomId}] Werewolf has not completed yet`);
    return;
  }

  // Get which special characters exist in the game (excluding werewolf since we checked it above)
  const specialCharacters = getSpecialCharactersInGame(game);
  console.log(`[${roomId}] Special characters in game:`, specialCharacters);

  // Check if all existing special characters have completed their actions
  let allCompleted = true;
  for (const character of specialCharacters) {
    if (!game.nightPhaseActions[character]) {
      allCompleted = false;
      break;
    }
  }

  console.log(`[${roomId}] All special characters completed: ${allCompleted}`);

  if (allCompleted) {
    // All special characters have acted, proceed to detector election
    console.log(`[${roomId}] All special characters completed, starting detector election`);
    setTimeout(() => startDetectorElectionPhase(roomId), 2000);
  } else {
    // Find the next character that needs to act
    const nextCharacter = getNextCharacterToAct(game, specialCharacters);
    if (nextCharacter) {
      console.log(`[${roomId}] Next character to act: ${nextCharacter}`);
      setTimeout(() => startCharacterPhase(roomId, nextCharacter), 2000);
    }
  }
}

// Function to get all special characters that exist in the game
function getSpecialCharactersInGame(game) {
  const characters = [];
  const players = Object.values(game.players);

  // Include cupid first (cupid acts before everyone)
  if (players.some(p => p.role === 'cupid')) {
    characters.push('cupid');
  }

  // Include guard second (guard acts after cupid, before werewolf)
  if (players.some(p => p.role === 'guard')) {
    characters.push('guard');
  }

  // Include werewolf (werewolf acts after cupid and guard)
  characters.push('werewolf'); // Always include werewolf since it's tracked in nightPhaseActions

  // Check for witch
  if (players.some(p => p.role === 'witch')) {
    characters.push('witch');
  }

  // Check for seer
  if (players.some(p => p.role === 'seer')) {
    characters.push('seer');
  }

  // Check for hunter
  if (players.some(p => p.role === 'hunter')) {
    characters.push('hunter');
  }

  return characters;
}

// Function to get the next character that needs to act
function getNextCharacterToAct(game, specialCharacters) {
  const actionOrder = ['witch', 'seer', 'hunter'];

  for (const character of actionOrder) {
    if (specialCharacters.includes(character) && !game.nightPhaseActions[character]) {
      return character;
    }
  }

  return null;
}

// Function to start a specific character's phase
function startCharacterPhase(roomId, character) {
  switch (character) {
    case 'witch':
      startWitchPhase(roomId);
      break;
    case 'seer':
      startSeerPhase(roomId);
      break;
    case 'hunter':
      startHunterCheckPhase(roomId);
      break;
  }
}

function startCupidPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  const cupids = Object.entries(game.players).filter(([id, player]) => player.role === 'cupid');
  const realCupids = cupids.filter(([id, player]) => !player.isFake);

  if (cupids.length > 0) {
    // Send audio message to ALL players
    io.to(roomId).emit('cupidPhaseAudio', {
      message: getMessage(roomId, 'cupidPhase')
    });

    if (realCupids.length > 0) {
      // Send UI only to real cupids
      realCupids.forEach(([id]) => {
        io.to(id).emit('cupidPhaseUI', {
          players: Object.values(game.players).map(p => ({
            id: Object.keys(game.players).find(key => game.players[key] === p),
            name: p.name,
            seat: p.seat
          }))
        });
      });
    } else {
      // Only fake cupids, automatically complete cupid phase
      console.log(`[${roomId}] Only fake cupids present, auto-completing cupid phase`);
      game.nightPhaseActions.cupid = true;
      setTimeout(() => startWerewolfPhase(roomId), 2000);
    }
  } else {
    // No cupid, automatically mark cupid phase as complete
    console.log(`[${roomId}] No cupid present, marking cupid phase as complete`);
    game.nightPhaseActions.cupid = true;
    setTimeout(() => startWerewolfPhase(roomId), 2000);
  }
}

function startGuardPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  const guards = Object.entries(game.players).filter(([id, player]) => player.role === 'guard');
  const realGuards = guards.filter(([id, player]) => !player.isFake);

  if (guards.length > 0) {
    // Send audio message to ALL players
    io.to(roomId).emit('guardPhaseAudio', {
      message: getMessage(roomId, 'guardPhase')
    });

    if (realGuards.length > 0) {
      // Send UI only to real guards
      realGuards.forEach(([id]) => {
        io.to(id).emit('guardPhaseUI', {
          players: Object.values(game.players).map(p => ({
            id: Object.keys(game.players).find(key => game.players[key] === p),
            name: p.name,
            seat: p.seat
          }))
        });
      });
    } else {
      // Only fake guards, automatically complete guard phase
      console.log(`[${roomId}] Only fake guards present, auto-completing guard phase`);
      game.nightPhaseActions.guard = true;
      setTimeout(() => startWerewolfPhase(roomId), 2000);
    }
  } else {
    // No guard, automatically mark guard phase as complete
    console.log(`[${roomId}] No guard present, marking guard phase as complete`);
    game.nightPhaseActions.guard = true;
    setTimeout(() => startWerewolfPhase(roomId), 2000);
  }
}

function startWerewolfPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  const werewolves = Object.entries(game.players).filter(([id, player]) => player.role === 'werewolf');

  if (werewolves.length > 0) {
    // Send audio message to ALL players
    io.to(roomId).emit('werewolfPhaseAudio', {
      message: getMessage(roomId, 'werewolfPhase')
    });

    // Send UI only to werewolves
    werewolves.forEach(([id]) => {
      io.to(id).emit('werewolfPhaseUI', {
        players: Object.values(game.players).map(p => ({ id: Object.keys(game.players).find(key => game.players[key] === p), name: p.name, seat: p.seat }))
      });
    });
  } else {
    // No werewolves, automatically mark werewolf phase as complete
    console.log(`[${roomId}] No werewolves present, marking werewolf phase as complete`);
    game.nightPhaseActions.werewolf = true;
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'werewolfClose') });
    setTimeout(() => checkNightPhaseComplete(roomId), 2000);
  }
}

function startWitchPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  const witches = Object.entries(game.players).filter(([id, player]) => player.role === 'witch');
  const realWitches = witches.filter(([id, player]) => !player.isFake);

  if (witches.length > 0) {
    // Send audio message to ALL players
    io.to(roomId).emit('witchPhaseAudio', {
      message: getMessage(roomId, 'witchPhase')
    });

    if (realWitches.length > 0) {
      // Send UI only to real witches
      realWitches.forEach(([id]) => {
        io.to(id).emit('witchPhaseUI', {
          killedPlayer: game.nightActions.werewolfKill,
          players: Object.values(game.players).map(p => ({
            id: Object.keys(game.players).find(key => game.players[key] === p),
            name: p.name,
            seat: p.seat
          }))
        });
      });
    } else {
      // Only fake witches, automatically complete witch phase
      console.log(`[${roomId}] Only fake witches present, auto-completing witch phase`);
      game.nightPhaseActions.witch = true;
      setTimeout(() => {
        io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'witchClose') });
        setTimeout(() => checkNightPhaseComplete(roomId), 2000);
      }, 3000);
    }
  } else {
    // No witch, automatically mark witch phase as complete
    console.log(`[${roomId}] No witch present, marking witch phase as complete`);
    game.nightPhaseActions.witch = true;
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'witchClose') });
    setTimeout(() => checkNightPhaseComplete(roomId), 2000);
  }
}

function startSeerPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  const seers = Object.entries(game.players).filter(([id, player]) => player.role === 'seer');
  const realSeers = seers.filter(([id, player]) => !player.isFake);

  if (seers.length > 0) {
    // Send audio message to ALL players
    io.to(roomId).emit('seerPhaseAudio', {
      message: getMessage(roomId, 'seerPhase')
    });

    if (realSeers.length > 0) {
      // Send UI only to real seers
      realSeers.forEach(([id]) => {
        io.to(id).emit('seerPhaseUI', {
          players: Object.values(game.players).map(p => ({ id: Object.keys(game.players).find(key => game.players[key] === p), name: p.name, seat: p.seat }))
        });
      });
    } else {
      // Only fake seers, automatically complete seer phase
      console.log(`[${roomId}] Only fake seers present, auto-completing seer phase`);
      game.nightPhaseActions.seer = true;
      setTimeout(() => {
        io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'seerClose') });
        setTimeout(() => checkNightPhaseComplete(roomId), 2000);
      }, 3000);
    }
  } else {
    // No seer, automatically mark seer phase as complete
    console.log(`[${roomId}] No seer present, marking seer phase as complete`);
    game.nightPhaseActions.seer = true;
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'seerClose') });
    setTimeout(() => checkNightPhaseComplete(roomId), 2000);
  }
}

function startHunterCheckPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  const hunters = Object.entries(game.players).filter(([id, player]) => player.role === 'hunter');
  const realHunters = hunters.filter(([id, player]) => !player.isFake);

  if (hunters.length > 0) {
    // Send audio message to ALL players
    io.to(roomId).emit('hunterPhaseAudio', {
      message: getMessage(roomId, 'hunterPhase') || 'Hunter, open your eyes'
    });

    if (realHunters.length > 0) {
      // Send UI to ALL real hunters (both poisoned and not poisoned)
      realHunters.forEach(([id]) => {
        const isPoisoned = game.nightActions.witchPoison === id;

        // Mark hunter as poisoned in player states if they are poisoned
        if (isPoisoned) {
          if (!game.playerStates[id]) {
            game.playerStates[id] = {};
          }
          game.playerStates[id].poisoned = true;
        }

        io.to(id).emit('hunterPhaseUI', {
          isPoisoned: isPoisoned,
          message: isPoisoned
            ? 'You have been poisoned! Your gun is disabled and you cannot use it during the day.'
            : 'You can use your gun during the day if needed.'
        });
      });
    } else {
      // Only fake hunters, automatically complete hunter phase
      console.log(`[${roomId}] Only fake hunters present, auto-completing hunter phase`);
      game.nightPhaseActions.hunter = true;
      setTimeout(() => {
        io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'hunterClose') || 'Hunter, close your eyes' });
        setTimeout(() => checkNightPhaseComplete(roomId), 2000);
      }, 3000);
    }
  } else {
    // No hunters, automatically mark hunter phase as complete
    console.log(`[${roomId}] No hunter present, marking hunter phase as complete`);
    game.nightPhaseActions.hunter = true;
    // Still announce the hunter phase close message for consistency
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'hunterClose') || 'Hunter, close your eyes' });
    setTimeout(() => checkNightPhaseComplete(roomId), 2000);
  }
}

function startDetectorElectionPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  // Send detector election announcement to ALL players
  io.to(roomId).emit('detectorElectionPhase', {
    message: getMessage(roomId, 'detectorElection')
  });

  // Wait for the detector election announcement to complete, then proceed to day phase
  setTimeout(() => {
    startDayPhase(roomId);
  }, 3000);
}

function startDayPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  // Calculate who died this night
  let deaths = [];

  // Check werewolf kill (must not be saved by witch AND not protected by guard)
  if (game.nightActions.werewolfKill &&
      !game.nightActions.witchSave &&
      game.nightActions.werewolfKill !== game.nightActions.guardProtect) {
    deaths.push(game.nightActions.werewolfKill);
  }

  if (game.nightActions.witchPoison) {
    deaths.push(game.nightActions.witchPoison);
  }

  // Check for lover deaths - if one lover dies, the other also dies from heartbreak
  if (game.lovers && game.lovers.length === 2) {
    const [lover1, lover2] = game.lovers;

    // Check if either lover is in the current deaths list
    const lover1Died = deaths.includes(lover1);
    const lover2Died = deaths.includes(lover2);

    if (lover1Died && !lover2Died) {
      // Lover 1 died, lover 2 dies from heartbreak
      deaths.push(lover2);
      console.log(`[${roomId}] Lover ${game.players[lover1]?.name} died, ${game.players[lover2]?.name} dies from heartbreak`);
    } else if (lover2Died && !lover1Died) {
      // Lover 2 died, lover 1 dies from heartbreak
      deaths.push(lover1);
      console.log(`[${roomId}] Lover ${game.players[lover2]?.name} died, ${game.players[lover1]?.name} dies from heartbreak`);
    }
  }

  game.dayResults.deaths = deaths;
  game.phase = 'day';

  // Announce day begins
  io.to(roomId).emit('dayPhaseStarted', {
    message: getMessage(roomId, 'dayStart'),
    deaths: deaths
  });
}


app.use(express.static('public'));

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
