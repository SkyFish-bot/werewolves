const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const games = {}; // { roomId: { hostId, config, seats, players, roles, phase, nightActions, dayResults } }
const hostConfigs = {}; // Temporary storage for host configurations

function generateRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function createSeats(totalPlayers) {
  return Array.from({length: totalPlayers}, (_, i) => ({
    id: i + 1,
    player: null
  }));
}

function assignRoles(game) {
  const { config, players } = game;
  const allRoles = [];

  // Add basic roles
  for (let i = 0; i < config.numWerewolves; i++) allRoles.push('werewolf');
  for (let i = 0; i < config.numVillagers; i++) allRoles.push('villager');

  // Add special roles
  config.specialRoles.forEach(role => allRoles.push(role));

  // Shuffle roles
  const shuffledRoles = allRoles.sort(() => Math.random() - 0.5);

  // Assign to players
  const playerIds = Object.keys(players);
  playerIds.forEach((playerId, index) => {
    players[playerId].role = shuffledRoles[index] || 'villager';
    game.roles[playerId] = shuffledRoles[index] || 'villager';
  });
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

    // Check if all seats are filled
    const filledSeats = game.seats.filter(s => s.player).length;
    const allSeatsFilled = filledSeats === game.config.totalPlayers;

    // NEW: Assign roles as soon as all seats are filled
    if (allSeatsFilled && Object.keys(game.roles).length === 0) {
      assignRoles(game);

      // Notify each player of their role
      Object.entries(game.players).forEach(([playerId, player]) => {
        io.to(playerId).emit('roleAssigned', player.role);
      });

      io.to(roomId).emit('rolesAssigned', { message: 'All roles have been assigned! You can now check your role.' });
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
    if (filledSeats !== game.config.totalPlayers) {
      return cb({ success: false, message: 'Not all seats are filled' });
    }

    // NEW: Check if roles are assigned
    if (Object.keys(game.roles).length === 0) {
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

    io.to(roomId).emit('gameStarted', { phase: 'night' });

    // Start night phase
    startNightPhase(roomId);

    cb({ success: true, message: 'Game started!' });
  });

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

    // Notify everyone that werewolves close eyes and proceed to witch phase
    io.to(roomId).emit('phaseComplete', { message: 'Werewolves, close your eyes' });

    setTimeout(() => startWitchPhase(roomId), 2000);
  });

  // Witch actions
  socket.on('witchSave', ({ roomId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'witch') {
      return cb({ success: false, message: 'Invalid action' });
    }

    game.nightActions.witchSave = true;
    cb({ success: true, message: 'Player saved' });
  });

  socket.on('witchPoison', ({ roomId, targetId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'witch') {
      return cb({ success: false, message: 'Invalid action' });
    }

    game.nightActions.witchPoison = targetId;
    cb({ success: true, message: 'Player poisoned' });
  });

  socket.on('witchComplete', ({ roomId }, cb) => {
    const game = games[roomId];
    if (!game || game.players[socket.id].role !== 'witch') {
      return cb({ success: false, message: 'Invalid action' });
    }

    // Notify everyone that witch closes eyes and proceed to seer phase
    io.to(roomId).emit('phaseComplete', { message: 'Witch, close your eyes' });

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

    // Notify everyone that seer closes eyes and proceed to day phase
    setTimeout(() => {
      io.to(roomId).emit('phaseComplete', { message: 'Seer, close your eyes' });
      setTimeout(() => startDayPhase(roomId), 2000);
    }, 3000);
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
      message = 'Last night was a peaceful night';
    } else {
      const deadPlayers = deaths.map(id => game.players[id].name);
      message = `Players who died last night: ${deadPlayers.join(', ')}`;
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
  io.to(roomId).emit('nightPhaseStarted', { message: 'Everyone, close your eyes' });

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
      message: 'Werewolves, open your eyes. Choose a player to kill.'
    });

    // Send UI only to werewolves
    werewolves.forEach(([id]) => {
      io.to(id).emit('werewolfPhaseUI', {
        players: Object.values(game.players).map(p => ({ id: Object.keys(game.players).find(key => game.players[key] === p), name: p.name, seat: p.seat }))
      });
    });
  } else {
    // No werewolves, skip to witch phase
    setTimeout(() => startWitchPhase(roomId), 2000);
  }
}

function startWitchPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  const witches = Object.entries(game.players).filter(([id, player]) => player.role === 'witch');

  if (witches.length > 0) {
    // Send audio message to ALL players
    io.to(roomId).emit('witchPhaseAudio', {
      message: 'Witch, open your eyes'
    });

    // Send UI only to witch
    witches.forEach(([id]) => {
      io.to(id).emit('witchPhaseUI', {
        killedPlayer: game.nightActions.werewolfKill,
        players: Object.values(game.players).map(p => ({ id: Object.keys(game.players).find(key => game.players[key] === p), name: p.name, seat: p.seat }))
      });
    });
  } else {
    // No witch, skip to seer phase
    setTimeout(() => startSeerPhase(roomId), 2000);
  }
}

function startSeerPhase(roomId) {
  const game = games[roomId];
  if (!game) return;

  const seers = Object.entries(game.players).filter(([id, player]) => player.role === 'seer');

  if (seers.length > 0) {
    // Send audio message to ALL players
    io.to(roomId).emit('seerPhaseAudio', {
      message: 'Seer, open your eyes. Choose a player to check.'
    });

    // Send UI only to seer
    seers.forEach(([id]) => {
      io.to(id).emit('seerPhaseUI', {
        players: Object.values(game.players).map(p => ({ id: Object.keys(game.players).find(key => game.players[key] === p), name: p.name, seat: p.seat }))
      });
    });
  } else {
    // No seer, go to day phase
    setTimeout(() => startDayPhase(roomId), 2000);
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
    message: 'Everyone, open your eyes',
    deaths: deaths
  });
}


app.use(express.static('public'));

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
