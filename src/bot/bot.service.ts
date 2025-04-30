import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import * as qrcode from 'qrcode-terminal';
import { promisify } from 'util';

const rm = promisify(fs.rm);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Define state per end-user (chatId) ---
type UserChatState = {
  lastMessageBody: string | null; // Last message BOT sent to this user
  messageCount: number;          // Message count for THIS user's flow
};

// --- ClientState holds maps for user-specific states ---
type ClientState = {
  userStates: Map<string, UserChatState>; // Map<chatId, UserChatState>
  endingFlags: Map<string, boolean>;    // Map<chatId, isEnding>
};

@Injectable()
export class BotService implements OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private readonly prisma = new PrismaClient();
  private readonly clients = new Map<string, Client>();
  // --- Use the updated ClientState type ---
  private readonly clientStates = new Map<string, ClientState>();

  constructor(private eventEmitter: EventEmitter2) {}

  async initializeClient(enterpriseId: string): Promise<Client | null> {
    if (this.clients.has(enterpriseId)) {
      this.logger.log(`Client for enterprise ${enterpriseId} already exists.`);
      return this.clients.get(enterpriseId) ?? null;
    }

    this.logger.log(`Initializing new client for enterprise: ${enterpriseId}`);
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: enterpriseId,
        dataPath: path.join(__dirname, '..', '..', '.wwebjs_auth'),
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
        ],
      },
    });

    this.clients.set(enterpriseId, client);

    // --- Initialize ClientState with empty maps for user-specific states ---
    const state: ClientState = {
      userStates: new Map<string, UserChatState>(),
      endingFlags: new Map<string, boolean>(),
    };
    this.clientStates.set(enterpriseId, state);

    client.on('qr', (qr) => {
      this.logger.log(`[${enterpriseId}] QR Code Received. Scan below:`);
      qrcode.generate(qr, { small: true });
      this.eventEmitter.emit('qrcode.created', { enterpriseId, qr });
    });

    client.on('ready', () => {
      this.logger.log(`[${enterpriseId}] Client is ready!`);
      const clientState = this.clientStates.get(enterpriseId); // Use clientState name
      if (clientState) {
        // --- Clear ending flags for all users when bot reconnects ---
        clientState.endingFlags.clear();
        this.logger.log(`[${enterpriseId}] Ending flags cleared for all users.`);
        // Decide if you want to clear userStates map too:
        // clientState.userStates.clear();
      }
      // --- Emit the ready event for the controller ---
      this.eventEmitter.emit('client.ready', { enterpriseId });
    });

    client.on('message', async (msg) => {
      await this.handleMessage(enterpriseId, msg);
    });

    client.on('auth_failure', (msg) => {
      this.logger.error(`[${enterpriseId}] Authentication Failure: ${msg}`);
      // Emit disconnect event before cleanup
      this.eventEmitter.emit('client.disconnected', { enterpriseId });
      this.disconnectClient(enterpriseId);
    });

    client.on('disconnected', (reason) => {
      this.logger.warn(`[${enterpriseId}] Client was logged out: ${reason}`);
       // Emit disconnect event before cleanup
      this.eventEmitter.emit('client.disconnected', { enterpriseId });
      this.disconnectClient(enterpriseId);
    });

    try {
      await client.initialize();
      this.logger.log(`[${enterpriseId}] Client initialization process started.`);
      return client;
    } catch (error) {
      this.logger.error(`[${enterpriseId}] Failed to initialize client: ${error.message || error}`);
      this.clients.delete(enterpriseId);
      this.clientStates.delete(enterpriseId);
      await this.deleteSessionData(enterpriseId);
      // Emit disconnect event on init failure
      this.eventEmitter.emit('client.disconnected', { enterpriseId });
      return null;
    }
  }

  // --- Updated handleMessage with per-user state logic ---
  private async handleMessage(enterpriseId: string, msg: Message) {
    if (msg.fromMe || msg.from === 'status@broadcast') return;

    this.logger.verbose(`[${enterpriseId}] Message from ${msg.from}: ${msg.body}`);

    const clientState = this.clientStates.get(enterpriseId); // State for the whole bot instance
    const currentClient = this.clients.get(enterpriseId);

    if (!clientState || !currentClient) {
      this.logger.error(`[${enterpriseId}] ClientState or Client not found for message handling from ${msg.from}.`);
      return;
    }

    const chatId = msg.from;

    // --- Get or initialize state for THIS specific user (chatId) ---
    let userState = clientState.userStates.get(chatId);
    if (!userState) {
      userState = { lastMessageBody: null, messageCount: 0 };
      // No need to set it back immediately, will be set in finally block
      this.logger.debug(`[${enterpriseId}] Initialized state for new user ${chatId}`);
    }

    // Get the ending flag for THIS user, default to false
    const isEnding = clientState.endingFlags.get(chatId) ?? false;
    // ----------------------------------------------------------------

    this.logger.debug(`[${enterpriseId}] Handling message for ${chatId}. User state: count=${userState.messageCount}, ending=${isEnding}`);

    try {
      // --- Use user-specific state for logic ---
      if (userState.messageCount === 0 || isEnding) {
        const prompt = await this.prisma.prompt.findFirst({
          where: { enterpriseId: enterpriseId, available: true },
        });
        if (!prompt) {
          this.logger.warn(`[${enterpriseId}] No prompt found.`);
          return;
        }
        // Update THIS user's state
        userState.messageCount = 1; // Start count at 1 after sending prompt
        userState.lastMessageBody = prompt.body;
        clientState.endingFlags.set(chatId, false); // Reset ending flag for THIS user

        this.logger.debug(`[${enterpriseId}] Sending prompt to ${chatId}. User count set to 1.`);
        await msg.reply(prompt.body); // Use reply
        return;
      }
      // -----------------------------------------

      // Find reply based on trigger
      const reply = await this.prisma.messages.findFirst({
        where: {
          enterpriseId: enterpriseId,
          available: true,
          trigger: { equals: msg.body, mode: 'insensitive' },
        },
      });

      if (!reply) {
        this.logger.warn(`[${enterpriseId}] No reply for trigger: "${msg.body}" from ${chatId}`);
        // Use THIS user's last message body
        const lastSentMessage = userState.lastMessageBody;
        if (lastSentMessage) {
          this.logger.debug(`[${enterpriseId}] Repeating last message to ${chatId}.`);
           await msg.reply(lastSentMessage); // Use reply for repeating
        } else {
          this.logger.verbose(`[${enterpriseId}] No last message found for ${chatId}, not sending default reply.`);
        }
      } else {
        // --- Update THIS user's state ---
        userState.messageCount++; // Increment THIS user's count
        userState.lastMessageBody = reply.body;
        clientState.endingFlags.set(chatId, reply.ending === true); // Set ending flag for THIS user
        // --------------------------------

        if (reply.ending === true) { // Check reply.ending directly for logging clarity
          this.logger.log(`[${enterpriseId}] Conversation ending flag set for user ${chatId}.`);
        }
        this.logger.debug(`[${enterpriseId}] Sending reply to ${chatId}. User count: ${userState.messageCount}`);
         await msg.reply(reply.body); // Use reply
      }
    } catch (error) {
      this.logger.error(`[${enterpriseId}] Error handling message from ${chatId}: ${error.message || error}`);
       // Keep existing error handling logic
       if (error.message?.includes('Could not get the quoted message')) {
          this.logger.warn(`[${enterpriseId}] Failed to reply (quoting failed) to ${chatId}. Attempting to send as a new message.`);
          try {
              // Get the last message intended for this user from their state
              const messageToSend = userState.lastMessageBody;
              if (messageToSend) {
                  await currentClient.sendMessage(chatId, messageToSend);
              }
          } catch (sendError) {
               this.logger.error(`[${enterpriseId}] Fallback sendMessage also failed for ${chatId}: ${sendError.message || sendError}`);
          }
      }
      else if (error.message?.includes('ERR_NETWORK_CHANGED') || error.message?.includes('Connection closed')) {
        this.logger.warn(`[${enterpriseId}] Network or connection error detected. Client might disconnect.`);
      } else if (error.message?.includes('Target closed')) {
        this.logger.warn(`[${enterpriseId}] Puppeteer target closed. Client might disconnect.`);
      }
    } finally {
        // --- IMPORTANT: Save the updated userState back into the map ---
        if (userState && clientState) { // Add checks to ensure objects exist
             clientState.userStates.set(chatId, userState);
        }
        // -------------------------------------------------------------
    }
  }


  async disconnectClient(enterpriseId: string) {
    const client = this.clients.get(enterpriseId);
    if (!client) {
      this.logger.warn(`[${enterpriseId}] Client not found for disconnection.`);
      return;
    }

    this.logger.log(`[${enterpriseId}] Attempting to disconnect client...`);
    try {
      if (typeof client.destroy === 'function') {
        await client.destroy();
        this.logger.log(`[${enterpriseId}] Client destroyed.`);
      } else {
        await client.logout();
        this.logger.log(`[${enterpriseId}] Client logged out.`);
      }
    } catch (error) {
      this.logger.error(`[${enterpriseId}] Error during client destroy/logout: ${error.message || error}`);
    } finally {
      // --- Emit disconnect event AFTER attempting disconnect but before deleting ---
      // Note: This might have already been emitted by the 'disconnected' handler,
      // but emitting here ensures it happens on manual disconnect too.
      // Consider adding a flag to avoid double emits if necessary.
      this.eventEmitter.emit('client.disconnected', { enterpriseId });

      this.clients.delete(enterpriseId);
      this.clientStates.delete(enterpriseId);
      this.logger.log(`[${enterpriseId}] Client instance removed from service map.`);
      await this.deleteSessionData(enterpriseId);
    }
  }

  private async deleteSessionData(enterpriseId: string) {
    const sessionFolderPath = path.join(__dirname, '..', '..', '.wwebjs_auth', `session-${enterpriseId}`);
    const legacySessionFolderPath = path.join(__dirname, '..', '..', `.wwebjs_auth-${enterpriseId}`);

    const deleteFolder = async (folderPath: string) => {
      try {
        if (fs.existsSync(folderPath)) {
          this.logger.log(`[${enterpriseId}] Attempting to delete session folder: ${folderPath}`);
          await rm(folderPath, { recursive: true, force: true });
          this.logger.log(`[${enterpriseId}] Successfully deleted session folder: ${folderPath}`);
        }
      } catch (error) {
        if (error.code === 'EBUSY') {
          this.logger.warn(`[${enterpriseId}] Resource busy, retrying deletion: ${folderPath}`);
          await sleep(1000);
          await deleteFolder(folderPath);
        } else {
          this.logger.error(`[${enterpriseId}] Error deleting session folder ${folderPath}: ${error.message || error}`);
        }
      }
    };

    await deleteFolder(sessionFolderPath);
    await deleteFolder(legacySessionFolderPath);
  }

  async onModuleDestroy() {
    this.logger.log('Shutting down BotService. Disconnecting all clients...');
    const disconnectionPromises = Array.from(this.clients.keys()).map((enterpriseId) =>
      this.disconnectClient(enterpriseId),
    );
    await Promise.allSettled(disconnectionPromises);
    this.logger.log('All clients disconnected.');
    await this.prisma.$disconnect();
  }

  getClient(enterpriseId: string): Client | undefined {
    return this.clients.get(enterpriseId);
  }
}
