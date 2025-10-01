const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const games = {}; // { roomId: { hostId, config, seats, players, roles, phase, nightActions, dayResults, rolePool, playerStates } }
const hostConfigs = {}; // Temporary storage for host configurations

// Game messages in multiple languages
const messages = {
  en: {
    nightStart: 'Everyone, close your eyes',
    werewolfPhase: 'Werewolves, open your eyes. Choose a player to kill.',
    werewolfClose: 'Werewolves, close your eyes',
    witchPhase: 'Witch, open your eyes',
    witchClose: 'Witch, close your eyes',
    seerPhase: 'Seer, open your eyes. Choose a player to check.',
    seerClose: 'Seer, close your eyes',
    hunterPhase: 'Hunter, open your eyes',
    hunterClose: 'Hunter, close your eyes',
    dayStart: 'Everyone, open your eyes',
    peacefulNight: 'Last night was a peaceful night',
    deathAnnouncement: 'Players who died last night'
  },
  zh: {
    nightStart: '天黑了，请大家闭眼',
    werewolfPhase: '狼人请睁眼，请选择一个玩家杀死',
    werewolfClose: '狼人请闭眼',
    witchPhase: '女巫请睁眼',
    witchClose: '女巫请闭眼',
    seerPhase: '预言家请睁眼，请选择一个玩家查验',
    seerClose: '预言家请闭眼',
    hunterPhase: '猎人请睁眼',
    hunterClose: '猎人请闭眼',
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

  // Add basic roles
  for (let i = 0; i < config.numWerewolves; i++) allRoles.push('werewolf');
  for (let i = 0; i < config.numVillagers; i++) allRoles.push('villager');

  // Add special roles
  config.specialRoles.forEach(role => allRoles.push(role));

  // Shuffle roles
  return allRoles.sort(() => Math.random() - 0.5);
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
    console.log('Game configured:', config);
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
  socket.on('joinGame', ({ roomId, name }, cb) => {
    const game = games[roomId];
    if (!game) {
      return cb({ success: false, message: 'Room not found' });
    }

    if (Object.keys(game.players).length >= game.config.totalPlayers) {
      return cb({ success: false, message: 'Room is full' });
    }

    game.players[socket.id] = {
      name,
      seat: null,
      role: null,
      isHost: socket.id === game.hostId
    };

    socket.join(roomId);

    cb({ success: true, message: 'Joined successfully!', isHost: socket.id === game.hostId });

    // Send current game state to the new player (gameConfig first, then updateSeats)
    socket.emit('gameConfig', game.config);
    socket.emit('updateSeats', game.seats);
    socket.emit('updatePlayers', Object.values(game.players));

    // If roles are already assigned, send role to this player
    if (game.roles[socket.id]) {
      socket.emit('roleAssigned', game.roles[socket.id]);
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

    // Remove player from previous seat if any
    const prevSeat = game.seats.find(s => s.player && s.player.id === socket.id);
    if (prevSeat) {
      prevSeat.player = null;
    }

    // Assign to new seat
    seat.player = {
      id: socket.id,
      name: game.players[socket.id].name
    };
    game.players[socket.id].seat = seatId;

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

    // Start night phase
    startNightPhase(roomId);

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

  // Werewolf action
  socket.on('werewolfKill', ({ roomId, targetId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'werewolf') {
      return cb({ success: false, message: 'Invalid action' });
    }

    game.nightActions.werewolfKill = targetId;
    cb({ success: true, message: 'Target selected' });

    // Hide UI for ALL werewolves
    const werewolves = Object.entries(game.players).filter(([id, player]) => player.role === 'werewolf');
    werewolves.forEach(([id]) => {
      io.to(id).emit('hideWerewolfUI');
    });

    // Notify everyone that werewolves close eyes and proceed to witch phase
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'werewolfClose') });

    setTimeout(() => startWitchPhase(roomId), 2000);
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

    // Don't auto-complete - wait for witch to confirm/complete their turn
  });

  socket.on('witchComplete', ({ roomId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'witch') {
      return cb({ success: false, message: 'Invalid action' });
    }

    // Notify everyone that witch closes eyes and proceed to seer phase
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'witchClose') });

    setTimeout(() => startSeerPhase(roomId), 2000);
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
      return cb({ success: false, message: 'Invalid action' });
    }

    // Notify everyone that seer closes eyes and proceed to hunter check phase
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'seerClose') });
    setTimeout(() => startHunterCheckPhase(roomId), 2000);

    cb({ success: true });
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

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    // Remove player from all games
    for (const roomId in games) {
      const game = games[roomId];
      if (game.players[socket.id]) {
        // Remove from seat
        const seat = game.seats.find(s => s.player && s.player.id === socket.id);
        if (seat) {
          seat.player = null;
        }

        // Remove from players
        delete game.players[socket.id];
        delete game.roles[socket.id];

        // Notify other players
        io.to(roomId).emit('updateSeats', game.seats);
        io.to(roomId).emit('updatePlayers', Object.values(game.players));

        // Update seats status
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

// Night Phase Functions
function startNightPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  // Announce night begins
  io.to(roomId).emit('nightPhaseStarted', { message: getMessage(roomId, 'nightStart') });

  // Start werewolf phase after a delay
  setTimeout(() => {
    startWerewolfPhase(roomId);
  }, 3000);
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
    // No werewolves, automatically skip to witch phase
    console.log(`[${roomId}] No werewolves present, skipping werewolf phase`);
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'werewolfClose') });
    setTimeout(() => startWitchPhase(roomId), 2000);
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
      setTimeout(() => {
        io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'witchClose') });
        setTimeout(() => startSeerPhase(roomId), 2000);
      }, 3000);
    }
  } else {
    // No witch, automatically skip to seer phase
    console.log(`[${roomId}] No witch present, skipping witch phase`);
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'witchClose') });
    setTimeout(() => startSeerPhase(roomId), 2000);
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
      setTimeout(() => {
        io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'seerClose') });
        setTimeout(() => startHunterCheckPhase(roomId), 2000);
      }, 3000);
    }
  } else {
    // No seer, automatically skip to hunter check phase
    console.log(`[${roomId}] No seer present, skipping seer phase`);
    io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'seerClose') });
    setTimeout(() => startHunterCheckPhase(roomId), 2000);
  }
}

function startHunterCheckPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  const hunters = Object.entries(game.players).filter(([id, player]) => player.role === 'hunter');

  if (hunters.length > 0) {
    // Check if any hunter is poisoned
    const poisonedHunters = hunters.filter(([id]) => game.nightActions.witchPoison === id);

    if (poisonedHunters.length > 0) {
      // Send audio message to ALL players
      io.to(roomId).emit('hunterPhaseAudio', {
        message: getMessage(roomId, 'hunterPhase') || 'Hunter, open your eyes'
      });

      // Send poison notification only to poisoned hunters
      poisonedHunters.forEach(([id]) => {
        // Mark hunter as poisoned in player states
        if (!game.playerStates[id]) {
          game.playerStates[id] = {};
        }
        game.playerStates[id].poisoned = true;

        io.to(id).emit('hunterPoisonNotification', {
          message: 'You have been poisoned! Your gun is disabled and you cannot use it during the day.'
        });
      });

      // Wait a moment then proceed to day phase
      setTimeout(() => {
        io.to(roomId).emit('phaseComplete', { message: getMessage(roomId, 'hunterClose') || 'Hunter, close your eyes' });
        setTimeout(() => startDayPhase(roomId), 2000);
      }, 4000);
    } else {
      // No poisoned hunters, go straight to day phase
      setTimeout(() => startDayPhase(roomId), 1000);
    }
  } else {
    // No hunters, automatically skip hunter phase
    console.log(`[${roomId}] No hunter present, skipping hunter phase`);
    setTimeout(() => startDayPhase(roomId), 1000);
  }
}

function startDayPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  // Calculate who died this night
  let deaths = [];

  if (game.nightActions.werewolfKill && !game.nightActions.witchSave) {
    deaths.push(game.nightActions.werewolfKill);
  }

  if (game.nightActions.witchPoison) {
    deaths.push(game.nightActions.witchPoison);
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
