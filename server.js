const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const games = {}; // { roomId: { hostId, config, seats, players, roles, phase } }
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

    // Send current game state to the new player
    socket.emit('updateSeats', game.seats);
    socket.emit('updatePlayers', Object.values(game.players));
    socket.emit('gameConfig', game.config);

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
    io.to(roomId).emit('gameStarted', { phase: 'night' });

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

app.use(express.static('public'));

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
