const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const mineflayer = require('mineflayer');
const net = require('net');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Storage for bots
const bots = new Map();
const botIntervals = new Map();
const botLogs = new Map(); // Storage for bot logs

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Helper function to add log entry
function addLogEntry(botId, type, message) {
    if (!botLogs.has(botId)) {
        botLogs.set(botId, []);
    }
    
    const entry = {
        timestamp: Date.now(),
        type: type,
        message: message
    };
    
    botLogs.get(botId).push(entry);
    
    // Keep only last 500 logs
    const logs = botLogs.get(botId);
    if (logs.length > 500) {
        logs.splice(0, logs.length - 500);
    }
    
    // Emit to clients
    io.emit('newLogEntry', { botId, entry });
}

// Funkcja do automatycznego wykrywania wersji serwera
async function detectServerVersion(host, port) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Timeout podczas wykrywania wersji'));
        }, 10000);

        try {
            // Użyj mineflayer do sprawdzenia informacji o serwerze
            const pingBot = mineflayer.createBot({
                host: host,
                port: port,
                username: 'temp_ping_bot',
                auth: 'offline',
                skipValidation: true,
                hideErrors: true,
                version: false // Pozwoli automatycznie wykryć wersję
            });

            pingBot.once('login', () => {
                clearTimeout(timeout);
                const detectedVersion = pingBot.version;
                console.log(`🔍 Wykryto wersję serwera ${host}:${port} - ${detectedVersion}`);
                pingBot.quit();
                resolve(detectedVersion);
            });

            pingBot.on('error', (err) => {
                clearTimeout(timeout);
                console.log(`❌ Błąd podczas wykrywania wersji: ${err.message}`);
                // Jeśli nie udało się wykryć, spróbuj z popularnymi wersjami
                const commonVersions = ['1.20.1', '1.19.4', '1.18.2', '1.16.5', '1.12.2'];
                resolve(commonVersions[0]); // Domyślnie najnowsza popularna wersja
            });

            pingBot.on('end', () => {
                clearTimeout(timeout);
            });

        } catch (error) {
            clearTimeout(timeout);
            console.log(`❌ Błąd podczas tworzenia ping bota: ${error.message}`);
            reject(error);
        }
    });
}

// Alternatywna funkcja ping używająca protokołu ping Minecraft
async function pingServer(host, port) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection({ host, port }, () => {
            // Handshake packet
            const handshakeData = Buffer.concat([
                Buffer.from([0x00]), // Packet ID
                Buffer.from([0x00]), // Protocol version (0 = ping)
                Buffer.from([host.length]), // Host length
                Buffer.from(host, 'utf8'), // Host
                Buffer.from([port >> 8, port & 0xFF]), // Port
                Buffer.from([0x01]) // Next state (status)
            ]);
            
            const handshakePacket = Buffer.concat([
                Buffer.from([handshakeData.length]), // Length
                handshakeData
            ]);
            
            client.write(handshakePacket);
            
            // Status request packet
            const statusRequest = Buffer.from([0x01, 0x00]); // Length = 1, Packet ID = 0
            client.write(statusRequest);
        });

        let buffer = Buffer.alloc(0);
        
        client.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
            
            try {
                if (buffer.length > 5) {
                    // Parse response
                    let offset = 1; // Skip length
                    const packetId = buffer[offset++];
                    
                    if (packetId === 0x00) {
                        const jsonLength = buffer[offset++];
                        if (buffer.length >= offset + jsonLength) {
                            const jsonData = buffer.slice(offset, offset + jsonLength).toString('utf8');
                            const serverInfo = JSON.parse(jsonData);
                            
                            client.destroy();
                            resolve(serverInfo.version.name || 'unknown');
                        }
                    }
                }
            } catch (error) {
                client.destroy();
                reject(error);
            }
        });

        client.on('error', (error) => {
            reject(error);
        });

        client.setTimeout(5000, () => {
            client.destroy();
            reject(new Error('Timeout'));
        });
    });
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Send current bots list
    socket.emit('botsUpdate', Array.from(bots.values()).map(botData => ({
        id: botData.id,
        name: botData.config.username,
        host: botData.config.host,
        port: botData.config.port,
        version: botData.config.version,
        detectedVersion: botData.detectedVersion,
        status: botData.status,
        antiAfk: botData.config.antiAfk,
        reconnectInterval: botData.config.reconnectInterval
    })));

    // Handle new bot creation
    socket.on('createBot', (config) => {
        const botId = uuidv4();
        const botData = {
            id: botId,
            config: config,
            status: 'disconnected',
            detectedVersion: null,
            bot: null,
            reconnectAttempts: 0,
            shouldReconnect: false,
            reconnectTimeout: null
        };
        
        bots.set(botId, botData);
        botLogs.set(botId, []); // Initialize logs for this bot
        addLogEntry(botId, 'info', `Bot ${config.username} został utworzony`);
        
        io.emit('botsUpdate', Array.from(bots.values()).map(bd => ({
            id: bd.id,
            name: bd.config.username,
            host: bd.config.host,
            port: bd.config.port,
            version: bd.config.version,
            detectedVersion: bd.detectedVersion,
            status: bd.status,
            antiAfk: bd.config.antiAfk,
            reconnectInterval: bd.config.reconnectInterval
        })));
    });

    // Handle bot actions with password verification
    socket.on('botAction', (data) => {
        const { action, botId, password } = data;
        const botData = bots.get(botId);
        
        if (!botData) {
            socket.emit('actionResult', { success: false, message: 'Bot nie istnieje' });
            return;
        }

        // Verify password
        if (botData.config.password !== password) {
            socket.emit('actionResult', { success: false, message: 'Nieprawidłowe hasło' });
            return;
        }

        // Execute action
        switch (action) {
            case 'start':
                startBot(botId);
                socket.emit('actionResult', { success: true });
                break;
            case 'stop':
                stopBot(botId);
                socket.emit('actionResult', { success: true });
                break;
            case 'delete':
                stopBot(botId);
                bots.delete(botId);
                botLogs.delete(botId);
                io.emit('botsUpdate', Array.from(bots.values()).map(bd => ({
                    id: bd.id,
                    name: bd.config.username,
                    host: bd.config.host,
                    port: bd.config.port,
                    version: bd.config.version,
                    detectedVersion: bd.detectedVersion,
                    status: bd.status,
                    antiAfk: bd.config.antiAfk,
                    reconnectInterval: bd.config.reconnectInterval
                })));
                socket.emit('actionResult', { success: true });
                break;
            case 'logs':
                const logs = botLogs.get(botId) || [];
                socket.emit('logsAccess', { 
                    success: true, 
                    logs: logs, 
                    botName: botData.config.username 
                });
                break;
            default:
                socket.emit('actionResult', { success: false, message: 'Nieznana akcja' });
        }
    });

    // Handle sending messages/commands through bot
    socket.on('sendBotMessage', (data) => {
        const { botId, message } = data;
        const botData = bots.get(botId);
        
        if (!botData) {
            socket.emit('chatMessageSent', { 
                botId, 
                success: false, 
                error: 'Bot nie istnieje' 
            });
            return;
        }

        if (!botData.bot || botData.status !== 'connected') {
            socket.emit('chatMessageSent', { 
                botId, 
                success: false, 
                error: 'Bot nie jest połączony' 
            });
            addLogEntry(botId, 'error', `Nie można wysłać wiadomości - bot nie jest połączony`);
            return;
        }

        try {
            if (message.startsWith('/')) {
                // Command
                const command = message.substring(1);
                botData.bot.chat(`/${command}`);
                addLogEntry(botId, 'command', `[${botData.config.username}] Wykonano komendę: /${command}`);
            } else {
                // Regular message
                botData.bot.chat(message);
                addLogEntry(botId, 'chat_out', `[${botData.config.username}] Wysłano: ${message}`);
            }
            
            socket.emit('chatMessageSent', { 
                botId, 
                success: true 
            });
        } catch (error) {
            socket.emit('chatMessageSent', { 
                botId, 
                success: false, 
                error: error.message 
            });
            addLogEntry(botId, 'error', `Błąd wysyłania wiadomości: ${error.message}`);
        }
    });

    // Clear logs
    socket.on('clearLogs', (botId) => {
        if (botLogs.has(botId)) {
            botLogs.set(botId, []);
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

async function startBot(botId) {
    const botData = bots.get(botId);
    if (!botData || botData.status === 'connected') return;

    botData.status = 'connecting';
    botData.shouldReconnect = true;
    updateBotStatus();
    addLogEntry(botId, 'info', `Rozpoczynam uruchamianie bota ${botData.config.username}`);

    try {
        let botVersion = botData.config.version;
        
        // Jeśli wybrano "auto", wykryj wersję serwera
        if (botVersion === 'auto') {
            botData.status = 'detecting_version';
            updateBotStatus();
            addLogEntry(botId, 'info', `Wykrywanie wersji serwera ${botData.config.host}:${botData.config.port}...`);
            
            try {
                // Pierwsza próba - użyj ping protokołu
                botVersion = await pingServer(botData.config.host, botData.config.port);
                botData.detectedVersion = botVersion;
                addLogEntry(botId, 'success', `Wykryto wersję przez ping: ${botVersion}`);
            } catch (pingError) {
                addLogEntry(botId, 'warning', `Ping nie powiódł się: ${pingError.message}`);
                
                try {
                    // Druga próba - użyj mineflayer detection
                    botVersion = await detectServerVersion(botData.config.host, botData.config.port);
                    botData.detectedVersion = botVersion;
                    addLogEntry(botId, 'success', `Wykryto wersję przez mineflayer: ${botVersion}`);
                } catch (detectionError) {
                    addLogEntry(botId, 'warning', `Automatyczne wykrywanie nie powiodło się: ${detectionError.message}`);
                    // Użyj domyślnej wersji
                    botVersion = '1.20.1';
                    botData.detectedVersion = botVersion + ' (domyślna)';
                    addLogEntry(botId, 'info', `Używam domyślnej wersji: ${botVersion}`);
                }
            }
            
            botData.status = 'connecting';
            updateBotStatus();
        }

        const botOptions = {
            host: botData.config.host,
            port: botData.config.port,
            username: botData.config.username,
            version: botVersion === 'auto' ? false : botVersion,
            auth: 'offline',
            skipValidation: true,
            hideErrors: false
        };

        addLogEntry(botId, 'info', `Tworzenie bota z opcjami: ${JSON.stringify({...botOptions, detectedVersion: botData.detectedVersion})}`);
        
        const bot = mineflayer.createBot(botOptions);
        botData.bot = bot;

        bot.once('spawn', () => {
            const actualVersion = bot.version || botVersion;
            addLogEntry(botId, 'success', `Bot ${botData.config.username} pomyślnie wszedł na serwer ${botData.config.host}:${botData.config.port}`);
            addLogEntry(botId, 'info', `Wersja: ${actualVersion}${botData.detectedVersion ? ` (wykryta: ${botData.detectedVersion})` : ''}`);
            
            botData.status = 'connected';
            botData.reconnectAttempts = 0;
            botData.actualVersion = actualVersion;
            updateBotStatus();
            
            addLogEntry(botId, 'info', `Pozycja: x=${bot.entity.position.x.toFixed(2)}, y=${bot.entity.position.y.toFixed(2)}, z=${bot.entity.position.z.toFixed(2)}`);
            
            // Setup anti-AFK po pomyślnym spawnie z opóźnieniem
            setTimeout(() => {
                setupAntiAfk(botId);
            }, 2000);
        });

        bot.once('login', () => {
            addLogEntry(botId, 'info', `Bot ${botData.config.username} zalogowany do ${botData.config.host}:${botData.config.port}`);
        });

        bot.on('error', (err) => {
            addLogEntry(botId, 'error', `Bot ${botData.config.username} błąd: ${err.message}`);
            
            if (err.message.includes('getaddrinfo ENOTFOUND')) {
                addLogEntry(botId, 'error', `Nie można rozwiązać adresu: ${botData.config.host}`);
            } else if (err.message.includes('ECONNREFUSED')) {
                addLogEntry(botId, 'error', `Połączenie odrzucone na porcie ${botData.config.port}`);
            } else if (err.message.includes('Invalid username')) {
                addLogEntry(botId, 'error', `Nieprawidłowa nazwa użytkownika: ${botData.config.username}`);
            } else if (err.message.includes('Unsupported protocol version')) {
                addLogEntry(botId, 'error', `Nieobsługiwana wersja protokołu. Spróbuj innej wersji.`);
                
                // Jeśli była próba auto-detection, spróbuj z inną wersją
                if (botData.config.version === 'auto' && botData.reconnectAttempts < 3) {
                    const fallbackVersions = ['1.19.4', '1.18.2', '1.16.5'];
                    const fallbackVersion = fallbackVersions[botData.reconnectAttempts];
                    if (fallbackVersion) {
                        addLogEntry(botId, 'info', `Próbuję z wersją fallback: ${fallbackVersion}`);
                        botData.detectedVersion = fallbackVersion + ' (fallback)';
                    }
                }
            }
            
            botData.status = 'error';
            updateBotStatus();
            
            // Clear existing timeout
            if (botData.reconnectTimeout) {
                clearTimeout(botData.reconnectTimeout);
            }
            
            // Automatyczne ponowne połączenie z konfiguralnym opóźnieniem
            if (botData.shouldReconnect && botData.reconnectAttempts < 10) {
                const delaySeconds = botData.config.reconnectInterval || 5;
                addLogEntry(botId, 'info', `Ponowne połączenie za ${delaySeconds}s (próba ${botData.reconnectAttempts + 1}/10)`);
                
                botData.reconnectTimeout = setTimeout(() => {
                    if (botData.shouldReconnect) {
                        botData.reconnectAttempts++;
                        startBot(botId);
                    }
                }, delaySeconds * 1000);
            }
        });

        bot.on('end', () => {
            addLogEntry(botId, 'info', `Bot ${botData.config.username} rozłączony`);
            botData.status = 'disconnected';
            updateBotStatus();
            
            // Clear existing timeout
            if (botData.reconnectTimeout) {
                clearTimeout(botData.reconnectTimeout);
            }
            
            if (botData.shouldReconnect && botData.reconnectAttempts < 10) {
                const delaySeconds = botData.config.reconnectInterval || 5;
                addLogEntry(botId, 'info', `Ponowne połączenie za ${delaySeconds}s`);
                botData.reconnectTimeout = setTimeout(() => {
                    if (botData.shouldReconnect) {
                        botData.reconnectAttempts++;
                        startBot(botId);
                    }
                }, delaySeconds * 1000);
            }
        });

        bot.on('kicked', (reason, loggedIn) => {
            addLogEntry(botId, 'warning', `Bot ${botData.config.username} został wyrzucony: ${reason} (zalogowany: ${loggedIn})`);
            botData.status = 'kicked';
            updateBotStatus();
        });

        bot.on('connect', () => {
            addLogEntry(botId, 'info', `Bot ${botData.config.username} nawiązał połączenie TCP`);
        });

        bot.on('disconnect', (packet) => {
            addLogEntry(botId, 'error', `Bot ${botData.config.username} został rozłączony: ${packet.reason}`);
        });

        // Enhanced chat logging
        bot.on('chat', (username, message) => {
            if (username === bot.username) return;
            addLogEntry(botId, 'chat', `[CHAT] ${username}: ${message}`);
        });

        // Log bot's own messages (when sent via chat input)
        bot.on('message', (jsonMsg) => {
            const messageText = jsonMsg.toString();
            // Filter out some spam messages but keep important ones
            if (!messageText.includes('§') && 
                !messageText.includes('[Server]') && 
                !messageText.startsWith('Teleported') &&
                messageText.trim().length > 0) {
                addLogEntry(botId, 'server', `[SERVER] ${messageText}`);
            }
        });

        // Obsługa respawn po śmierci
        bot.on('death', () => {
            addLogEntry(botId, 'warning', `Bot ${botData.config.username} umarł - respawn za 2s`);
            setTimeout(() => {
                if (bot && !bot.ended) {
                    bot.respawn();
                    // Ponownie włącz anti-AFK po respawn
                    setTimeout(() => {
                        setupAntiAfk(botId);
                    }, 2000);
                }
            }, 2000);
        });

        bot.on('respawn', () => {
            addLogEntry(botId, 'info', `Bot ${botData.config.username} respawnował`);
            // Restart anti-AFK po respawn
            setTimeout(() => {
                setupAntiAfk(botId);
            }, 2000);
        });

    } catch (error) {
        addLogEntry(botId, 'error', `Błąd podczas tworzenia bota ${botData.config.username}: ${error.message}`);
        botData.status = 'error';
        updateBotStatus();
    }
}

function stopBot(botId) {
    const botData = bots.get(botId);
    if (!botData) return;

    addLogEntry(botId, 'info', `Zatrzymywanie bota ${botData.config.username}`);
    botData.shouldReconnect = false;
    
    // Clear reconnect timeout
    if (botData.reconnectTimeout) {
        clearTimeout(botData.reconnectTimeout);
        botData.reconnectTimeout = null;
    }
    
    // Clear anti-AFK interval
    if (botIntervals.has(botId)) {
        clearInterval(botIntervals.get(botId));
        botIntervals.delete(botId);
        addLogEntry(botId, 'info', `Anti-AFK zatrzymany dla bota ${botData.config.username}`);
    }

    if (botData.bot) {
        try {
            // Zatrzymaj anti-AFK przed wyłączeniem bota
            if (botData.bot && !botData.bot.ended) {
                botData.bot.setControlState('sneak', false);
                botData.bot.setControlState('jump', false);
            }
            
            botData.bot.quit('Zatrzymany przez użytkownika');
        } catch (error) {
            addLogEntry(botId, 'error', `Błąd podczas zatrzymywania bota: ${error.message}`);
        }
        botData.bot = null;
    }

    botData.status = 'stopped';
    botData.reconnectAttempts = 0;
    updateBotStatus();
    addLogEntry(botId, 'info', `Bot ${botData.config.username} został zatrzymany`);
}

function setupAntiAfk(botId) {
    const botData = bots.get(botId);
    if (!botData || !botData.bot || !botData.config.antiAfk) return;

    const antiAfkConfig = botData.config.antiAfk;
    
    // Sprawdź czy anti-AFK jest włączony
    if (!antiAfkConfig.crouch && !antiAfkConfig.jump) {
        addLogEntry(botId, 'info', `Anti-AFK wyłączony dla bota ${botData.config.username}`);
        return;
    }

    // Clear existing interval
    if (botIntervals.has(botId)) {
        clearInterval(botIntervals.get(botId));
        botIntervals.delete(botId);
    }

    // Wyświetl informacje o włączonych funkcjach
    const features = [];
    if (antiAfkConfig.crouch) features.push('Kucanie');
    if (antiAfkConfig.jump) features.push('Skakanie');
    addLogEntry(botId, 'info', `Anti-AFK dla bota ${botData.config.username} - włączono: ${features.join(' + ')}`);

    const bot = botData.bot;
    
    // Ustaw ciągłe akcje
    try {
        if (antiAfkConfig.crouch) {
            bot.setControlState('sneak', true);
        }
        
        if (antiAfkConfig.jump) {
            bot.setControlState('jump', true);
        }
    } catch (error) {
        addLogEntry(botId, 'error', `Błąd podczas włączania Anti-AFK dla bota ${botData.config.username}: ${error.message}`);
    }
    
    // Sprawdzaj co jakiś czas czy bot nadal istnieje i jest połączony
    const healthCheckInterval = setInterval(() => {
        // Sprawdź czy bot nadal istnieje i jest połączony
        if (!bot || bot.ended || !botData.shouldReconnect || botData.status !== 'connected') {
            addLogEntry(botId, 'info', `Anti-AFK zatrzymany - bot ${botData.config.username} niedostępny`);
            clearInterval(healthCheckInterval);
            botIntervals.delete(botId);
            return;
        }
        
        // Sprawdź czy anti-AFK działa poprawnie i w razie potrzeby przywróć
        try {
            if (antiAfkConfig.crouch && !bot.controlState.sneak) {
                bot.setControlState('sneak', true);
            }
            
            if (antiAfkConfig.jump && !bot.controlState.jump) {
                bot.setControlState('jump', true);
            }
        } catch (error) {
            addLogEntry(botId, 'error', `Błąd podczas przywracania Anti-AFK dla bota ${botData.config.username}: ${error.message}`);
        }
    }, 5000); // Sprawdzaj co 5 sekund

    botIntervals.set(botId, healthCheckInterval);
}

function updateBotStatus() {
    io.emit('botsUpdate', Array.from(bots.values()).map(bd => ({
        id: bd.id,
        name: bd.config.username,
        host: bd.config.host,
        port: bd.config.port,
        version: bd.config.version,
        detectedVersion: bd.detectedVersion,
        actualVersion: bd.actualVersion,
        status: bd.status,
        antiAfk: bd.config.antiAfk,
        reconnectInterval: bd.config.reconnectInterval
    })));
}

const PORT = process.env.PORT || 80;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 zawixHolder server uruchomiony na porcie ${PORT}`);
    console.log(`🌐 Adres: http://localhost:${PORT}`);
    console.log('🤖 Gotowy do zarządzania botami Minecraft z automatycznym wykrywaniem wersji i chat funkcjami!');
});