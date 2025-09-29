# 🐺 Werewolves Game

A simple web application for playing Werewolves with friends! This multiplayer party game supports 6-16 players with real-time audio narration in English or Chinese.

## 🎮 Game Features

- **6-16 Players**: Flexible player count for different group sizes
- **Real-time Multiplayer**: Built with Socket.io for instant updates
- **Audio Narration**: Text-to-speech game narrator in English or Chinese
- **Role-based Gameplay**: Werewolves, Villagers, and special roles (Seer, Witch, Hunter, etc.)
- **Night/Day Phases**: Authentic werewolves game experience
- **Host Controls**: Game configuration and management tools

## 🛠️ Local Setup

### Prerequisites

You need to have Node.js and npm installed on your computer.

#### Installing Node.js and npm

1. **Visit the official Node.js website**: Go to https://nodejs.org/
2. **Download the LTS version**: Choose the "LTS" (Long Term Support) version for stability
3. **Install Node.js**: Run the downloaded installer and follow the setup wizard
4. **Verify installation**: Open your terminal/command prompt and run:
   ```bash
   node --version
   npm --version
   ```
   You should see version numbers for both commands.

### Project Setup

1. **Clone or download this project** to your local machine

2. **Navigate to the project directory**:
   ```bash
   cd werevolves
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```
   This will install all required packages including:
   - express (web server)
   - socket.io (real-time communication)

4. **Start the server**:
   ```bash
   node server.js
   ```

5. **Open your web browser** and go to:
   ```
   http://localhost:3000
   ```

That's it! The game should now be running locally on your computer.

## 🎯 How to Play

### For the Host:

1. **Configure Game**: Choose language (English/Chinese), player count (6-16), and roles
2. **Create Room**: Get a unique room code to share with players
3. **Wait for Players**: Players join using the room code
4. **Start Game**: Begin when all seats are filled and roles are assigned

### For Players:

1. **Join Game**: Enter your name and the room code provided by the host
2. **Choose Seat**: Select an available seat in the game lobby
3. **Check Role**: View your assigned role once all players have joined
4. **Follow Audio**: Listen to the narrator during night phases
5. **Take Actions**: Use the interface when it's your role's turn

## 🌟 Game Roles

- **🐺 Werewolves**: Kill villagers during the night
- **👨‍🌾 Villagers**: Find and eliminate werewolves during the day
- **🔮 Seer**: Check one player's identity each night
- **🧙‍♀️ Witch**: Has a healing potion and poison potion
- **🏹 Hunter**: Can eliminate another player when killed
- **🃏 Fool**: Wins if voted out by villagers
- **🛡️ Guard**: Protects one player each night
- **💘 Cupid**: Links two players in love

## 🔧 Technical Details

- **Backend**: Node.js with Express.js
- **Real-time Communication**: Socket.io
- **Frontend**: Vanilla HTML, CSS, JavaScript
- **Audio**: Web Speech API for text-to-speech
- **Languages**: English and Chinese (Simplified) support

## 🚀 Deployment

To run this on a server for remote play, you'll need to:

1. Deploy to a hosting service (Heroku, AWS, DigitalOcean, etc.)
2. Update the port configuration if needed
3. Ensure your hosting service supports WebSocket connections

## 🤝 Contributing

Feel free to submit issues, feature requests, or pull requests to improve the game!

## 📝 License

This project is open source and available under the MIT License.

---

**Enjoy playing Werewolves with your friends!** 🐺🌙
